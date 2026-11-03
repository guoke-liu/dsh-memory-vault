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

import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { 打分层, 分层, 是机器人播报 } from './recall-screen.js'
import {
  模型分层, 消息指纹, 写打分缓存, 合并分层,
} from './recall-scorer.js'

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
    if (!v || v.version !== 版本) return { version: 0, 已处理: new Set(), 条目: [], 统计: {} }
    return {
      version: v.version,
      已处理: new Set(Array.isArray(v.已处理) ? v.已处理 : []),
      条目: Array.isArray(v.条目) ? v.条目 : [],
      统计: v.统计 || {},
    }
  } catch {
    return { version: 0, 已处理: new Set(), 条目: [], 统计: {} }
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
    text: e.内容,
    tags: [],
    at: `${e.日期}T${e.时间 || '00:00:00'}`,
    类型: '聊天',
    层级: Number(e.层级) || 0,
    昵称: e.昵称 || '',
  }))
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
    const box = await 模型分层(候选, 选项.模型配置, {
      批大小: 选项.模型配置?.批大小 || 选项.批大小,
      批间隔毫秒: 选项.模型配置?.批间隔毫秒 ?? 选项.批间隔毫秒,
      已处理: 旧.已处理,
      最早日期,
      最多条数: 选项.最多条数,
      日志: 说,
    })
    最终 = 合并分层(规则结果, box.结果)
    模型信息 = {
      启用: true,
      处理数: box.处理数,
      跳过数: box.跳过数,
      失败批: box.失败批,
      范围外: box.范围外,
      被截断: box.被截断,
      错误: box.错误.slice(0, 5),
    }
    说(`模型分层：处理 ${box.处理数} 条，跳过已处理 ${box.跳过数} 条，失败 ${box.失败批} 批`)
  } else {
    说('模型打分：未启用（用规则结果）')
  }

  // ── 落盘：按最低档次过滤 ─────────────────────────────────────────
  const 最低 = Number.isFinite(Number(选项.最低档次)) ? Number(选项.最低档次) : 0
  const 保留 = 最终.filter((x) => x.层级 >= 最低 && !x.播报)
  const 全部指纹 = 最终.map((x) => x.指纹)

  const 缓存 = {
    version: 版本,
    生成时间: new Date().toISOString(),
    已处理: 全部指纹,
    统计: {
      消息总数: 全部.length,
      规则预设: 生效规则.预设名 || '内置默认',
      有用阈值: 生效规则.有用阈值,
      核心阈值: 生效规则.核心阈值,
      规则分布: 分布,
      模型: 模型信息,
      最低档次: 最低,
      并入条数: 保留.length,
    },
    条目: 保留.map((x) => ({
      来源: x.来源,
      日期: x.日期,
      时间: x.时间,
      昵称: x.昵称,
      pid: x.pid,
      内容: x.内容,
      层级: x.层级,
      分: x.分,
      理由: x.理由 || '',
      分层来源: x.分层来源 || 'rule',
      指纹: x.指纹,
    })),
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
    // 把落盘时用的规则信息一并返回：调用方（工具/日志）要能说出
    // 「这次是按哪套规则、什么阈值算的」，否则用户看到分布变了会疑惑。
    统计: 缓存.统计,
  }
}
