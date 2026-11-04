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
export async function 跑检索 ({ args, 日记根, 仓库根, 分层库文件 = '', 导入目录 = '', 事件库文件 = '', 说 = () => {} }) {
  const 查 = String(args.query ?? '').trim()
  // ⚠️ query 不是唯一入口。
  //
  // 主人 2026-11-04 要求三种检索都支持：按事件问、按人问、按结果问。
  // 后两种根本不需要 query —— 「宝宝上次说要我做什么」查的是人，
  // 「那些最后没解决的事」查的是结果状态。
  // 原来这里一律要求 query 非空，实测把这两种检索直接挡死，报「query 不能为空」。
  const 有人 = String(args.人 ?? '').trim()
  const 要未解决 = args.只看未解决 === true
  const 要遗忘层 = args.只看遗忘层 === true
  // ⚠️ 四个入口都要算数。漏一个的表现是「传了这个参数却提示要你给条件」——
  // 实测踩过：加了 只看遗忘层 之后忘了把它算进这个判断，
  // 结果用户想看看有什么快被忘了，得到的却是「至少要给一个条件」。
  // ⚠️ 每加一个入口参数都要同步加到这里。
  // 漏了的表现是「传了参数却提示要你给条件」—— 已经踩过两次
  // （只看遗忘层、起/止+按时间）。只要有过召回行为就算数。
  const 有时间范围 = !!(String(args.起 ?? '').trim() || String(args.止 ?? '').trim())
  const 是按时间查 = args.按时间 === true
  if (!查 && !有人 && !要未解决 && !要遗忘层 && !有时间范围 && !是按时间查) {
    return {
      找到: false, 命中数: 0, 下钻过: false, 下钻原因: '', 原文数: 0,
      text: [
        '至少要给一个条件：',
        '  query         搜什么',
        '  人            谁的',
        '  起 / 止       哪个日期范围（如 2026-11-03）',
        '  按时间        按时间倒序取最近几条（问「最后一句」用这个）',
        '  只看未解决    找没结论的事',
        '  只看遗忘层    看快被忘掉的事',
      ].join('\n'),
    }
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

  // ── 事件层优先 ───────────────────────────────────────────────────
  //
  // 事件是「一件事」，比「一条消息」更接近用户问的东西。
  // 实测对比：「上次说日记那事怎么定的」——
  //   查消息 → 返回 50 条零散的消息
  //   查事件 → 返回「【日记】群里 48 条讨论 10:22-11:35」一条，带起因和结论
  //
  // ⚠️ 事件层是**可选**的：没有 events.json（没跑过提炼）就自然跳过，
  // 检索退回原来的分层逻辑。不能因为事件层不存在就让整个检索失败。
  // ⚠️ 按时间查要跳过事件层。
  //
  // 实测踩过（2026-11-04）：问「11-03 最后 3 句」，事件层先返回了
  // 【光顾着回话】这种相关度匹配的事件 —— 用户要的是「那天最后说了什么」，
  // 拿到的却是「和查询词最像的事」。
  // 事件层是按「一件事」组织的，它没有「最后一句」这个概念；
  // 要精确到句子，必须走聊天原文。
  if (事件库文件 && args.按时间 !== true) {
    try {
      const { 读事件库, 筛事件 } = await import('./recall-events-store.js')
      const 库 = 读事件库(事件库文件)
      if (库.事件们.length > 0) {
        // 三种检索方式都用上：查询词 + 人 + 未解决
        const 命中们 = 筛事件(库.事件们, {
          查询: 查,
          人: String(args.人 ?? '').trim(),
          未解决: args.只看未解决 === true,
          来源: 来源参数 === '*' ? '' : 来源参数,
          // 只看遗忘层：快被忘掉的事单独列出来，让用户决定救回来还是彻底删
          只看遗忘层: args.只看遗忘层 === true,
          上限: limit,
        })
        // ⚠️ 只要事件库存在，就该在事件层给答复 —— 即使命中 0 条。
        //
        // 原来这里是 `if (命中们.length > 0)`，命中为 0 就往下走到
        // 「搜原始聊天」的降级分支。实测踩过：看遗忘层时事件明明在，
        // 却报「未配置日记库…聊天里也没搜到」，用户完全不知道事件层参与了。
        // 0 命中是个有效答案（这些事里没有你要找的），不该被当成「查询失败」。
        const 用事件层 = 库.事件们.length > 0
        if (用事件层) {
          // 标题按实际条件拼：只按人查时不能写「搜索：（空）」。
          // 用户看到一串空条件会以为功能坏了。
          const 条件说 = [
            查 ? `「${查}」` : '',
            有人 ? `人=${有人}` : '',
            要未解决 ? '只看未解决' : '',
          ].filter(Boolean).join(' + ')
          const 行 = [`${条件说}（事件库 ${库.事件们.length} 条，命中 ${命中们.length} 条）`, '']
          for (const e of 命中们) {
            const 标 = e.提炼方式 === '日记' ? '日记' : e.提炼方式 === '话题' ? '群聊话题' : '聊天'
            // 日期与时间分开显示。
            // 日记事件的「起」是 ISO 时间戳（2026-11-03T05:35:16.754Z），
            // 直接拼在日期后面会变成「2026-11-03 2026-11-03T05:35...」这种鬼样子 ——
            // 实测就是这么显示的。这里把 ISO 提取成 HH:MM 再拼。
            const 起时间 = 转时分(e.起)
            const 止时间 = 转时分(e.止)
            const 时段 = 起时间 ? ` ${起时间}${止时间 && 止时间 !== 起时间 ? '-' + 止时间 : ''}` : ''
            // 遗忘层要显眼地标出来：用户在这里做决定（救回 / 彻底忘掉）
            const 标记 = e.遗忘层 ? ' 🗑 遗忘层' : ''
            行.push(`【${e.事件}】[${标}] ${e.日期}${时段}${标记}`)
            if (e.起因) 行.push(`  起因：${e.起因}`)
            for (const g of (Array.isArray(e.经过) ? e.经过 : []).slice(0, 2)) 行.push(`  经过：${g}`)
            if (e.结果) 行.push(`  结果：${e.结果.length > 80 ? e.结果.slice(0, 80) + '…' : e.结果}`)
            if (Array.isArray(e.参与人) && e.参与人.length) 行.push(`  参与：${e.参与人.slice(0, 5).join('、')}`)
            if (Array.isArray(e.标签) && e.标签.length) 行.push(`  标签：${e.标签.join(' ')}`)
            行.push('')
          }
          if (args.只看遗忘层 === true) {
            行.push('这些事已经很久没人提起了（第 12 层 = 遗忘层）。')
            行.push('救回来：memory_forget_events { 救回: ["事件名"] }')
            行.push('彻底忘掉：memory_forget_events { 彻底遗忘: ["事件名"] }')
          } else {
            // ⚠️ 事件被检索到了，要记下来 —— 否则时间衰减不可逆。
          //
          // 不记的话：事件一路下沉，沉到遗忘层就再也回不来，
          // 因为「被提及」这个本该救命的信号从来没被存过。
          // 用户明明搜到过、看过、用过，系统却当他从没问过。
          //
          // 失败只影响「下次该不该把这个事件算新鲜」，不影响这次结果 ——
          // 用户来是要答案的，不能因为记一笔失败就让他拿不到东西。
          if (args.只看遗忘层 !== true) {
            try {
              const { 记事件命中 } = await import('./recall-events-store.js')
              const r = await 记事件命中(事件库文件, 命中们)
              if (!r.ok) 说(`记录事件命中失败（不影响本次结果）：${r.错误}`)
            } catch (e) {
              说(`记录事件命中失败（不影响本次结果）：${e?.message || e}`)
            }
          }

          行.push('事件是提炼结果；需要原话时按上面的日期和时间去记忆仓库翻。')
          }
          return {
            找到: true,
            命中数: 命中们.length,
            下钻过: false,
            下钻原因: '',
            原文数: 0,
            text: 行.join('\n'),
          }
        }
      }
    } catch (e) {
      // 事件库坏了不该让检索失败 —— 记一笔然后走原来的路
      说(`事件层检索失败，退回分层检索：${e?.message || e}`)
    }
  }

  // ── 按时间取：直接在聊天原文上做 ──────────────────────────────────
  //
  // ⚠️ 必须放在「没有日记库就降级」之前。
  //
  // 实测踩过：问「昨天最后一句说什么」时 query 是空的，而空 query 会
  // 直接掉进降级分支（去搜聊天关键词），「起/止/按时间」这三个参数
  // 根本没机会执行 —— 用户拿到的是「聊天里也没搜到」，
  // 明明那条消息就在文件里。
  //
  // 按时间取不需要相关度、不需要索引，直接读那几天的聊天文件就行，
  // 所以放在所有打分逻辑之前是对的。
  const 起日0 = 规范日期(args.起)
  const 止日0 = 规范日期(args.止)
  const 只要某人0 = String(args.人 ?? '').trim()
  if (args.按时间 === true && (起日0 || 止日0 || 只要某人0)) {
    try {
      const { 按时间读聊天 } = await import('./recall-ingest.js')
      const 条 = 按时间读聊天(仓库根, {
        来源: 来源参数,
        起: 起日0,
        止: 止日0,
        人: 只要某人0,
        上限: limit,
      })
      if (条.length === 0) {
        return {
          找到: false, 命中数: 0, 下钻过: false, 下钻原因: '', 原文数: 0,
          text: `按时间查（${起日0 || '不限'} ~ ${止日0 || '不限'}${只要某人0 ? '，人=' + 只要某人0 : ''}）：没有内容。`,
        }
      }
      const 行 = [
        `按时间倒序（${起日0 || '不限'} ~ ${止日0 || '不限'}${只要某人0 ? '，人=' + 只要某人0 : ''}）：${条.length} 条`,
        '',
      ]
      for (const x of 条) {
        行.push(`[${x.日期} ${x.时间}] ${x.昵称}：${String(x.内容).slice(0, 200)}`)
      }
      return { 找到: true, 命中数: 条.length, 下钻过: false, 下钻原因: '', 原文数: 0, text: 行.join('\n') }
    } catch (e) {
      说(`按时间查失败：${e?.message || e}`)
      // 失败就往下走原来的路，不要让一个可选能力把检索搞挂
    }
  }

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
  // 印象分：影响排序但不改变「能不能搜到」——
  // 一个跟鱼互动多的人说的话排前面，但搜不到的东西不会因为印象分冒出来。
  let 印象表 = null
  try {
    const { 算印象分 } = await import('./recall-impression.js')
    const 全部条目 = 索引?.条目 || 索引?.index?.条目 || []
    // 只从聊天条目里取（日记条目的昵称字段是空的）
    const 有过艾特的 = 全部条目.filter((e) => /@/.test(String(e?.text || e?.内容 || '')))
    if (有过艾特的.length > 0) {
      印象表 = 算印象分(有过艾特的.map((e) => ({
        昵称: e.昵称 || '',
        内容: e.text || e.内容 || '',
        日期: e.日期 || '',
        时间: e.时间 || '',
      }))).按人
    }
  } catch { /* 印象分算不出来不影响检索 */ }

  // ── 时间范围 / 按时间取 ────────────────────────────────────────────
  //
  // 主人 2026-11-04 截图暴露的问题：问「搜群主昨天晚上最后一句说话的啥」，
  // 鱼翻了三次都没答对 —— 因为它根本没有「时间范围」和「按时间取」这两个概念。
  //
  // 三件事：
  //   起/止    只看某段日期的内容（闭区间）
  //   人       只看某个人说的话
  //   按时间   按时间倒序，不看相关度（问「最后一句」就用这个）
  const 起日 = 规范日期(args.起)
  const 止日 = 规范日期(args.止)
  const 只要某人 = String(args.人 ?? '').trim()
  const 按时间取 = args.按时间 === true

  // 先按日期/人过滤候选，再做相关度打分 —— 顺序不能反。
  // 反过来（先打分再过滤）会把大量时间外的条目算进来又丢掉，白算；
  // 更重要的是「按时间取」根本不看分数，先算分纯属浪费。
  let 候选 = 索引.条目
  if (起日 || 止日) {
    候选 = 候选.filter((e) => {
      const d = String(e?.日期 || e?.at || '').slice(0, 10)
      if (!d) return false // 没日期的没法判断在不在范围内，排除
      if (起日 && d < 起日) return false
      if (止日 && d > 止日) return false
      return true
    })
  }
  if (只要某人) {
    候选 = 候选.filter((e) => {
      const 谁 = String(e?.昵称 || '')
      // 空昵称的是日记条目，按人过滤时排除（日记不是「某人说的话」）
      return 谁 && 谁.includes(只要某人)
    })
  }
  const 索引用 = 候选 === 索引.条目 ? 索引 : { ...索引, 条目: 候选 }

  // 按时间取：不看相关度，直接按时间倒序。
  // 这是「最后一句」「最近说了什么」的正确解法 ——
  // 相关度排序回答不了「最后」，它只回答「最像」。
  if (按时间取) {
    const 排好 = 候选.slice().sort((a, b) => {
      const ta = String(a?.at || `${a?.日期 || ''}T${a?.时间 || '00:00:00'}`)
      const tb = String(b?.at || `${b?.日期 || ''}T${b?.时间 || '00:00:00'}`)
      return tb.localeCompare(ta)
    }).slice(0, limit)
    const 行 = []
    const 条件 = [起日 || 止日 ? `时间 ${起日 || '不限'} ~ ${止日 || '不限'}` : '', 只要某人 ? `人=${只要某人}` : '']
      .filter(Boolean).join('，')
    行.push(`按时间倒序${条件 ? '（' + 条件 + '）' : ''}：候选 ${候选.length} 条，取最近 ${排好.length} 条`)
    行.push('')
    for (const e of 排好) {
      const 时 = String(e?.at || `${e?.日期 || ''} ${e?.时间 || ''}`).replace('T', ' ')
      行.push(`[${时}] ${e?.昵称 || ''}：${String(e?.text || e?.内容 || '').slice(0, 200)}`)
    }
    if (排好.length === 0) 行.push('这个范围内没有内容。')
    return { 找到: 排好.length > 0, 命中数: 排好.length, 下钻过: false, 下钻原因: '', 原文数: 0, text: 行.join('\n') }
  }

  const 结果 = 检索(索引用, 查, { 来源: 来源参数, limit, 现在, 印象表 })
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

/**
 * 把各种时间写法统一成 HH:MM。
 *
 * 事件里的时间来自三个地方，格式各不相同：
 *   · 聊天原文：'05:35:16'
 *   · 日记条目：'2026-11-03T05:35:16.754Z'（ISO）
 *   · 话题段：同样来自聊天原文
 * 显示时统一成 HH:MM，认不出来就返回空串（宁可少显示，不要显示一串乱码）。
 *
 * @param {string} t
 * @returns {string}
 */
function 转时分 (t) {
  const s = String(t ?? '').trim()
  if (!s) return ''
  // 已经是 HH:MM:SS 或 HH:MM
  const 短 = s.match(/^(\d{1,2}):(\d{2})/)
  if (短) return `${短[1].padStart(2, '0')}:${短[2]}`
  // ISO 时间戳
  const iso = s.match(/T(\d{2}):(\d{2})/)
  if (iso) return `${iso[1]}:${iso[2]}`
  return ''
}


/**
 * 把各种日期写法规范成 YYYY-MM-DD。认不出来返回空串。
 *
 * 支持：
 *   '2026-11-03'   原样
 *   '11-03'        补当前年份
 *   '11/03'        斜杠也认
 *
 * 为什么不做「昨天」「前天」这种：那需要知道「现在」是哪天，
 * 而模型传参数时更该直接算好日期 —— 让工具自己猜「昨天」，
 * 跨天、时区、服务器时间不准时全是坑。
 *
 * @param {string} v
 * @returns {string}
 */
export function 规范日期 (v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/)
  if (m) return 拼日期(m[1], m[2], m[3])
  m = s.match(/^(\d{1,2})[-/](\d{1,2})$/)
  if (m) return 拼日期(new Date().getFullYear(), m[1], m[2])
  return ''
}

/**
 * 拼日期，并校验它真实存在。
 *
 * 为什么要校验：`2026-13-45` 格式完全对，但那天不存在。
 * 原样返回的话，过滤时会一条都匹配不上 —— 用户看到「这个范围内没有内容」，
 * 以为是数据问题，实际是日期写错了。宁可返回空串让调用方知道参数无效。
 */
function 拼日期 (年, 月原, 日原) {
  const 月 = Number(月原)
  const 日 = Number(日原)
  if (!(月 >= 1 && 月 <= 12)) return ''
  if (!(日 >= 1 && 日 <= 31)) return ''
  const t = new Date(Date.UTC(Number(年), 月 - 1, 日))
  if (Number.isNaN(t.getTime())) return ''
  // 回读校验：2026-02-30 会被 Date 归一成 3 月 2 日，回读就能发现
  const 规整月 = t.getUTCMonth() + 1
  const 规整日 = t.getUTCDate()
  if (规整月 !== 月 || 规整日 !== 日) return ''
  return `${年}-${String(月).padStart(2, '0')}-${String(日).padStart(2, '0')}`
}
