// ============================================================================
// recall-tools.js —— 记忆检索与覆盖率检查的执行体（自 dsh-memory-recall 并入）
//
// 【这个模块负责什么】
//   memory_recall / memory_coverage 两个工具的实际逻辑。
//   从 lib/tools.js 里拆出来，是因为那两个工具各自有几十行、还要动态
//   import 四个模块，塞进 tools.js 会让那个已经 700 行的文件更难读。
//
// 【为什么这样设计】
//   并入记忆仓库后，数据来源少了一层：检索需要的原始聊天就在本插件自己
//   的 chat/ 目录里，不必再「探测另一个插件」——之前独立版要 require.resolve
//   包名、试固定路径、动态 import chatlog.js，现在直接 import 同目录模块。
//   这是合并带来的最大简化，也是合并的主要理由。
//
//   日记库仍然是**外部只读**的：日记属于另一个插件，我们不 import 它的代码，
//   只读它的文件。这样日记插件单独升级不会弄坏检索。
//   没配日记库（或目录不存在）时，memory_recall 退回「只搜原始聊天」，
//   memory_coverage 明确报不可用 —— 都是可解释的降级，不是静默空结果。
//
// 【对外导出】
//   · 跑检索({args, 日记根, 仓库根, 说}) —— memory_recall 的执行体
//   · 跑覆盖率({args, 日记根, 仓库根, 说}) —— memory_coverage 的执行体
// ============================================================================

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { 建索引, 检索, 判置信度, 来源标签 } from './recall-rank.js'
import { 载入词典, 读聊天行, 统计聊天, 找漏记, 拼日记全文 } from './recall-coverage.js'
import { 搜索记录 } from './chatlog.js'
import { 读分层库, 并入索引条目, 分层库文件名 } from './recall-ingest.js'

/** 把检索命中渲染成人读文本。 */
function 渲染命中 (结果) {
  const 行 = []
  for (const r of 结果) {
    const 标签段 = r.标签.length ? ` [${r.标签.join(',')}]` : ''
    行.push(`· [${来源标签(r.来源)}] ${r.日期} ${r.id}${标签段} ${r.标题 || ''}`)
    const 正文 = String(r.内容 || '')
    行.push(`  ${正文.length > 240 ? 正文.slice(0, 240) + '…' : 正文}`)
    行.push(`  分：总 ${r.分数.总分}（词面 ${r.分数.词面} / 向量 ${r.分数.向量} / 时效 ${r.分数.时效} / 重要度 ${r.分数.重要度}）`)
  }
  return 行.join('\n')
}

/** 把下钻拿到的原始聊天渲染成文本。 */
function 渲染原文 (命中) {
  const 行 = ['', '—— 以下是记忆仓库里的原始聊天 ——']
  for (const h of 命中) {
    const 群 = h.群 ? ` @群${h.群}` : ''
    行.push(`[${h.日期} ${h.时间}] ${h.昵称}(${h.pid})${群}: ${h.内容}`)
  }
  return 行.join('\n')
}

/**
 * 读日记库全部条目。目录不存在 / 读不到 → 返回空数组。
 *
 * 只读，不关心日记插件怎么实现 —— 文件布局是契约，代码不是。
 */
function 读日记 (日记根) {
  const 条目 = []
  if (!日记根) return 条目
  const 根 = path.join(日记根, 'entries')
  let 来源目录们
  try {
    来源目录们 = readdirSync(根)
  } catch {
    return 条目
  }
  for (const name of 来源目录们) {
    const dir = path.join(根, name)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    // 目录名 private / group-<群号> → 来源 key
    let key = ''
    if (name === 'private') key = 'private'
    else {
      const m = name.match(/^group[-_]([A-Za-z0-9_-]+)$/)
      if (m) key = `group:${m[1]}`
    }
    if (!key) continue
    let names
    try { names = readdirSync(dir) } catch { continue }
    for (const n of names.sort()) {
      const m = n.match(/^(\d{4}-\d{2}-\d{2})\.json$/)
      if (!m) continue
      let v
      try {
        v = JSON.parse(readFileSync(path.join(dir, n), 'utf8'))
      } catch { continue }
      if (!v || !Array.isArray(v.entries)) continue
      for (const e of v.entries) {
        if (!e || typeof e !== 'object' || typeof e.text !== 'string') continue
        条目.push({
          来源: key,
          日期: m[1],
          id: String(e.id || ''),
          title: String(e.title || ''),
          text: e.text,
          tags: Array.isArray(e.tags) ? e.tags.map(String) : [],
          at: String(e.at || ''),
        })
      }
    }
  }
  return 条目
}

/**
 * 直接搜本插件的聊天记录（下钻用）。
 *
 * 复用 chatlog.js 的 搜索记录 —— 合并在同一个插件里，不必再探测接口。
 * 返回形状对齐 搜索记录 的真实约定：{ date, groupId, line, text }，
 * 内容在 text，整行在 line，昵称与 pid 只能从 line 里拆。
 */
async function 搜聊天 (仓库根, 查询, { chatType, groupId, limit = 10 } = {}) {
  const hits = await 搜索记录(仓库根, 查询, {
    chatType,
    groupId,
    limit: Math.max(1, Math.min(Number(limit) || 10, 50)),
  })
  return (Array.isArray(hits) ? hits : []).map((h) => {
    const 行 = String(h.line || '')
    const m = 行.match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+?)\(([^)]*)\):\s?([\s\S]*)$/)
    return {
      日期: h.date || '',
      时间: m ? m[1] : '',
      昵称: m ? m[2] : '',
      pid: m ? m[3] : '',
      内容: String(h.text || (m ? m[4] : 行)),
      群: h.groupId || null,
    }
  })
}

/**
 * memory_recall 的执行体。
 *
 * @param {{args: object, 日记根: string, 仓库根: string, 说?: Function}} p
 */
export async function 跑检索 ({ args, 日记根, 仓库根, 分层库文件 = '', 说 = () => {} }) {
  const 查 = String(args.query ?? '').trim()
  if (!查) {
    return { 找到: false, 命中数: 0, 下钻过: false, 下钻原因: '', 原文数: 0, text: 'query 不能为空。' }
  }
  // 来源：不传默认私聊（群聊里说的不一定是本人）
  const 原样 = String(args.来源 ?? '').trim()
  let 来源参数
  if (原样 === '*') 来源参数 = '*'
  else if (/^\d+$/.test(原样)) 来源参数 = `group:${原样}`
  else if (原样.startsWith('group:')) 来源参数 = 原样
  else 来源参数 = 'private'

  const limit = Math.max(1, Math.min(Number(args.limit) || 8, 30))
  const 深度 = String(args.深度 ?? 'auto').toLowerCase()

  // ── 有日记库就查索引；没有就直接搜聊天 ─────────────────────────────
  const 日记条目 = 读日记(日记根)
  if (日记条目.length === 0) {
    // 降级：直接搜原始聊天。此时没法做「四因子打分」，
    // 但至少能回答「以前提过没有」。
    const 命中 = await 搜聊天(仓库根, 查, {
      chatType: 来源参数 === 'private' ? 'private' : 'group',
      groupId: 来源参数.startsWith('group:') ? 来源参数.slice(6) : undefined,
      limit,
    })
    const 头 = 日记根
      ? `日记库里没有条目（${日记根}），已直接搜原始聊天。`
      : '未配置日记库目录，已直接搜原始聊天。'
    return {
      找到: 命中.length > 0,
      命中数: 命中.length,
      下钻过: true,
      下钻原因: '没有日记库，直接搜聊天原文',
      原文数: 命中.length,
      text: [头, 命中.length ? 渲染原文(命中) : '聊天里也没搜到。'].join('\n'),
    }
  }

  // ── 并入分层后的聊天 ──────────────────────────────────────────────
  //
  // 聊天不直接进索引，而是走「分层库」：只有 memory_score_chats 跑过、
  // 且层级达标的条目才会并进来，并且带 层级 字段 —— rank.js 据此把
  // 聊天排在日记之后。
  //
  // 读不到分层库不是错误：没跑过分层就没有聊天条目，检索照常用日记。
  // 也不该因此报警 —— 分层是可选功能，默认就是没跑的。
  let 聊天条目 = []
  if (分层库文件) {
    try {
      const 库 = await 读分层库(分层库文件)
      聊天条目 = 并入索引条目(库.条目)
    } catch {
      聊天条目 = []
    }
  }
  const 索引 = 建索引([...日记条目, ...聊天条目])
  const 结果 = 检索(索引, 查, { 来源: 来源参数, limit })
  const 置信 = 判置信度(结果)

  const 头 = `搜索：${查}（来源：${来源参数 === '*' ? '全部' : 来源标签(来源参数)}）`
  const 统计 = 结果.命中数 > 0
    ? `命中 ${结果.命中数} 条，显示 ${结果.结果.length} 条 | 最高分 ${结果.分数分布.最高}`
    : '索引里没有命中'

  // ── 要不要下钻 ────────────────────────────────────────────────────
  const 要下钻 = 深度 !== 'off' && 置信.下钻
  let 原文 = []
  let 下钻原因 = 置信.理由
  if (要下钻) {
    try {
      原文 = await 搜聊天(仓库根, 查, {
        chatType: 来源参数 === 'private' ? 'private' : 'group',
        groupId: 来源参数.startsWith('group:') ? 来源参数.slice(6) : undefined,
        limit: 10,
      })
      下钻原因 = `${置信.理由} → 已下钻，捞出 ${原文.length} 条原文`
    } catch (e) {
      下钻原因 = `${置信.理由} → 下钻失败：${e?.message || e}`
    }
  }

  const 段 = [头, 统计]
  if (结果.结果.length > 0) 段.push('', 渲染命中(结果.结果))
  if (原文.length > 0) 段.push(渲染原文(原文))
  段.push('', `判断：${下钻原因}`)

  return {
    找到: 结果.命中数 > 0 || 原文.length > 0,
    命中数: 结果.命中数,
    下钻过: 要下钻,
    下钻原因,
    原文数: 原文.length,
    text: 段.join('\n'),
  }
}

/**
 * memory_coverage 的执行体。
 *
 * @param {{args: object, 日记根: string, 仓库根: string, 说?: Function}} p
 */
export async function 跑覆盖率 ({ args, 日记根, 仓库根, 说 = () => {} }) {
  const 日记条目 = 读日记(日记根)
  if (日记条目.length === 0) {
    return {
      ok: false, 聊天行数: 0, 日记条数: 0, 漏记数: 0,
      text: 日记根
        ? `日记库里没有条目（${日记根}），覆盖率检查需要日记做对照，暂时不可用。`
        : '未配置「日记库目录」，覆盖率检查需要日记做对照，暂时不可用。可在设置里填日记库路径。',
    }
  }

  const 聊天根 = path.join(仓库根, 'chat')
  const 行们 = []
  const 读了 = []

  // 收来源目录：不传就是 private + 所有群
  const 原样 = String(args.来源 ?? '').trim()
  const 目录们 = []
  if (!原样) {
    const 私 = path.join(聊天根, 'private')
    try { if (statSync(私).isDirectory()) 目录们.push(私) } catch { /* 没有私聊 */ }
    try {
      for (const g of readdirSync(path.join(聊天根, 'group'))) 目录们.push(path.join(聊天根, 'group', g))
    } catch { /* 没有群 */ }
  } else {
    const key = /^\d+$/.test(原样) ? `group:${原样}` : 原样
    目录们.push(key === 'private' ? path.join(聊天根, 'private') : path.join(聊天根, 'group', key.slice(6)))
  }

  const 走 = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const n of names.sort()) {
      const p = path.join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { 走(p); continue }
      if (!n.endsWith('.txt')) continue
      try {
        行们.push(...读聊天行(readFileSync(p, 'utf8')))
        读了.push(n)
      } catch { /* 单个文件读不了就跳过，不让整个检查失败 */ }
    }
  }
  for (const d of 目录们) 走(d)

  if (行们.length === 0) {
    return {
      ok: false, 聊天行数: 0, 日记条数: 日记条目.length, 漏记数: 0,
      text: `记忆仓库里没读到聊天记录（${聊天根}）。覆盖率检查需要聊天做对照。`,
    }
  }

  const 词典 = await 载入词典()
  const 统计 = 统计聊天(行们, 词典)

  // 门槛自适应：样本少时死守 15 条会「报平安」，那比报噪声糟得多
  const 指定 = Number(args.最少消息)
  const 自动门槛 = 行们.length < 100 ? Math.max(2, Math.floor(行们.length / 8)) : 15
  const 生效门槛 = Number.isFinite(指定) && 指定 > 0 ? 指定 : 自动门槛
  const 自动人数 = 行们.length < 100 ? 1 : 3

  const 漏 = 找漏记(统计, 拼日记全文(日记条目), {
    词频: 词典.词频,
    最少提及: 生效门槛,
    最少人数: 自动人数,
    上限: Math.max(1, Math.min(Number(args.上限) || 20, 100)),
  })

  const 段 = [
    `覆盖率检查：读了 ${读了.length} 个聊天文件、${行们.length} 条消息，对账 ${日记条目.length} 条日记`,
    `词表：${词典.来源 || '未载入'}${词典.缺.length ? `（缺：${词典.缺.join('；')}）` : ''}`,
    `判定门槛：至少 ${生效门槛} 条消息、${自动人数} 个不同的人提过${行们.length < 100 ? '（样本少，已自动下调）' : ''}`,
  ]
  if (漏.length === 0) {
    段.push('', '没有发现漏记：聊得多的话题都在日记里出现过。')
  } else {
    段.push('', `发现 ${漏.length} 个「聊得多但从没记过」的话题：`, '')
    for (const x of 漏) 段.push(`· ${x.词} —— ${x.消息数} 条消息 / ${x.人数} 个人提过`)
    段.push('', '提示：这些是候选，不是「必须记」。值得记的用日记工具记下来；')
    段.push('只是口头禅或闲聊的忽略即可。')
  }

  return {
    ok: true,
    聊天行数: 行们.length,
    日记条数: 日记条目.length,
    漏记数: 漏.length,
    text: 段.join('\n'),
  }
}
