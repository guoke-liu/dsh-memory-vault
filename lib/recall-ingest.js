// ============================================================================
// recall-ingest.js —— 把聊天消息分层后并入记忆检索库
//
// 【这个模块负责什么】
//   一条完整流水：
//     扫描聊天 → 规则分层（永远有）→ 可选模型分层 → 写入分层结果文件
//     检索库读这个文件，把聊天当成「低权重条目」一起参与打分。
//
// 【为什么这样设计】
//   · **分层结果单独存一个文件，而不是塞进日记库或聊天目录。**
//     记忆仓库的聊天文件是 OneBot 采集器写的，格式由它定；日记库属于
//     另一个插件。检索库要的是「派生数据」，派生数据就该有自己的位置，
//     坏了删掉重算即可，不动任何原始数据。
//
//   · 增量靠「已处理指纹集合」。24 小时定时跑时，只处理新消息。
//     指纹存在同一个文件里，和结果一起原子写 —— 分成两个文件会在
//     崩溃时出现「结果写了、标记没写」导致重复处理。
//
//   · 模型失败不影响规则结果。规则分层先算好，模型是叠加层；
//     模型整批失败时保留规则值，并如实记录失败批数。
//     绝不能让「模型欠费」变成「功能全废」。
//
//   · 分批 + 批间延时不是可选优化。免费模型普遍有 RPM 限制，
//     一次性甩 8000 条出去必然 429，然后整个功能看起来就"坏"了。
//
// 【对外导出】
//   · 扫描聊天(聊天根, 选项) —— 读全部聊天消息
//   · 跑分层(选项) —— 完整流水：扫描 → 分层 → 落盘
//   · 读分层库(文件) —— 读已落盘的分层结果
//   · 并入索引条目(分层结果) —— 转成 rank.js 能吃的索引条目
// ============================================================================

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { 打分层, 分层, 是机器人播报 } from './recall-screen.js'
// 投喂账本：哪些消息真的喂过模型，只在函数内部用，所以静态导入不需要
import {
  模型分层, 消息指纹, 写打分缓存, 合并分层,
} from './recall-scorer.js'

/**
 * 分层库的默认容量上限（条）。
 *
 * 为什么要有上限：分层库只增不减，聊天每天都在进来。按实测密度
 * （10 天 8428 条 ≈ 每天 840 条）算，一年就是 30 万条。空间倒是其次
 * （30 万条约 40 MB），**性能才是问题** —— 每次检索都要全量建索引，
 * 实测（2026-11-04，1 核云主机）：
 *
 *   2 万条  → 建索引 122 ms | 检索 366 ms
 *   5 万条  → 建索引 230 ms | 检索 709 ms
 *   10 万条 → 建索引 501 ms | 检索 1373 ms
 *   20 万条 → 建索引 827 ms | 检索 2622 ms
 *
 * 模型的工具调用有超时，检索超过 1 秒就已经算慢了。
 * 取 5 万条（检索约 0.7 秒），按当前密度够用一年半。
 */
export const 默认容量上限 = 50000

/**
 * 给条目排「该不该被淘汰」的优先级 —— 排序越靠前越该留下。
 *
 * 淘汰顺序（先淘汰排后面的）：
 *   1. 层级高（核心 > 有用 > 闲聊）—— 核心是约定和决定，闲聊是应答玩笑
 *   2. 新的在前 —— 同样重要时，近期信息更有用
 *   3. 被检索过的在前 —— 最近被翻出来过的，说明对人有意义
 *
 * ⚠️ 为什么「层级」要排在「时间」前面：
 * 时间优先会把一年前的所有核心记忆全清掉，只留下最近的闲聊 ——
 * 正好和记忆检索的目的相反（要的恰恰是久远但重要的约定）。
 *
 * @param {object} e 展开后的扁平条目
 * @returns {number} 降序排列用的分值，越大越该留
 */
function 保留优先级 (e) {
  // 层级：0=闲聊 1=有用 2=核心（数值越大越重要）
  const 层 = Number(e.层级) || 0
  // 被检索过加一档：lastHit 存在说明它真的被人用上过
  const 被用过 = e.lastHit ? 1 : 0
  // 时间用日期数字本身，越新越大
  const 日 = Number(String(e.日期 || '').replace(/-/g, '')) || 0
  return 层 * 1e12 + 被用过 * 1e11 + 日
}

/**
 * 按上限裁剪条目，返回保留的部分与淘汰统计。
 *
 * 为什么不直接切掉最老的：见 保留优先级 的说明 —— 那会把核心记忆清光。
 *
 * @param {Array<object>} 条目们 展开后的扁平条目
 * @param {number} 上限 最多保留多少条；<=0 表示不限制
 * @returns {{保留: Array<object>, 淘汰: number, 上限: number}}
 */
export function 裁剪到上限 (条目们, 上限 = 默认容量上限) {
  const 全 = Array.isArray(条目们) ? 条目们 : []
  const 限 = Number(上限)
  if (!Number.isFinite(限) || 限 <= 0 || 全.length <= 限) {
    return { 保留: 全, 淘汰: 0, 上限: Number.isFinite(限) ? 限 : 0 }
  }
  // 稳定排序：分值相同的保持原有相对顺序（Node 的 sort 是稳定的）
  const 排好 = [...全].sort((a, b) => 保留优先级(b) - 保留优先级(a))
  return { 保留: 排好.slice(0, 限), 淘汰: 全.length - 限, 上限: 限 }
}

/**
 * 把条目按「来源+日期」分组，去掉组内重复字段。
 *
 * 存储形状：
 *   { 来源: 'private', 日期: '2026-11-01', 条目: [{时间, 摘要, 层级, 指纹}, ...] }
 *
 * 为什么值得这么做：实测每条 116 字符里，来源和日期占了约 40 字符
 * （34%），而它们在同一个组里完全重复。分组后同样的信息量能小三分之一。
 *
 * @param {Array<object>} 条目们
 * @returns {Array<{来源:string, 日期:string, 条目:Array<object>}>}
 */
export function 分组精简 (条目们, 上次命中 = new Map()) {
  const 组 = new Map()
  for (const x of Array.isArray(条目们) ? 条目们 : []) {
    const k = `${x.来源}\u0001${x.日期}`
    if (!组.has(k)) 组.set(k, { 来源: x.来源, 日期: x.日期, 条目: [] })
    const 条 = {
      时间: x.时间,
      摘要: 摘取摘要(x.内容),
      层级: x.层级,
      指纹: x.指纹,
    }
    // ⚠️ lastHit 必须跨分层保留。
    // 每次重新分层都把它清空的话，衰减永远从头算 —— 一条被反复检索的
    // 老记录，会因为「昨天又跑了一次分层」而看起来永远新鲜，
    // 12 层降级和归档永远不会发生。这是衰减机制的致命处。
    const 上次 = 上次命中.get(x.指纹)
    if (上次) 条.lastHit = 上次
    组.get(k).条目.push(条)
  }
  // 按日期倒序、来源排序，输出稳定（同样的输入永远同样的文件，便于 diff）
  return [...组.values()].sort((a, b) => {
    if (a.日期 !== b.日期) return a.日期 < b.日期 ? 1 : -1
    return a.来源 < b.来源 ? -1 : a.来源 > b.来源 ? 1 : 0
  })
}

/**
 * 展开分组，还原成扁平条目。
 *
 * 兼容旧格式：老文件把条目平铺在 `条目` 数组里（每条自带来源/日期），
 * 新文件是 `分组`。两种都要能读 —— 升级后不要求用户重跑分层。
 *
 * @param {object} 缓存 分层库内容
 * @returns {Array<object>}
 */
export function 展开条目 (缓存) {
  const 出 = []
  if (Array.isArray(缓存?.分组)) {
    for (const g of 缓存.分组) {
      for (const e of Array.isArray(g.条目) ? g.条目 : []) {
        出.push({ 来源: g.来源, 日期: g.日期, ...e })
      }
    }
    return 出
  }
  // 旧格式
  for (const e of Array.isArray(缓存?.条目) ? 缓存.条目 : []) 出.push(e)
  return 出
}

/**
 * 摘要长度上限。超过就截断并加省略号。
 *
 * 为什么是 120 而不是更短：摘要要够检索用（词面/向量都在这上面算）。
 * 实测 P99 是 107 字，120 能覆盖 99% 的完整保留、只截掉长尾，
 * 而长尾（最长 4241 字）恰恰是不该进索引的部分。
 */
export const 摘要上限 = 120

/**
 * 从完整内容里摘一段「够检索、不必是全文」的摘要。
 *
 * 做法是**取头尾**而不是只取开头：中文消息经常把结论放最后
 * （「……所以这事先这样定了」），只留开头会把关键信息截掉。
 * 头 3/4 + 尾 1/4 是经验配比。
 *
 * @param {string} 内容
 * @returns {string}
 */
export function 摘取摘要 (内容) {
  const t = String(内容 || '').trim()
  if (t.length <= 摘要上限) return t
  const 头长 = Math.floor(摘要上限 * 0.75)
  const 尾长 = 摘要上限 - 头长 - 1 // 1 位给省略号
  return `${t.slice(0, 头长)}…${t.slice(t.length - 尾长)}`
}

/**
 * 按坐标回查聊天原文。
 *
 * 分层库里只有摘要，用户要看全文时走这里：定位到
 * chat/<private|group/<群号>>/<日期>.txt，再按时间戳找那一行。
 *
 * 为什么按时间而不是存行号：聊天文件会被追加写，行号会变；
 * 时间戳是数据本身的属性，不会因为文件增长而失效。
 * 同一秒内有多行时返回全部匹配（宁可多给几条上下文，不要漏）。
 *
 * @param {string} 仓库根
 * @param {{来源?:string, 日期?:string, 时间?:string}} 坐标
 * @returns {Promise<{ok:boolean, 命中:Array<{时间:string,昵称:string,pid:string,内容:string}>, 错误:string}>}
 */
export async function 回查原文 (仓库根, 坐标 = {}) {
  const { 来源, 日期, 时间 } = 坐标
  if (!日期 || !时间) return { ok: false, 命中: [], 错误: '缺少日期或时间，无法定位原文' }
  const 聊天根 = path.join(仓库根, 'chat')
  // 来源 → 目录：private → chat/private；group:xxx → chat/group/xxx
  const 目录 = String(来源 || '').startsWith('group:')
    ? path.join(聊天根, 'group', String(来源).slice(6))
    : path.join(聊天根, 'private')
  const 文件 = path.join(目录, `${日期}.txt`)

  let 文本
  try {
    文本 = readFileSync(文件, 'utf8')
  } catch {
    return { ok: false, 命中: [], 错误: `找不到当天的聊天文件：${文件}` }
  }
  const 命中 = []
  const 规范时间 = String(时间).length === 5 ? `${时间}:00` : String(时间)
  for (const 行 of 文本.split('\n')) {
    const m = 行.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+?)\(([^)]*)\):\s?([\s\S]*)$/)
    if (!m) continue
    const 行时间 = m[1].length === 5 ? `${m[1]}:00` : m[1]
    if (行时间 !== 规范时间) continue
    命中.push({ 时间: m[1], 昵称: m[2], pid: m[3], 内容: m[4] })
  }
  return 命中.length
    ? { ok: true, 命中, 错误: '' }
    : { ok: false, 命中: [], 错误: `当天文件里没有 ${时间} 这条记录（可能已被清理）` }
}

/** 分层库文件名。 */
export const 分层库文件名 = 'chat-levels.json'

/** 分层库版本。改了存储结构就加一，旧文件会被当成不存在。 */
const 版本 = 1

/**
 * 递归扫描聊天目录，读出全部消息。
 *
 * 目录结构：<聊天根>/chat/{private|group/<群号>}/YYYY-MM-DD.txt
 * 行格式：`[HH:MM:SS] 昵称(pid): 内容`
 *
 * @param {string} 仓库根 记忆仓库根目录（里面有 chat/）
 * @returns {Array<{来源:string, 日期:string, 时间:string, 昵称:string, pid:string, 内容:string}>}
 */
export function 扫描聊天 (仓库根) {
  const 聊天根 = path.join(仓库根, 'chat')
  const 出 = []
  const 走 = (dir, 来源) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const n of names.sort()) {
      const p = path.join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        // 群目录名就是群号
        走(p, 来源 === 'private' ? 'private' : `group:${n}`)
        continue
      }
      if (!n.endsWith('.txt')) continue
      const m = n.match(/^(\d{4}-\d{2}-\d{2})\.txt$/)
      if (!m) continue
      let 文本
      try { 文本 = readFileSync(p, 'utf8') } catch { continue }
      for (const ln of 文本.split('\n')) {
        const r = ln.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+?)\(([^)]*)\):\s?([\s\S]*)$/)
        if (!r) continue
        出.push({
          来源,
          日期: m[1],
          时间: r[1],
          昵称: r[2],
          pid: r[3],
          内容: r[4],
        })
      }
    }
  }
  // private 和 group 是两个子目录
  const 私 = path.join(聊天根, 'private')
  try { if (statSync(私).isDirectory()) 走(私, 'private') } catch { /* 没有私聊 */ }
  const 群 = path.join(聊天根, 'group')
  try {
    if (statSync(群).isDirectory()) {
      for (const g of readdirSync(群).sort()) {
        const p = path.join(群, g)
        try { if (statSync(p).isDirectory()) 走(p, `group:${g}`) } catch { /* 跳过 */ }
      }
    }
  } catch { /* 没有群 */ }
  return 出
}

/**
 * 读已落盘的分层库。
 *
 * @param {string} 文件
 * @returns {Promise<{version:number, 已处理: Set<string>, 条目: object[], 统计: object}>}
 */
export async function 读分层库 (文件) {
  // ⚠️ 不要复用 recall-scorer 的 读打分缓存：那个是给「指纹→分数」映射用的，
  // 形状是 { version, 按指纹:{} }。本模块存的是 { version, 已处理:[], 条目:[] }。
  // 复用会让每次都读到空库（字段名对不上），表现为「每次全量重算，
  // 模型额度被反复烧」，而且不报错 —— 踩过，所以这里自己读自己。
  try {
    const v = JSON.parse(readFileSync(文件, 'utf8'))
    if (!v || v.version !== 版本) return { version: 0, 已处理: new Set(), 条目: [], 统计: {}, 原始: null }
    return {
      version: v.version,
      已处理: new Set(Array.isArray(v.已处理) ? v.已处理 : []),
      条目: 展开条目(v),
      统计: v.统计 || {},
      // 原始对象一并返回：投喂账本等新增字段挂在文件顶层，
      // 经 展开条目 之后只剩扁平条目，就读不到了。直接给调用方原文最省事。
      原始: v,
    }
  } catch {
    return { version: 0, 已处理: new Set(), 条目: [], 统计: {}, 原始: null }
  }
}

/**
 * 把分层结果转成检索库的索引条目。
 *
 * 聊天条目的 title 留空、tags 用分层名，weight 存层级 ——
 * rank.js 会把层级权重乘进重要度分，日记永远排在聊天前面。
 *
 * @param {Array<{来源:string, 日期:string, 时间:string, 昵称:string, pid:string, 内容:string, 层级:number}>} 条目们
 * @returns {Array<object>}
 */
export function 并入索引条目 (条目们) {
  return (Array.isArray(条目们) ? 条目们 : []).map((e, i) => ({
    来源: e.来源,
    日期: e.日期,
    id: `chat-${e.日期}-${String(i).padStart(5, '0')}`,
    title: '',
    // 兼容两种存储：新版存 摘要（精简），旧版存 内容（完整）。
    // 升级后旧文件不会突然读不出来 —— 老库照常能用，下次分层时自然变成新格式。
    text: e.摘要 ?? e.内容 ?? '',
    tags: [],
    at: `${e.日期}T${e.时间 || '00:00:00'}`,
    类型: '聊天',
    层级: Number(e.层级) || 0,
    昵称: e.昵称 || '',
    // 回查坐标：只看摘要不够时要全文，用这三个字段定位到原始文件那一行
    回查: { 来源: e.来源, 日期: e.日期, 时间: e.时间 },
    // 指纹必须一路带下来：写回命中（lastHit）时按指纹匹配分层库里的记录。
    // 漏了它，过滤会把所有条目滤光，表现是「检索到了、但永远不记命中」——
    // 衰减机制静默失效，而且日志里什么都不会留。实测踩过。
    指纹: e.指纹,
  }))
}

/**
 * 把「命中记录」写回分层库（只改 lastHit，其余原样）。
 *
 * 为什么单独一个函数而不是让检索侧直接写文件：
 * 检索侧不该知道分层库的存储结构（分组、指纹…）。这里封装好，
 * 检索侧只调用它，将来存储结构再变，改这一处就够。
 *
 * 为什么要写盘：lastHit 只在内存里改，进程一重启就丢 ——
 * 衰减会永远从头算，一条被反复检索的老记录看起来永远新鲜，
 * 12 层降级与归档永远不会发生。这是纯内存方案的必然结果。
 *
 * @param {string} 文件
 * @param {Array<object>} 命中条目 已被更新过 lastHit 的条目（要有 指纹）
 * @returns {Promise<{ok:boolean, 更新:number, 错误:string}>}
 */
export async function 写回命中 (文件, 命中条目) {
  if (!文件) return { ok: false, 更新: 0, 错误: '没有分层库文件路径' }
  const 命中们 = Array.isArray(命中条目) ? 命中条目.filter((e) => e && e.指纹 && e.lastHit) : []
  if (命中们.length === 0) return { ok: true, 更新: 0, 错误: '' }

  let 原
  try {
    原 = JSON.parse(readFileSync(文件, 'utf8'))
  } catch {
    return { ok: false, 更新: 0, 错误: '分层库读不到，跳过写回' }
  }

  const 表 = new Map(命中们.map((e) => [String(e.指纹), e.lastHit]))
  let 更新 = 0
  // 新旧两种格式都要覆盖到
  if (Array.isArray(原.分组)) {
    for (const g of 原.分组) {
      for (const e of Array.isArray(g.条目) ? g.条目 : []) {
        const t = 表.get(String(e?.指纹))
        if (t && e.lastHit !== t) { e.lastHit = t; 更新 += 1 }
      }
    }
  }
  for (const e of Array.isArray(原.条目) ? 原.条目 : []) {
    const t = 表.get(String(e?.指纹))
    if (t && e.lastHit !== t) { e.lastHit = t; 更新 += 1 }
  }
  if (更新 === 0) return { ok: true, 更新: 0, 错误: '' }

  try {
    const { writeFile, rename, chmod } = await import('node:fs/promises')
    const 临时 = `${文件}.hit-${process.pid}`
    await writeFile(临时, JSON.stringify(原))
    try { await chmod(临时, 0o600) } catch { /* 非 POSIX 忽略 */ }
    await rename(临时, 文件)
  } catch (e) {
    return { ok: false, 更新: 0, 错误: `写回失败：${e?.message || e}` }
  }
  return { ok: true, 更新, 错误: '' }
}

/**
 * 跑一次完整分层。
 *
 * @param {object} 选项
 * @param {string} 选项.仓库根 记忆仓库根目录
 * @param {string} 选项.输出文件 分层库路径
 * @param {object} [选项.模型配置] 有值且 选项.用模型 为真时才调模型
 * @param {boolean} [选项.用模型]
 * @param {number} [选项.最低档次] 低于这档的不并入（0/1/2）
 * @param {Function} [选项.日志]
 * @returns {Promise<object>}
 */
export async function 跑分层 (选项 = {}) {
  const 说 = typeof 选项.日志 === 'function' ? 选项.日志 : () => {}
  const 仓库根 = 选项.仓库根
  const 输出 = 选项.输出文件
  if (!仓库根 || !输出) return { ok: false, 错误: '缺少 仓库根 或 输出文件' }

  const 全部 = 扫描聊天(仓库根)
  if (全部.length === 0) {
    return { ok: false, 错误: `在 ${path.join(仓库根, 'chat')} 下没找到聊天记录` }
  }
  说(`扫到 ${全部.length} 条消息`)

  // 先读旧库：已处理集合用于增量，旧条目用于保留结果
  const 旧 = await 读分层库(输出)
  // 指纹 → 上次命中时间。重新分层时据此保留衰减进度（见 分组精简 里的说明）。
  const 上次命中映射 = new Map()
  for (const e of 旧.条目) {
    if (e && e.指纹 && e.lastHit) 上次命中映射.set(e.指纹, e.lastHit)
  }

  // ── 投喂账本：哪些消息真的喂过模型 ────────────────────────────────
  //
  // ⚠️ 不要用 旧.已处理 判断「要不要再送模型」。
  // 那个集合记的是「被规则分过层」，几乎等于全部消息，而且
  // **模型调用失败的那批也被记进去了** —— 一次网络抖动，那些消息
  // 就永远不再送到模型面前，数据永久丢失且不报错（2026-11-04 复现过）。
  // 投喂账本只在模型**成功返回后**才记，见 lib/recall-fed.js。
  const { 读账本, 空账本, 已投喂, 批量记投喂, 修剪账本, 账本统计 } = await import('./recall-fed.js')
  const 账本 = 读账本(旧.原始) || 空账本()

  // ── 规则分层（永远执行）──────────────────────────────────────────
  //
  // 规则来自 recall-rules.解析规则()：预设 + 用户增量合成后的结果。
  // 不传就用内置默认（技术向预设），保证老调用点行为不变。
  const { 解析规则 } = await import('./recall-rules.js')
  const 生效规则 = 选项.规则 || 解析规则(选项.规则配置 || {})
  const 规则结果 = []
  for (const m of 全部) {
    const 播报 = 是机器人播报(m.内容, 生效规则)
    const r = 打分层(m, 生效规则)
    规则结果.push({
      ...m,
      指纹: 消息指纹(m),
      层级: 播报 ? 分层.闲聊 : r.层级,
      分: r.分,
      特征: r.特征,
      播报,
    })
  }
  const 分布 = { 核心: 0, 有用: 0, 闲聊: 0, 播报: 0 }
  for (const x of 规则结果) {
    分布.播报 += x.播报 ? 1 : 0
    if (x.播报) continue
    if (x.层级 === 分层.核心) 分布.核心 += 1
    else if (x.层级 === 分层.有用) 分布.有用 += 1
    else 分布.闲聊 += 1
  }
  说(`规则分层：核心 ${分布.核心} / 有用 ${分布.有用} / 闲聊 ${分布.闲聊} / 播报 ${分布.播报}`)

  // ── 模型分层（可选）──────────────────────────────────────────────
  let 最终 = 规则结果
  let 模型信息 = { 启用: false, 处理数: 0, 跳过数: 0, 失败批: 0, 错误: [] }
  const 用模型 = 选项.用模型 && 选项.模型配置 && 选项.模型配置.apiKey && 选项.模型配置.baseURL && 选项.模型配置.model
  if (用模型) {
    说('模型打分：已启用')
    // 只送非播报、非空的消息给模型 —— 播报本来就该是闲聊，白花额度
    const 候选 = 规则结果.filter((x) => !x.播报 && String(x.内容 || '').trim().length >= 2)
    // 范围与成本限制：
    //   · 只打最近 N 天 —— 按日期过滤，省额度也方便「先试最近一周」
    //   · 单次最多条数 —— 超出的留到下次（指纹没写，下次还会处理）
    const 最近天数 = Number(选项.只打最近天数)
    let 最早日期 = ''
    if (Number.isFinite(最近天数) && 最近天数 > 0) {
      const d = new Date(Date.now() - 最近天数 * 86400000)
      最早日期 = d.toISOString().slice(0, 10)
      说(`范围限定：只打 ${最早日期} 之后的`)
    }
    // 档位：决定同一条消息在哪个「桶」里记账。
    // 同一条消息，在「只喂核心」和「全量喂」两个档位下送进模型的内容不同，
    // 算两次投喂 —— 所以账本按档位分开记。
    const 档 = 选项.投喂档位 || 选项.规则配置?.事件提炼档位 || 'screened'

    // ── 重新投喂：先按日期扣账，再照常跑 ──────────────────────────────
    //
    // 用户对某天的结果不满意时，要能明确地让那一天重来。
    //
    // ⚠️ 这里是**扣账**，不是绕过账本。
    // 如果改成「传个 force 让 已投喂判断 恒返回 false」，那些消息就永远
    // 不会被记为已投喂 —— 每跑一次分层就重花一次钱，而账本上一条记录
    // 都没有，用户根本查不出钱花在哪。扣账则让重喂成功的消息重新被记上、
    // 失败的不会被记，和第一次投喂完全同一套规则。
    let 重喂信息 = null
    if (选项.重新投喂) {
      const { 解析日期范围, 日期在范围内, 扣账 } = await import('./recall-fed.js')
      let 范围
      try {
        范围 = 解析日期范围(选项.重新投喂)
      } catch (e) {
        // 日期写法不认就直接失败，不能猜 —— 猜错方向的代价是整个库重喂
        return { ok: false, 错误: e.message }
      }
      // 只扣这个档位的账：别的档位是用户另外花过的钱，不该受影响
      const 该扣 = 全部
        .filter((m) => 日期在范围内(m.日期, 范围))
        .map((m) => 消息指纹(m))
      // 预览模式：只算扣多少，不真跑模型。用户先看清楚要花多少再决定
      const 预算 = {
        起: 范围.起, 止: 范围.止,
        日期数: new Set(全部.filter((m) => 日期在范围内(m.日期, 范围)).map((m) => m.日期)).size,
        消息数: 该扣.length,
        可扣账: 该扣.filter((f) => 已投喂(账本, f, 档)).length,
      }
      if (选项.只预览) {
        return {
          ok: true,
          预览: true,
          消息总数: 全部.length,
          规则分布: { 核心: 0, 有用: 0, 闲聊: 0, 播报: 0 },
          模型: { 启用: false, 处理数: 0, 跳过数: 0, 失败批: 0, 错误: [], 投喂档位: 档 },
          并入条数: 0,
          输出文件: 输出,
          重新投喂: 预算,
          统计: {},
        }
      }
      const 扣 = 扣账(账本, 该扣, 档)
      重喂信息 = { ...预算, 扣掉: 扣.扣掉 }
      说(`重新投喂 ${范围.起}${范围.是区间 ? '~' + 范围.止 : ''}：范围内 ${预算.消息数} 条，扣掉 ${扣.扣掉} 条记账（档位 ${档}）`)
    }

    const box = await 模型分层(候选, 选项.模型配置, {
      批大小: 选项.模型配置?.批大小 || 选项.批大小,
      批间隔毫秒: 选项.模型配置?.批间隔毫秒 ?? 选项.批间隔毫秒,
      // ⚠️ 这里传账本，不是 旧.已处理。
      // 旧.已处理 把「模型失败的那批」也记进去了，传它会永久跳过那些消息。
      已投喂判断: (指纹) => 已投喂(账本, 指纹, 档),
      最早日期,
      最多条数: 选项.最多条数,
      日志: 说,
      // 每批成功后立刻记账，不等全部跑完 —— 跑到一半被打断时，
      // 已经花掉的 token 不能白花，下次不该再喂。
      每批成功: (指纹们) => { 批量记投喂(账本, 指纹们, 档) },
    })
    最终 = 合并分层(规则结果, box.结果)
    模型信息 = {
      启用: true,
      处理数: box.处理数,
      跳过数: box.跳过数,
      失败批: box.失败批,
      范围外: box.范围外,
      被截断: box.被截断,
      投喂档位: 档,
      错误: box.错误.slice(0, 5),
      ...(重喂信息 ? { 重新投喂: 重喂信息 } : {}),
    }
    说(`模型分层：处理 ${box.处理数} 条，跳过已投喂 ${box.跳过数} 条（档位 ${档}），失败 ${box.失败批} 批`)
  } else {
    说('模型打分：未启用（用规则结果）')
  }

  // ── 落盘：按最低档次过滤 ─────────────────────────────────────────
  const 最低 = Number.isFinite(Number(选项.最低档次)) ? Number(选项.最低档次) : 0
  const 过筛 = 最终.filter((x) => x.层级 >= 最低 && !x.播报)

  // ── 落盘：按容量上限裁剪 ─────────────────────────────────────────
  //
  // 分层库只增不减，聊天每天进来 —— 不设上限的话检索会越来越慢
  // （实测 10 万条要 1.3 秒，见 默认容量上限 的注释）。
  // 裁剪放在过滤之后、分组之前：分组前是扁平条目，带 层级/lastHit
  // 这些分组后会丢掉的字段，正好用来判断该淘汰谁。
  const 限 = Number.isFinite(Number(选项.容量上限)) ? Number(选项.容量上限) : 默认容量上限
  const 裁 = 裁剪到上限(过筛, 限)
  const 保留 = 裁.保留
  if (裁.淘汰 > 0) {
    说(`超出容量上限 ${裁.上限} 条，淘汰最不要紧的 ${裁.淘汰} 条（优先丢：闲聊 > 久远 > 没被检索过的）`)
  }

  const 全部指纹 = 最终.map((x) => x.指纹)

  // 修剪投喂账本：淘汰掉的条目对应的记账要一起删。
  //
  // 不修剪的话账本会无限长（分层库有 5 万上限，账本没有）；更麻烦的是
  // 指纹留着会让「将来同一条消息重新出现时」被误判成喂过，永远不再送模型。
  // 修剪按「保留 + 全部」的并集算：全部里的消息可能只是这次没并进库
  // （被档次过滤掉了），但它们确实喂过模型，记账不能丢。
  const 存活 = new Set([...保留.map((x) => x.指纹), ...全部指纹])
  const 修剪结果 = 修剪账本(账本, 存活)
  if (修剪结果.删除 > 0) 说(`投喂账本修剪：删掉 ${修剪结果.删除} 条已不存在的记账`)

  const 缓存 = {
    version: 版本,
    生成时间: new Date().toISOString(),
    已处理: 全部指纹,
    // 投喂账本：哪些消息真的喂过模型（按档位分开记）。
    // 和分层库同生同死 —— 单独存一个文件，分层库重建而账本还在，
    // 就再也不会喂了。见 lib/recall-fed.js 的文件头说明。
    投喂账本: 账本,
    统计: {
      消息总数: 全部.length,
      规则预设: 生效规则.预设名 || '内置默认',
      有用阈值: 生效规则.有用阈值,
      核心阈值: 生效规则.核心阈值,
      规则分布: 分布,
      模型: 模型信息,
      最低档次: 最低,
      并入条数: 保留.length,
      // 容量信息要让用户看得见：库被裁剪过却毫无提示，
      // 用户会以为「我刚说的话怎么搜不到了」，然后怀疑检索坏了。
      容量上限: 裁.上限,
      本次淘汰: 裁.淘汰,
      // 投喂账本统计：让用户能回答「到底喂了多少条、花了多少」
      投喂: 账本统计(账本),
    },
    // ⚠️ 只存「精简摘要 + 回查坐标」，不存完整聊天记录。
    //
    // 为什么：分层库是**索引**，不是存档。完整原文在 chat/<日期>.txt 里
    // 已经有了，再存一份既费空间（实测每条正文平均 19 字，但 JSON 开销
    // 164 字符 —— 开销是内容的 8 倍），也把一个可以按需读取的参考资料
    // 变成了「又一份完整聊天记录副本」，隐私面上多一处暴露。
    //
    // 回查坐标 = 来源 + 日期 + 时间。三者一起能唯一定位到 chat 文件里的
    // 那一行（见 回查原文），需要全文时按需读，不预先存。
    // 分组存：同一天同一个来源的条目放一组，来源和日期只写一次。
    // 每条重复写 "来源":"private","日期":"2026-11-01" 是 40 字符 × 8000 条，
    // 而这两个值在同一组里完全相同 —— 典型的可去重冗余。
    分组: 分组精简(保留, 上次命中映射),
  }
  await 写打分缓存(输出, 缓存)
  说(`已写入 ${保留.length} 条 → ${输出}`)

  return {
    ok: true,
    消息总数: 全部.length,
    规则分布: 分布,
    模型: 模型信息,
    并入条数: 保留.length,
    输出文件: 输出,
    // 容量：淘汰了多少条要回传给调用方，让工具层能明确告诉用户
    容量上限: 裁.上限,
    本次淘汰: 裁.淘汰,
    // 把落盘时用的规则信息一并返回：调用方（工具/日志）要能说出
    // 「这次是按哪套规则、什么阈值算的」，否则用户看到分布变了会疑惑。
    统计: 缓存.统计,
  }
}

/**
 * 按时间读聊天原文（不看相关度）。
 *
 * 【为什么需要这个函数】
 *
 * 主人 2026-11-04 截图暴露的问题：问「搜群主昨天晚上最后一句说话的啥」，
 * 鱼翻了三次都没答对。根因是检索只有「按相关度排序」一种模式，
 * 而「最后一句」「昨晚说了什么」根本不是在问相关度 —— 是在问时间。
 *
 * 相关度排序永远回答不了「最后」：它只会说「最像」。
 *
 * 所以这里提供一个纯时间维度的入口：
 *   · 给定日期范围（可单端）、可选「只看某人」
 *   · 按时间倒序返回最近的若干条
 *   · 不需要索引、不需要打分、不需要模型
 *
 * @param {string} 仓库根 记忆仓库根
 * @param {{来源?:string, 起?:string, 止?:string, 人?:string, 上限?:number}} [选项]
 * @returns {Array<{日期:string, 时间:string, 昵称:string, pid:string, 内容:string, 来源:string}>}
 */
export function 按时间读聊天 (仓库根, 选项 = {}) {
  const 上限 = Math.max(1, Math.min(Number(选项.上限) || 20, 200))
  const 起 = String(选项.起 || '').trim()
  const 止 = String(选项.止 || '').trim()
  const 人 = String(选项.人 || '').trim()
  // 来源：'*' / private / group:<id>；不传默认 private（与其他检索一致）
  const 来源原 = String(选项.来源 || '').trim()
  const 要全部来源 = 来源原 === '*'
  const 只要群 = 来源原.startsWith('group:') || /^\d+$/.test(来源原)
  const 群号 = 来源原.startsWith('group:') ? 来源原.slice(6) : 来源原

  const 出 = []
  const 聊天根 = path.join(仓库根, 'chat')

  // 私聊
  if (要全部来源 || (!只要群 && !来源原.startsWith('group:'))) {
    const 私 = path.join(聊天根, 'private')
    if (existsSync(私)) {
      for (const f of readdirSync(私)) {
        const m = f.match(/^(\d{4}-\d{2}-\d{2})\.txt$/)
        if (!m) continue
        const 日期 = m[1]
        if (起 && 日期 < 起) continue
        if (止 && 日期 > 止) continue
        出.push(...读一天(path.join(私, f), 日期, 'private'))
      }
    }
  }

  // 群聊
  if (要全部来源 || 只要群) {
    const 群根 = path.join(聊天根, 'group')
    if (existsSync(群根)) {
      for (const g of readdirSync(群根)) {
        if (只要群 && 群号 && g !== 群号) continue
        const 目录 = path.join(群根, g)
        try {
          if (!statSync(目录).isDirectory()) continue
        } catch { continue }
        for (const f of readdirSync(目录)) {
          const m = f.match(/^(\d{4}-\d{2}-\d{2})\.txt$/)
          if (!m) continue
          const 日期 = m[1]
          if (起 && 日期 < 起) continue
          if (止 && 日期 > 止) continue
          出.push(...读一天(path.join(目录, f), 日期, `group:${g}`))
        }
      }
    }
  }

  // 按时间倒序，取前 N 条
  const 过滤 = 人 ? 出.filter((x) => x.昵称.includes(人)) : 出
  return 过滤
    .sort((a, b) => `${b.日期}T${b.时间}`.localeCompare(`${a.日期}T${a.时间}`))
    .slice(0, 上限)

  /** 读某一天的聊天文件，解析成消息数组 */
  function 读一天 (文件, 日期, 来源) {
    const 行们 = []
    let 文本
    try { 文本 = readFileSync(文件, 'utf8') } catch { return 行们 }
    const LINE = /^\[(\d{2}:\d{2}:\d{2})\]\s+([^(]+)\((p\d+|[^)]+)\):\s*(.*)$/
    for (const 行 of 文本.split('\n')) {
      const m = 行.replace(/\r$/, '').match(LINE)
      if (!m) continue
      行们.push({ 日期, 时间: m[1], 昵称: m[2].trim(), pid: m[3], 内容: m[4], 来源 })
    }
    return 行们
  }
}
