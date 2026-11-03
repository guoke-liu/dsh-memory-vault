// ============================================================================
// recall-import.js —— 把外部日记/笔记导入成记忆检索能读的格式
//
// 【这个模块负责什么】
//   把「别的格式的日记」转成 entries/<来源>/YYYY-MM-DD.json 的形状，
//   让 memory_recall 的四因子检索能直接用上。支持：
//     · 自动识别几种常见形状（数组、{entries:[]}、按日期分组的对象、JSONL）
//     · 字段映射（你的字段叫什么，映射成 text/title/tags/date）
//     · Markdown / 纯文本日记（按日期标题切分）
//   导入是**幂等**的：同样的条目导两次不会重复。
//
// 【为什么这样设计】
//   · 为什么不做「万能格式侦探」：世上的日记格式无穷多，猜格式的代码
//     会越来越复杂且越猜越不准。正确做法是「认几种常见的，其余给你
//     一个显式的映射表」。显式映射是可控的；猜是碰运气。
//
//   · 为什么字段映射而不是要求改源文件：用户不该为了用检索去改自己
//     攒了几年的日记。让他写 4 行映射（{"text":"content","date":"day"}）
//     比自己动手转格式便宜得多。
//
//   · 为什么导入是幂等的：用户很可能导完发现映射写错了，改一下再导一遍。
//     如果第二遍把所有东西又塞一遍，检索结果就废了。所以每条都算一个
//     稳定指纹（来源+日期+正文），已存在就跳过。
//
//   · 为什么不直接写进日记插件的库：那个库属于另一个插件，写进去等于
//     冒充它。这里只写**本插件自己的**导入目录（默认 ~/.dsh/memory-vault/imported），
//     检索时把「导入目录」和「日记库目录」一起读。
//
// 【对外导出】
//   · 识别输入形状(数据) —— 返回 'array' | 'entries' | 'byDate' | 'jsonl' | 'markdown' | ''
//   · 解析成条目(数据, 选项) —— 转成统一条目数组
//   · 读文本日记(文本, 选项) —— Markdown/纯文本按日期切分
//   · 导入(选项) —— 完整流水：读文件 → 解析 → 去重 → 落盘
//   · 条目指纹(条目) —— 幂等去重用的稳定键
// ============================================================================

import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** 导入数据的版本。改了存储结构就加一。 */
const 版本 = 1

/**
 * 内置的字段映射预设。
 *
 * 【这些不是猜的，是照着实现在用的转换器抄的字段名】
 * 自己硬写字段名最容易犯的错是「看起来对、实际对不上」——
 * 例如 DayOne 的日期字段叫 creationDate，不是 createdAt；
 * 漏了它，日期会全部退回「今天」，时效分失效且不报错。
 *
 * 来源（都是 MIT / 公开许可，只取字段名这一层事实，不含代码）：
 *   · Day One 导出：JeffersonQin/dayone2markdown/converter.py
 *                   danseethaler/dayone-to-md/src/index.js
 *     字段：text / creationDate / uuid / photos[].identifier
 *   · Notion 导出：connertennery/Notion-to-Obsidian-Converter/main.js
 *     文件名即标题，正文在 .md 里
 *   · 通用 JSON：Obsidian / Logseq / 自建导出常见写法
 */
export const 内置映射 = Object.freeze({
  'dayone': {
    说明: 'Day One 导出（Day One/*.json）',
    text: 'text',
    title: '',           // DayOne 没有独立标题，正文首行即标题
    date: 'creationDate',
    id: 'uuid',
    tags: 'tags',
  },
  'notion': {
    说明: 'Notion 导出（解压后的 .md；标题用文件名）',
    text: 'text',
    title: 'title',
    date: 'date',
    id: '',
    tags: 'tags',
  },
  'generic': {
    说明: '通用 JSON：text/content/body + date/createdAt + tags',
    text: 'content',
    title: 'title',
    date: 'date',
    id: 'id',
    tags: 'tags',
  },
  'obsidian': {
    说明: 'Obsidian 日记（Markdown，按日期标题切分）',
    text: '',
    title: '',
    date: '',
    id: '',
    tags: '',
  },
})

/**
 * 根据预设名取映射。没给就用空映射（走通用的多字段自动探测）。
 *
 * @param {string} 名
 * @returns {object}
 */
export function 取映射 (名) {
  const k = String(名 || '').trim().toLowerCase()
  if (!k || k === 'auto') return {}
  const p = 内置映射[k]
  if (!p) return {}
  // 去掉说明字段，只留映射键
  const { 说明, ...映射 } = p
  // 空字符串表示「这个格式没有这个字段」，转条目 会自动走候选探测
  const out = {}
  for (const [k2, v] of Object.entries(映射)) if (v) out[k2] = v
  return out
}

/**
 * 条目指纹：幂等去重用的稳定键。
 *
 * 用 来源+日期+正文 而不是整个条目的 JSON：正文一样、标题改了不该算新条目，
 * 否则用户改一次标题再导一次，库里就多一条重复的。
 *
 * @param {{来源?:string, 日期?:string, text?:string}} 条目
 * @returns {string}
 */
export function 条目指纹 (条目) {
  const 原文 = [条目?.来源 || '', 条目?.日期 || '', String(条目?.text || '').trim()].join('\u0001')
  return createHash('sha1').update(原文).digest('hex').slice(0, 16)
}

/**
 * 识别数据形状。
 *
 * @param {any} 数据
 * @returns {'array'|'entries'|'byDate'|'jsonl'|'markdown'|''}
 */
export function 识别输入形状 (数据) {
  if (Array.isArray(数据)) return 'array'
  if (typeof 数据 === 'string') {
    const t = 数据.trim()
    if (!t) return ''
    // 以 { 或 [ 开头当 JSON，否则当文本日记
    if (t.startsWith('{') || t.startsWith('[')) {
      // JSONL：每行一个 JSON 对象
      const 行们 = t.split('\n').map((x) => x.trim()).filter(Boolean)
      if (行们.length > 1 && 行们.every((l) => l.startsWith('{') && l.endsWith('}'))) return 'jsonl'
      return ''
    }
    return 'markdown'
  }
  if (数据 && typeof 数据 === 'object') {
    // { entries: [...] } / { items: [...] } / { data: [...] }
    for (const k of ['entries', 'items', 'data', 'records', 'list']) {
      if (Array.isArray(数据[k])) return 'entries'
    }
    // { "2026-11-03": [...], "2026-11-02": [...] }
    const 键们 = Object.keys(数据)
    if (键们.length > 0 && 键们.every((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))) return 'byDate'
  }
  return ''
}

/** 从多个候选字段名里取第一个有值的（映射优先）。 */
function 取字段 (obj, 映射, 候选们) {
  const 名们 = 映射 ? [映射, ...候选们] : 候选们
  for (const 名 of 名们) {
    if (名 == null) continue
    const v = obj[名]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/** 把任意东西洗成字符串（数组 join、对象 JSON）。 */
function 洗字符串 (v) {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map(洗字符串).filter(Boolean).join(' ')
  if (typeof v === 'object') {
    try { return JSON.stringify(v) } catch { return '' }
  }
  return String(v)
}

/** 把日期洗成 YYYY-MM-DD；认不出返回今天。 */
function 洗日期 (v) {
  const s = 洗字符串(v).trim()
  if (!s) return ''
  // 2026-11-03 / 2026/11/03 / 2026-11-03T10:00:00Z / 20261103
  const m = s.match(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  const t = Date.parse(s)
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10)
  return ''
}

/**
 * 把一条原始记录转成标准条目。
 *
 * 字段映射的语义：映射里给了就用映射的字段名；没给就在常见名字里按顺序找。
 * 常见名字覆盖了 Obsidian 导出、Notion 导出、Mem0 导出、自建 JSON 的写法。
 *
 * @param {object} 原
 * @param {{text?:string, title?:string, tags?:string, date?:string, id?:string}} [映射]
 * @param {string} [默认来源]
 * @returns {object|null}
 */
export function 转条目 (原, 映射 = {}, 默认来源 = 'imported') {
  if (!原 || typeof 原 !== 'object' || Array.isArray(原)) return null
  const 正文 = 洗字符串(取字段(原, 映射.text, ['text', 'content', 'body', 'note', '正文', '内容', 'value', 'memo']))
  if (!正文.trim()) return null
  const 标题 = 洗字符串(取字段(原, 映射.title, ['title', 'name', 'heading', '标题', 'subject']))
  const 标签原 = 取字段(原, 映射.tags, ['tags', 'tag', 'labels', '标签', 'categories'])
  const 标签 = Array.isArray(标签原)
    ? 标签原.map(洗字符串).filter(Boolean)
    : 洗字符串(标签原).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean)
  // 日期候选按「真实格式的官方字段名」排，不猜：
  //   creationDate —— Day One 的官方字段（见 dayone2markdown/converter.py 与
  //                   dayone-to-md/src/index.js，两处都是这个拼写）
  //   createdAt/created_at —— 多数 JSON API 导出
  //   date/day/dayKey —— 通用日记工具
  // 早先漏了 creationDate，DayOne 导入时日期全变成「今天」，
  // 四因子里的时效分直接失效 —— 而且不报错，只有对比原文才发现。
  const 日期 = 洗日期(取字段(原, 映射.date, [
    'creationDate', 'creation_date', 'createdAt', 'created_at', 'created',
    'date', 'day', 'dayKey', 'time', 'timestamp', 'datetime', '日期', '时间',
  ]))
  const 来源 = 洗字符串(取字段(原, 映射.source, ['source', 'origin', 'from', '来源'])) || 默认来源
  return {
    来源,
    日期: 日期 || new Date().toISOString().slice(0, 10),
    id: 洗字符串(取字段(原, 映射.id, ['id', 'uuid', 'key', '编号'])),
    title: 标题,
    text: 正文,
    tags: 标签,
    at: 洗字符串(取字段(原, 映射.at, ['at', 'updatedAt', 'updated_at', 'mtime'])),
  }
}

/**
 * 把文本日记（Markdown / 纯文本）按日期标题切分成条目。
 *
 * 支持的标题形式：
 *   `## 2026-11-03`、`# 2026-11-03 星期二`、`2026-11-03`、`[2026-11-03]`
 * 以及带 `---` 分隔的日记。没有日期的段落用文件名里的日期兜底，
 * 再没有就用今天 —— 宁可日期不准，也不要整篇丢掉。
 *
 * @param {string} 文本
 * @param {{默认日期?:string, 默认来源?:string, 最小长度?:number}} [选项]
 * @returns {Array<object>}
 */
export function 读文本日记 (文本, 选项 = {}) {
  const 串 = String(文本 || '')
  const 默认日期 = 洗日期(选项.默认日期) || new Date().toISOString().slice(0, 10)
  const 默认来源 = 选项.默认来源 || 'imported'
  // 最小长度只挡「空段落/纯标点」，不挡短日记。
  // 早先默认 8，「第三天。」这种 4 字的正常短日记会被静默丢掉 ——
  // 用户只会看到"少了几条"，不知道为什么。4 已足够挡掉 `---`、空行、
  // 单个符号这类真正的噪声。
  const 最小 = Number.isFinite(Number(选项.最小长度)) ? Number(选项.最小长度) : 4

  // 找出所有日期标题的位置
  const 标记们 = []
  const 正则 = /^[ \t]*(?:#{1,6}[ \t]*)?\[?(\d{4}[-/]\d{2}[-/]\d{2})\]?[^\n]*$/gm
  let m
  while ((m = 正则.exec(串)) !== null) {
    标记们.push({ 起: m.index, 止: m.index + m[0].length, 日期: 洗日期(m[1]) })
  }

  const 条目 = []
  if (标记们.length === 0) {
    // 没有日期标题：整篇当一条
    const 正文 = 串.trim()
    if (正文.length >= 最小) {
      条目.push({ 来源: 默认来源, 日期: 默认日期, id: '', title: '', text: 正文, tags: [], at: '' })
    }
    return 条目
  }

  for (let i = 0; i < 标记们.length; i++) {
    const 起 = 标记们[i].止
    const 止 = i + 1 < 标记们.length ? 标记们[i + 1].起 : 串.length
    const 正文 = 串.slice(起, 止).trim()
    if (正文.length < 最小) continue
    条目.push({
      来源: 默认来源,
      日期: 标记们[i].日期 || 默认日期,
      id: '',
      title: '',
      text: 正文,
      tags: [],
      at: '',
    })
  }
  return 条目
}

/**
 * 把任意输入解析成标准条目数组。
 *
 * @param {any} 数据 对象 / 数组 / JSON 文本 / Markdown 文本
 * @param {{映射?:object, 默认来源?:string, 默认日期?:string}} [选项]
 * @returns {{形状:string, 条目:object[], 跳过:number}}
 */
export function 解析成条目 (数据, 选项 = {}) {
  const 映射 = 选项.映射 && typeof 选项.映射 === 'object' ? 选项.映射 : {}
  const 默认来源 = 选项.默认来源 || 'imported'
  const 形状 = 识别输入形状(数据)

  if (形状 === 'markdown') {
    return { 形状, 条目: 读文本日记(数据, { 默认来源, 默认日期: 选项.默认日期 }), 跳过: 0 }
  }
  if (形状 === 'jsonl') {
    const 条目 = []
    let 跳过 = 0
    for (const 行 of String(数据).split('\n')) {
      const t = 行.trim()
      if (!t) continue
      let o = null
      try { o = JSON.parse(t) } catch { 跳过 += 1; continue }
      const e = 转条目(o, 映射, 默认来源)
      if (e) 条目.push(e)
      else 跳过 += 1
    }
    return { 形状, 条目, 跳过 }
  }

  let 清单 = []
  if (形状 === 'array') 清单 = 数据
  else if (形状 === 'entries') {
    for (const k of ['entries', 'items', 'data', 'records', 'list']) {
      if (Array.isArray(数据[k])) { 清单 = 数据[k]; break }
    }
  } else if (形状 === 'byDate') {
    for (const [日期, 值] of Object.entries(数据)) {
      const 们 = Array.isArray(值) ? 值 : [值]
      for (const x of 们) {
        if (x && typeof x === 'object' && !Array.isArray(x)) {
          清单.push({ ...x, date: x.date || 日期 })
        } else if (typeof x === 'string') {
          清单.push({ text: x, date: 日期 })
        }
      }
    }
  } else {
    return { 形状: '', 条目: [], 跳过: 0 }
  }

  const 条目 = []
  let 跳过 = 0
  for (const x of 清单) {
    const e = 转条目(x, 映射, 默认来源)
    if (e) 条目.push(e)
    else 跳过 += 1
  }
  return { 形状, 条目, 跳过 }
}

/** 安全合并写入某来源某天的 JSON：按指纹去重。 */
async function 合并写一天 (目录, 来源key, 日期, 新条目们, 已有指纹) {
  const 文件名 = `${日期}.json`
  const 路径 = path.join(目录, 来源key, 文件名)
  let 原 = { entries: [] }
  try {
    原 = JSON.parse(await readFile(路径, 'utf8'))
    if (!原 || !Array.isArray(原.entries)) 原 = { entries: [] }
  } catch { /* 新文件 */ }

  let 新增 = 0
  let 跳过 = 0
  for (const e of 新条目们) {
    const 指纹 = 条目指纹(e)
    if (已有指纹.has(指纹)) { 跳过 += 1; continue }
    原.entries.push({ ...e, 指纹 })
    已有指纹.add(指纹)
    新增 += 1
  }
  if (新增 > 0) {
    await mkdir(path.join(目录, 来源key), { recursive: true })
    // 原子写：先写临时文件再改名
    const 临时 = `${路径}.tmp-${process.pid}`
    await writeFile(临时, JSON.stringify({ version: 版本, date: 日期, 来源: 来源key, entries: 原.entries }, null, 2))
    const { rename } = await import('node:fs/promises')
    await rename(临时, 路径)
  }
  return { 新增, 跳过 }
}

/**
 * 导入完整流水。
 *
 * @param {object} 选项
 * @param {string} 选项.源文件 要导入的文件路径（JSON / JSONL / Markdown / 纯文本）
 * @param {string} 选项.目标目录 导入数据写到哪（通常是 <配置目录>/imported）
 * @param {object} [选项.映射] 字段映射
 * @param {string} [选项.默认来源]
 * @returns {Promise<object>}
 */
export async function 导入 (选项 = {}) {
  const 源文件 = String(选项.源文件 || '').trim()
  const 目标目录 = String(选项.目标目录 || '').trim()
  if (!源文件) return { ok: false, 错误: '缺少源文件路径' }
  if (!目标目录) return { ok: false, 错误: '缺少目标目录' }

  let 文本
  try {
    文本 = await readFile(源文件, 'utf8')
  } catch (e) {
    return { ok: false, 错误: `读不了文件：${e?.message || e}` }
  }

  // 先试 JSON，失败再当纯文本
  let 数据 = 文本
  let 是JSON = false
  try {
    数据 = JSON.parse(文本)
    是JSON = true
  } catch { /* 当文本 */ }

  // 文本日记可以从文件名里拿日期兜底（2026-11-03.md）
  const 文件名日期 = (path.basename(源文件).match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || ''

  const 解析 = 解析成条目(数据, {
    映射: 选项.映射,
    默认来源: 选项.默认来源 || 'imported',
    默认日期: 文件名日期,
  })
  if (!解析.条目.length) {
    return {
      ok: false,
      错误: 是JSON
        ? '没解析出任何条目 —— 可能字段名对不上。请用「字段映射」指定正文对应的字段名（例如 {"text":"content"}）'
        : '这个文件里没找到任何日记内容',
      形状: 解析.形状,
    }
  }

  // ⚠️ 写进 <目标目录>/entries/<来源>/<日期>.json —— entries 这一层不能省。
  // 读取侧（recall-tools.读日记）按「<根>/entries/<来源>/<日期>.json」找文件，
  // 少一层就会出现「导入成功但检索搜不到」，而且两边各自看都正常，
  // 只有端到端跑才发现。实测踩过。
  const 实体目录 = path.join(目标目录, 'entries')

  // 读已有指纹（遍历目标目录）
  const 已有指纹 = new Set()
  try {
    for (const 来源key of await readdir(实体目录)) {
      const 子 = path.join(实体目录, 来源key)
      let st
      try { st = await stat(子) } catch { continue }
      if (!st.isDirectory()) continue
      for (const n of await readdir(子)) {
        if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(n)) continue
        try {
          const v = JSON.parse(await readFile(path.join(子, n), 'utf8'))
          for (const e of Array.isArray(v?.entries) ? v.entries : []) {
            if (e && typeof e === 'object') 已有指纹.add(e.指纹 || 条目指纹(e))
          }
        } catch { /* 坏文件跳过 */ }
      }
    }
  } catch { /* 目标目录还不存在 */ }

  // 按 来源+日期 分组写
  const 分组 = new Map()
  for (const e of 解析.条目) {
    // 目录名：来源里的冒号换成连字符（冒号在部分文件系统上非法）
    const 来源key = String(e.来源 || 'imported').replace(/[:/\\]/g, '-')
    const k = `${来源key}\u0001${e.日期}`
    if (!分组.has(k)) 分组.set(k, { 来源key, 日期: e.日期, 条目们: [] })
    分组.get(k).条目们.push(e)
  }

  let 新增 = 0
  let 跳过 = 解析.跳过
  for (const { 来源key, 日期, 条目们 } of 分组.values()) {
    const r = await 合并写一天(实体目录, 来源key, 日期, 条目们, 已有指纹)
    新增 += r.新增
    跳过 += r.跳过
  }

  return {
    ok: true,
    形状: 解析.形状,
    解析条数: 解析.条目.length,
    新增,
    跳过,
    来源们: [...new Set([...分组.values()].map((x) => x.来源key))],
    目标目录,
  }
}
