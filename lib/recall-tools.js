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

/**
 * 取模型配置：设置页优先，回落 llm.json。
 *
 * 三种情况：
 *   ① 设置里填了 baseURL + 模型名（key 可选）→ 用设置里的。
 *      key 允许为空：有些本地模型（Ollama、vLLM）不需要 key。
 *   ② 设置没填 → 读同目录下的 llm.json（兼容早期配置，也方便从日记插件迁移）。
 *   ③ 都没有 → 返回 null，调用方退回规则筛选。
 *
 * 为什么不强制要求 key：批量打分层是可选功能，本地跑个 7B 模型
 * 完全可行，那种场景下强制填 key 是无意义的门槛。
 *
 * @param {string} 配置目录
 * @param {object} 设置 settings.read() 的结果
 * @returns {Promise<object|null>}
 */
export async function 取模型配置 (配置目录, 设置 = {}) {
  const 有设置 = (设置.模型接口地址 && String(设置.模型接口地址).trim())
    && (设置.模型名称 && String(设置.模型名称).trim())
  if (有设置) {
    return {
      baseURL: String(设置.模型接口地址).trim(),
      apiKey: String(设置.模型密钥 || '').trim(),
      model: String(设置.模型名称).trim(),
      timeoutMs: 120000,
      温度: 设置.模型温度,
      最大输出: 设置.模型最大输出,
      系统提示词: 设置.系统提示词,
      批大小: 设置.模型批大小,
      批间隔毫秒: 设置.模型批间隔毫秒,
    }
  }
  // 设置没填，回落 llm.json
  try {
    const fs = await import('node:fs/promises')
    const p = path.join(配置目录, 'llm.json')
    const v = JSON.parse(await fs.readFile(p, 'utf8'))
    if (v && v.baseURL && v.model) return v
  } catch { /* 没有就算了 */ }
  return null
}

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
  // 有聊天摘要时提示「这不是全文」：分层库只存摘要，全文在聊天记录里。
  // 不提示的话，模型会把摘要当完整原话引用，答出来的话就短了一截。
  const 有聊天 = 结果.some((r) => r.id && String(r.id).startsWith('chat-'))
  if (有聊天) {
    行.push('')
    行.push('（提示：标 chat- 的是聊天摘要，不是全文。要看当时完整原话，用 chat_search 按关键词搜当天的聊天记录。）')
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
function 读日记 (日记根, 导入目录 = '') {
  // 两个来源读同一套布局：日记库（别的插件的）+ 导入目录（本插件写的）。
  // 分开读再合并，互不影响：日记库没有或坏了，导入的数据照样能用。
  const 条目 = []
  for (const 根目录 of [日记根, 导入目录]) {
    if (!根目录) continue
    读一套(根目录, 条目)
  }
  return 条目
}

/** 读一个根目录下的 entries/<来源>/<日期>.json，追加到 条目。 */
function 读一套 (根目录, 条目) {
  const 根 = path.join(根目录, 'entries')
  let 来源目录们
  try {
    来源目录们 = readdirSync(根)
  } catch {
    return
  }
  for (const name of 来源目录们) {
    const dir = path.join(根, name)
    let st
    try { st = statSync(dir) } catch { continue }
    if (!st.isDirectory()) continue
    // 目录名 → 来源 key。两种命名都要认：
    //   private / group-<群号>  —— 日记库的既有布局
    //   其它任意名字            —— 导入数据的来源名（dayone、notion、imported…）
    //
    // 早先只认前两种，其它一律 continue 跳过 —— 结果是导入成功了、
    // 文件也写对了，但检索一条都读不到，而且两边各自看都正常。
    // 认不出的名字原样当来源，比静默跳过强：多读一点无关数据无害，
    // 少读用户刚导入的东西是致命伤。
    let key = ''
    if (name === 'private') key = 'private'
    else {
      const m = name.match(/^group[-_]([A-Za-z0-9_-]+)$/)
      if (m) key = `group:${m[1]}`
      else if (/^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/.test(name)) key = name
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
export async function 跑检索 ({ args, 日记根, 仓库根, 分层库文件 = '', 导入目录 = '', 说 = () => {} }) {
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
  const 日记条目 = 读日记(日记根, 导入目录)
  if (日记条目.length === 0) {
    // 降级：直接搜原始聊天。此时没法做「四因子打分」，
    // 但至少能回答「以前提过没有」。
    const 命中 = await 搜聊天(仓库根, 查, {
      chatType: 来源参数 === 'private' ? 'private' : 'group',
      groupId: 来源参数.startsWith('group:') ? 来源参数.slice(6) : undefined,
      limit,
    })
    // 降级提示必须说清「损失了什么」，否则用户会以为这就是完整功能。
    // 实测少写这一层，用户搜不到重点时第一反应是「这插件不好用」，
    // 而不是「我少配了一项」。
    // 降级分支也要记命中：没配日记库的用户同样有分层库，
    // 他们的聊天索引也参与衰减。不记的话，这批用户的
    // 「被检索就回满层」这条规则永远不会生效 —— 只有降级路径
    // 的用户会觉得衰减机制"没装上"。实测踩过。
    if (命中.length > 0 && 分层库文件) {
      try {
        const { 读分层库, 写回命中 } = await import('./recall-ingest.js')
        const 库 = await 读分层库(分层库文件)
        const 时间集 = new Set(命中.map((h) => `${h.日期}\u0001${h.时间}`))
        const 命中条目 = 库.条目
          .filter((e) => e && e.指纹 && 时间集.has(`${e.日期}\u0001${e.时间}`))
          .map((e) => ({ ...e, lastHit: new Date().toISOString() }))
        if (命中条目.length) await 写回命中(分层库文件, 命中条目)
      } catch { /* 记账失败不影响返回 */ }
    }
    const 头 = 日记根
      ? `日记库里没有条目（${日记根}），已直接搜原始聊天。` +
        '\n注意：没有日记时，检索退化为纯关键词匹配 —— 没有四因子打分、没有时间衰减、也不会判断置信度。' +
        '\n想要完整的跨来源重点检索，需要配置日记库目录（支持小鱼日记的格式）。'
      : '未配置日记库目录，已直接搜原始聊天。' +
        '\n注意：没有日记时，检索退化为纯关键词匹配 —— 没有四因子打分、没有时间衰减、也不会判断置信度。' +
        '\n可在设置页填「日记库目录」启用完整检索；不填也能用，只是效果弱一些。'
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
  const 现在 = Date.now()
  const 结果 = 检索(索引, 查, { 来源: 来源参数, limit, 现在 })
  const 置信 = 判置信度(结果)

  // 记一次命中：进了返回结果就算「被检索过」，层级回到第 1 层。
  // 这一步有副作用（改 lastHit），所以放在检索出口，不放进纯函数的打分里。
  // 只有聊天条目有 lastHit 概念（日记是原文，不是索引条目）。
  if (结果.结果.length > 0) {
    try {
      const { 记命中 } = await import('./recall-decay.js')
      记命中(结果.结果, 索引.条目, 现在)
      // 写回分层库。只在「本次有命中且确实改到了东西」时才写，
      // 避免每次检索都重写一个 1.6MB 的 JSON（那是很贵的 IO）。
      // 两次检索之间进程重启会丢掉这一次的命中 —— 可以接受：
      // 丢一次命中最多让那几条晚一个月降级，不影响整体衰减正确性。
      if (分层库文件) {
        const { 写回命中 } = await import('./recall-ingest.js')
        const 命中条目 = 索引.条目.filter((e) => e && e.lastHit)
        await 写回命中(分层库文件, 命中条目)
      }
    } catch { /* 记命中/写回失败不影响本次返回 —— 检索结果比记账重要 */ }
  }

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
export async function 跑覆盖率 ({ args, 日记根, 仓库根, 导入目录 = '', 说 = () => {} }) {
  const 日记条目 = 读日记(日记根, 导入目录)
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
