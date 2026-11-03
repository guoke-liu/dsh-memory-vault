// ============================================================================
// coverage.js —— 记忆覆盖率检查：找出「聊得多但从没记进日记」的话题
//
// 【这个模块负责什么】
//   拿两份数据对账：
//     · 记忆仓库的原始聊天（聊了什么、聊了多少次）
//     · 日记库的条目（记了什么）
//   输出「在聊天里高频出现、但日记里一次都没出现」的词 —— 这些是**漏记**。
//
// 【为什么这样设计】
//   · 为什么不用词频直接排：实测过，直接按频次排出来的前 40 个
//     「漏记话题」里，一半是「已经 / 因为 / 但是 / 所以 / 或者」这种连词。
//     它们在每条聊天里都出现、日记里当然不会记，全被当成「漏记」就废了。
//
//   · 三层过滤，每层挡一种不同的噪声：
//       ① 最长匹配切词 —— 挡跨词碎片（「天去」「的是」）。
//          2 字滑窗会把「今天去哪里」切成 今天/天去/去哪/哪里，
//          「天去」这种碎片没有任何意义。
//       ② 通用词频门槛 —— 挡语法功能词。用 jieba 那份 2 万行词频表
//          （0=最常用，99=最罕见），只留罕见度 ≥ 55 的词。
//          「已经」「因为」的词频值都很低，一道门全挡掉；
//          「重启」「画图」「豆包」都是 99，稳稳通过。
//       ③ 日记全文对照 —— 这才是核心判据：词在日记全文（含标签、标题）
//          里出现过的，就不算漏记，哪怕只出现过一次。
//
//   · 为什么用「词频表」而不是自建停用词表：自建永远漏。
//     实测自建了 60 多个停用词，还是放过「或者/所以/因为/但是」；
//     而 jieba 词频表是百万级语料统计出来的，覆盖面和权重都更有依据。
//     代价是依赖一个外部表文件 —— 读不到时降级为「不设这道门」，
//     宁可多报噪声，也不要因为读不到表就整个功能失效。
//
//   · 为什么按「消息数」而不是「出现次数」排：一个人刷屏说 50 次同一个词，
//     不如 10 个人各说 1 次更能说明它是个公共话题。所以计的是
//     「有多少条不同的消息提到它」，而不是词频总和。
//
// 【对外导出】
//   · 载入词典({词典路径, 词频路径}) —— 读词表，返回 { 词表, 词频, 来源, 缺 }
//   · 切词最长(文本, 词典) —— 最长匹配切词
//   · 统计聊天(聊天行们, 词典) —— 统计每个词被多少条消息提到
//   · 找漏记(聊天统计, 日记全文, 选项) —— 对账，返回漏记话题列表
//   · 读聊天行(文本) —— 从记忆仓库的文本里抽聊天内容
// ============================================================================

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 包内置词表目录（<包根>/data）。
 *
 * 用 import.meta.url 而不是 process.cwd()：cwd 取决于调用方在哪启动，
 * 而内置数据永远跟着包走。
 */
function 内置数据目录 () {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data')
}

/** 通用词频门槛：jieba 词频里 0 最常用、99 最罕见。低于这个值视为语法功能词。 */
export const 通用稀有门槛 = 55

/** 漏记判定：至少要被提到多少次才算「聊得多」。 */
export const 最少提及 = 15

/** 漏记判定：至少要有几个不同的人说过，才算「公共话题」而不是口癖。 */
export const 最少人数默认 = 3

/** 最长匹配的最大词长。 */
const 最大词长 = 6

/**
 * 载入词表与词频表。
 *
 * 两个表都可能不存在（插件没装、路径变了），所以每一格独立降级：
 *   · 没词表 → 切词退回 2 字滑窗（噪声多但能用）
 *   · 没词频 → 不做语法词过滤（噪声多但能用）
 * 两者都不在也能跑，只是结果会多一些噪声 —— 这比整个功能报错好。
 *
 * @param {{词典路径?: string, 词频路径?: string}} [选项]
 * @returns {Promise<{词表: Set<string>, 词频: Map<string,number>, 来源: string, 缺: string[]}>}
 */
export async function 载入词典 (选项 = {}) {
  const 词表 = new Set()
  const 词频 = new Map()
  const 缺 = []
  const 来源 = []

  // 词表查找顺序：显式传入 → 环境变量 → **包内置**。
  //
  // 内置是默认路径。早先版本读 /opt/dsh-plugins/dsh-fish-memory/lib/词典.txt，
  // 「: 那是另一个私有插件的位置，开源后别人 100% 装不上，功能会
  // 静默降级成噪声很多的模式。现在词表随包分发（jieba，MIT），
  // 装完就能用，不需要旁边再站一个插件。
  const 内置 = 内置数据目录()
  const 词典路径 = 选项.词典路径 || process.env.RECALL_LEX || path.join(内置, 'lexicon.txt')
  const 词频路径 = 选项.词频路径 || process.env.RECALL_FREQ || path.join(内置, 'freq.txt')

  try {
    const 文 = await readFile(词典路径, 'utf8')
    for (const 行 of 文.split('\n')) {
      const w = 行.trim()
      if (w.length >= 2 && w.length <= 最大词长) 词表.add(w)
    }
    来源.push(`词典 ${词表.size} 词（${词典路径}）`)
  } catch {
    缺.push(`词典读不到：${词典路径}`)
  }

  try {
    const 文 = await readFile(词频路径, 'utf8')
    for (const 行 of 文.split('\n')) {
      const p = 行.trim().split(/\s+/)
      if (p.length === 2 && /^\d+$/.test(p[1])) 词频.set(p[0], Number(p[1]))
    }
    来源.push(`词频 ${词频.size} 条（${词频路径}）`)
  } catch {
    缺.push(`词频表读不到：${词频路径}`)
  }

  return { 词表, 词频, 来源: 来源.join('；'), 缺 }
}

/**
 * 最长匹配切词。
 *
 * 和 rank.js 的分词逻辑一致，但这里**不收停用词**：覆盖率检查要先拿到
 * 全量词，再由「通用词频门槛」统一过滤 —— 两处各自维护一份停用词表，
 * 早晚会不一致。
 *
 * @param {string} 文本
 * @param {{词表: Set<string>}} 词典
 * @returns {string[]}
 */
export function 切词最长 (文本, 词典) {
  const 串 = String(文本 || '').toLowerCase()
  const 表 = 词典 && 词典.词表 instanceof Set ? 词典.词表 : null
  const 出 = []
  for (const m of 串.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const 段 = m[0]
    if (!表 || 表.size === 0) {
      // 没词表：退回 2 字滑窗
      for (let i = 0; i + 2 <= 段.length; i++) 出.push(段.slice(i, i + 2))
      continue
    }
    let i = 0
    while (i < 段.length) {
      let 命中 = ''
      for (let len = Math.min(最大词长, 段.length - i); len >= 2; len--) {
        const w = 段.slice(i, i + len)
        if (表.has(w)) { 命中 = w; break }
      }
      if (命中) {
        出.push(命中)
        i += 命中.length
      } else {
        i += 1
      }
    }
  }
  return 出
}

/**
 * 从记忆仓库的聊天文本里抽出「说话内容」。
 *
 * 行格式是 `[HH:MM:SS] 昵称(pid): 内容`。抽不到内容（系统消息、空行)
 * 就返回 null，由调用方跳过 —— 不要拿整行去切词，否则昵称和时间
 * 会被当成话题。
 *
 * @param {string} 文本
 * @returns {Array<{pid:string, 昵称:string, 内容:string}>}
 */
export function 读聊天行 (文本) {
  const 出 = []
  for (const 行 of String(文本 || '').split('\n')) {
    const m = 行.match(/^\[\d{1,2}:\d{2}(?::\d{2})?\]\s+(.+?)\(([^)]*)\):\s?([\s\S]*)$/)
    if (!m) continue
    出.push({ 昵称: m[1], pid: m[2], 内容: m[3] })
  }
  return 出
}

/**
 * 统计每个词被多少条**不同消息**提到，以及被多少个人说过。
 *
 * @param {Array<{pid:string, 内容:string}>} 聊天行们
 * @param {object} 词典
 * @returns {Map<string, {消息数:number, 人数:number, 次数:number}>}
 */
export function 统计聊天 (聊天行们, 词典, 选项 = {}) {
  const 规则 = 编译规则(选项.广播规则)
  const 统计 = new Map()
  for (const 行 of 聊天行们) {
    // ⚠️ 跳过机器人的自动播报。
    //
    // 实测：「重启」被报成漏记话题第一名（71 条消息），追进去一看，
    // 其中 27 条是机器人自己发的「【DSH 已重启，新链接】」，
    // 「时长」同理（19 条是「运行时长: 1天8小时」的状态播报）。
    // 这些是系统日志性质的消息，不是人在讨论的话题 —— 被算进词频后
    // 会把真正的漏记话题挤下去，是噪声里最误导人的一种：
    // 它看起来"很多人提过"，实际是同一个机器人刷的。
    if (是广播行(行.内容, 规则)) continue
    const 词们 = new Set(切词最长(行.内容, 词典))
    for (const w of 词们) {
      let e = 统计.get(w)
      if (!e) {
        e = { 消息数: 0, 人数: 0, 次数: 0, 人: new Set() }
        统计.set(w, e)
      }
      e.消息数 += 1
      e.次数 += 拆次数(行.内容, w)
      e.人.add(行.pid)
      e.人数 = e.人.size
    }
  }
  // 把 Set 清掉，别把内部结构漏给调用方
  for (const e of 统计.values()) delete e.人
  return 统计
}

/**
 * 默认的广播行识别规则。
 *
 * 这些不是拍脑袋写的，是从真实群里扒出来的：
 *   · 【DSH 已重启，新链接】 http://...      ← 机器人发链接
 *   · 【手机长期访问链接】 点开就能用         ← 机器人发入口
 *   · SnowLuma 状态 版本: 2.2.1 运行时长: 1天 ← 状态播报
 *   · http://110.40.179.74/dsh/?token=...   ← 裸链接
 *
 * 它们看起来「很多人提过」，实际是同一个机器人反复刷，
 * 会把真正的漏记话题挤下去。这是噪声里最有误导性的一种。
 *
 * @type {RegExp[]}
 */
export const 默认广播规则 = [
  /^【[^】]{1,30}】/,
  /运行时长|状态[:：]|版本[:：]\s*\d/,
  /^https?:\/\//,
]

/**
 * 判断一行是不是机器人的自动播报。
 *
 * @param {string} 内容
 * @param {RegExp[]} [规则] 自定义规则；不传用 默认广播规则
 * @returns {boolean}
 */
export function 是广播行 (内容, 规则 = 默认广播规则) {
  const t = String(内容 || '').trim()
  if (!t) return true
  return (Array.isArray(规则) ? 规则 : 默认广播规则).some((r) => {
    try {
      return r instanceof RegExp && r.test(t)
    } catch {
      return false
    }
  })
}

/** 从「规则字符串数组」（配置里传进来的）编译成 RegExp，非法项丢弃。 */
export function 编译规则 (原始) {
  if (!Array.isArray(原始)) return 默认广播规则
  const 出 = []
  for (const r of 原始) {
    if (r instanceof RegExp) { 出.push(r); continue }
    try {
      出.push(new RegExp(String(r)))
    } catch {
      // 正则写错就跳过，不因为一条坏规则让整个检查失败
    }
  }
  // 全都编译失败时退回默认，避免「配了但配错 → 过滤静默失效」
  return 出.length ? 出 : 默认广播规则
}

/** 一个词在一段文本里出现了几次（不重叠计数）。 */
function 拆次数 (文本, 词) {
  if (!词) return 0
  let n = 0
  let i = 0
  const 串 = String(文本 || '')
  while (true) {
    const j = 串.indexOf(词, i)
    if (j < 0) break
    n += 1
    i = j + 词.length
  }
  return n
}

/**
 * 找漏记：聊天里高频、日记里从没出现过的话题。
 *
 * 过滤链见文件头。返回按「消息数 × 稀有度」降序排。
 *
 * 为什么要乘稀有度：同样是 20 条消息，「重启」比「不对」更值得记。
 * 稀有度高的词信息量大，在日记里缺席才更值得提醒。
 *
 * @param {Map<string, {消息数:number,人数:number,次数:number}>} 统计
 * @param {string} 日记全文 把所有日记条目（含标签、标题）拼成的一整段
 * @param {{通用稀有门槛?: number, 最少提及?: number, 最少人数?: number, 词频?: Map<string,number>, 上限?: number}} [选项]
 * @returns {Array<{词:string, 消息数:number, 人数:number, 次数:number, 稀有度:number, 分:number}>}
 */
export function 找漏记 (统计, 日记全文, 选项 = {}) {
  const {
    通用稀有门槛: 门槛 = 通用稀有门槛,
    最少提及: 最少 = 最少提及,
    词频 = new Map(),
    最少人数 = 最少人数默认,
    上限 = 50,
  } = 选项 || {}

  // 日记全文小写化一次即可，别在循环里反复转换
  const 日记 = String(日记全文 || '').toLowerCase()
  const 出 = []
  for (const [词, e] of 统计) {
    if (e.消息数 < 最少) continue
    // 核心判据：日记全文里出现过就不算漏记。子串判断而不是切词判断 ——
    // 日记里写「重启服务」，这里搜「重启」就该算记过。
    if (日记.includes(词)) continue
    // 通用词频门槛。词频表里查不到的词按「最罕见」处理：
    // 统计表里没有它，说明它不在那 2 万常用词里，多半是个专有名词，
    // 恰恰是最该被关注的漏记话题（「画图」「豆包」这类）。
    // 人数门槛：一个人反复说 50 次，不如 5 个人各说 1 次更能说明它是
    // 公共话题。实测「歪头」46 条消息但只有 2 个人说、「凑近」17 条只有
    // 1 个人说 —— 那是口癖，不是漏记的话题。
    if (e.人数 < 最少人数) continue
    const 稀有度 = 词频.has(词) ? 词频.get(词) : 99
    if (稀有度 < 门槛) continue
    const 分 = e.消息数 * (Math.min(稀有度, 90) / 90)
    出.push({ 词, 消息数: e.消息数, 人数: e.人数, 次数: e.次数, 稀有度, 分 })
  }
  出.sort((a, b) => b.分 - a.分)
  return 出.slice(0, Math.max(1, Math.min(Number(上限) || 50, 200)))
}

/**
 * 把日记库的全部条目拼成一整段文本（标题 + 正文 + 标签）。
 *
 * 为什么标签也要算进「记过」：标签是人工打的主题词，
 * 记了标签就等于这条日记覆盖了那个话题。
 *
 * @param {Array<{title?:string, text?:string, tags?:string[]}>} 条目们
 * @returns {string}
 */
export function 拼日记全文 (条目们) {
  const 段 = []
  for (const e of Array.isArray(条目们) ? 条目们 : []) {
    段.push(e.title || '', e.text || '', (e.tags || []).join(' '))
  }
  return 段.join(' ')
}
