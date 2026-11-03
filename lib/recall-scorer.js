// ============================================================================
// recall-scorer.js —— 聊天消息的模型分层打分（可选增强）
//
// 【这个模块负责什么】
//   用大模型给聊天消息打分层分，比规则更懂语义。
//   **默认关闭**：没配模型就完全不调用 API，规则筛选（recall-screen.js）
//   是唯一路径。这个模块只是「有模型时更好」的增强。
//
// 【为什么这样设计】
//   · **绝不能让没有 API 的用户用不了这个功能。**
//     开源用户里相当一部分没有任何模型 key。所以：
//       - 规则版是基本盘，always available；
//       - 模型版是可选开关，配了才走；
//       - 两者输出同一种结构（层级 0/1/2），下游不必区分来源。
//
//   · 为什么必须分批：免费模型普遍有 RPM 限制（Agnes 是 20 次/分），
//     8400 条消息一次请求塞不下，也不该塞。分批 + 批间延时是硬需求，
//     不是优化。
//
//   · 为什么让模型返回 JSON 数组而不是自由文本：
//     解析自由文本要写一堆容错，而容错代码本身会成为新的 bug 源。
//     强制 JSON 后解析失败就是明确的错误，重试一次即可。
//
//   · 增量靠「已处理指纹」：每条消息用 日期+时间+pid+内容哈希 算指纹，
//     处理过的不再重复送模型。24 小时定时跑时，这能保证成本只花在新消息上。
//
// 【对外导出】
//   · 消息指纹(消息) —— 稳定去重键
//   · 读打分缓存(文件) / 写打分缓存(文件, 缓存) —— 持久化
//   · 模型分层(消息们, 配置, 选项) —— 分批调模型打分层
//   · 合并分层(规则结果, 模型结果) —— 以模型为准，模型没覆盖的用规则
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { 分层 } from './recall-screen.js'

/** 默认每批多少条：太多会让模型前后串味，太少则请求次数暴涨。 */
export const 默认批大小 = 40

/** 免费模型 RPM 限制下，批与批之间至少隔多久。20 RPM → 3 秒留余量。 */
export const 默认批间隔毫秒 = 3200

/**
 * 消息指纹：用于判断「这条处理过没有」。
 *
 * 用 日期+时间+pid+内容 而不是消息 ID（记忆仓库的文本行没有稳定 ID）。
 * 取 sha1 前 16 位 —— 够避免碰撞，又比全长好存。
 *
 * @param {{日期?:string, 时间?:string, pid?:string, 内容?:string}} 消息
 * @returns {string}
 */
export function 消息指纹 (消息) {
  const 原文 = [消息?.日期 || '', 消息?.时间 || '', 消息?.pid || '', 消息?.内容 || ''].join('\u0001')
  return createHash('sha1').update(原文).digest('hex').slice(0, 16)
}

/**
 * 读打分缓存。
 *
 * 缓存形状：{ version, 按指纹: { [指纹]: {层级, 分, 理由, 来源, 时间} } }
 * 读不到 / 坏了都返回空缓存 —— 缓存是派生物，丢了重算就行。
 *
 * @param {string} 文件
 * @returns {Promise<{version:number, 按指纹: object}>}
 */
export async function 读打分缓存 (文件) {
  try {
    const v = JSON.parse(await readFile(文件, 'utf8'))
    if (v && v.version === 1 && v.按指纹 && typeof v.按指纹 === 'object') return v
  } catch { /* 读不到就当空 */ }
  return { version: 1, 按指纹: {} }
}

/**
 * 写打分缓存（原子写：先写临时文件再改名，避免写一半断电留下坏 JSON）。
 *
 * @param {string} 文件
 * @param {object} 缓存
 */
export async function 写打分缓存 (文件, 缓存) {
  await mkdir(path.dirname(文件), { recursive: true })
  const 临时 = `${文件}.tmp-${process.pid}`
  await writeFile(临时, JSON.stringify(缓存, null, 2))
  const { rename } = await import('node:fs/promises')
  await rename(临时, 文件)
}

/** 三档的判定标准，写进提示词里给模型。 */
const SYSTEM_PROMPT = `你是一个记忆整理助手。给你一批聊天消息，请给每条消息打个重要度分层。

分三层：
- 2（核心）：包含可长期复用的信息 —— 决定、约定、承诺、规则、具体配置、地址、账号、金额、截止时间、踩过的坑与解法、明确的需求或方案。
- 1（有用）：讨论过程、技术细节、有价值的观点或经验，但没有形成明确结论。
- 0（闲聊）：打招呼、应答、玩笑、情绪表达、纯提问没有回答、无信息量的短句。

判断标准：
- 「谁和谁说的」不重要，「说的内容有没有长期价值」才重要。
- 群友之间的约定也算核心（如果内容具体）。
- 只问不答的问题算 0，除非问题本身包含了具体信息。

输出格式（必须严格遵守）：
- 只输出**一个** JSON 数组，以 [ 开头、以 ] 结尾。
- 数组里每个元素形如 {"i": 序号, "l": 0或1或2, "r": "不超过15字的理由"}
- 不要输出任何解释文字、不要逐行单独输出对象、不要加代码围栏。
- 序号 i 必须对应输入里每条消息前面的编号，且必须为每条消息都返回一项。

正确示例：
[{"i":1,"l":0,"r":"应答"},{"i":2,"l":2,"r":"确定了下周一交版本"},{"i":3,"l":1,"r":"讨论了端口"}]`

/**
 * 把一批消息渲染成给模型的文本。
 *
 * 每条前面带编号，方便模型用 i 引用 —— 比让它重复原文可靠得多
 * （原文可能很长、可能带引号，回显容易出错）。
 *
 * @param {Array<{内容:string}>} 消息们
 * @returns {string}
 */
export function 渲染批次 (消息们) {
  return 消息们.map((m, i) => `${i + 1}. ${String(m.内容 || '').slice(0, 300)}`).join('\n')
}

/** 从模型回答里解析出 JSON 数组；容错掉 ```json 包裹。 */
export function 解析回答 (文本) {
  let t = String(文本 || '').trim()
  const 围栏 = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (围栏) t = 围栏[1].trim()

  // 形式一：标准 JSON 数组
  const 起 = t.indexOf('[')
  const 止 = t.lastIndexOf(']')
  if (起 >= 0 && 止 > 起) {
    try {
      const v = JSON.parse(t.slice(起, 止 + 1))
      if (Array.isArray(v)) return v
    } catch { /* 落到形式二 */ }
  }

  // 形式二：逐行 JSON 对象（每行一个 {"i":..,"l":..}）。
  // 实测遇到的真实退化：模型把数组拆成了多行独立对象，
  // 整段不是合法 JSON。这不是模型的错，是提示词的锅 —— 但既然
  // 解析层能兜住，就不该让整批白跑一次重试（每批重试都烧额度）。
  const 逐行 = []
  for (const 行 of t.split('\n')) {
    const 行文 = 行.trim().replace(/,$/, '')
    if (!行文.startsWith('{')) continue
    try {
      const o = JSON.parse(行文)
      if (o && typeof o === 'object') 逐行.push(o)
    } catch { /* 这一行不是 JSON，跳过 */ }
  }
  if (逐行.length > 0) return 逐行

  // 形式三：单个对象 {..., "items":[...]} 之类
  const 对象起 = t.indexOf('{')
  const 对象止 = t.lastIndexOf('}')
  if (对象起 >= 0 && 对象止 > 对象起) {
    try {
      const v = JSON.parse(t.slice(对象起, 对象止 + 1))
      if (Array.isArray(v)) return v
      for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k]
    } catch { /* 放弃 */ }
  }
  return null
}

/**
 * 调模型给一批消息打分层。
 *
 * @param {Array<对象>} 消息们
 * @param {{baseURL:string, apiKey:string, model:string, timeoutMs?:number, 额外参数?:object}} 配置
 * @returns {Promise<{ok:boolean, 结果:Array<{层级:number, 分:number, 理由:string}>, 错误:string}>}
 */
async function 打一批 (消息们, 配置) {
  const 接口 = String(配置.baseURL || '').replace(/\/+$/, '') + '/chat/completions'
  const 超时 = Number(配置.timeoutMs) > 0 ? Number(配置.timeoutMs) : 120000
  const 控制器 = new AbortController()
  const 计时器 = setTimeout(() => 控制器.abort(), 超时)
  try {
    const 响应 = await fetch(接口, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${配置.apiKey}`,
      },
      body: JSON.stringify({
        model: 配置.model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: 渲染批次(消息们) },
        ],
        temperature: 0,
        max_tokens: 2000,
        ...(配置.额外参数 && typeof 配置.额外参数 === 'object' ? 配置.额外参数 : {}),
      }),
      signal: 控制器.signal,
    })
    const 正文 = await 响应.text()
    if (!(响应.status >= 200 && 响应.status < 300)) {
      // 错误信息先脱敏：key 绝不能出现在任何返回里
      const 干净 = String(正文 || '').split(配置.apiKey || '\u0000').join('***').slice(0, 200)
      return { ok: false, 结果: [], 错误: `HTTP ${响应.status}：${干净}` }
    }
    let 数据 = null
    try { 数据 = JSON.parse(正文) } catch { 数据 = null }
    const 内容 = 数据?.choices?.[0]?.message?.content
    if (typeof 内容 !== 'string') return { ok: false, 结果: [], 错误: '响应里没有 choices[0].message.content' }

    const 数组 = 解析回答(内容)
    if (!数组) return { ok: false, 结果: [], 错误: `模型返回的不是 JSON 数组：${内容.slice(0, 120)}` }

    const 结果 = 消息们.map((_, i) => ({ 层级: 0, 分: 0, 理由: '模型未返回此项' }))
    for (const 项 of 数组) {
      const i = Number(项?.i)
      if (!Number.isFinite(i) || i < 1 || i > 消息们.length) continue
      const l = Number(项?.l)
      if (![0, 1, 2].includes(l)) continue
      结果[i - 1] = { 层级: l, 分: l * 10, 理由: String(项?.r || '').slice(0, 40) }
    }
    return { ok: true, 结果, 错误: '' }
  } catch (e) {
    return { ok: false, 结果: [], 错误: `请求失败：${e?.message || e}` }
  } finally {
    clearTimeout(计时器)
  }
}

/**
 * 批量模型分层。
 *
 * @param {Array<对象>} 消息们
 * @param {object} 配置 {baseURL, apiKey, model, timeoutMs, 额外参数}
 * @param {{批大小?:number, 批间隔毫秒?:number, 已处理?:Set<string>, 停止条件?:()=>boolean, 日志?:Function}} [选项]
 * @returns {Promise<{ok:boolean, 结果:Map<string,{层级:number,分:number,理由:string}>, 处理数:number, 跳过数:number, 失败批:number, 错误:string[]}>}
 */
export async function 模型分层 (消息们, 配置, 选项 = {}) {
  const 批大小 = Math.max(1, Math.min(Number(选项.批大小) || 默认批大小, 100))
  const 间隔 = Math.max(0, Number(选项.批间隔毫秒 ?? 默认批间隔毫秒))
  const 已处理 = 选项.已处理 instanceof Set ? 选项.已处理 : new Set()
  const 说 = typeof 选项.日志 === 'function' ? 选项.日志 : () => {}

  // 只处理没打过分的
  const 待办 = []
  let 跳过 = 0
  for (const m of Array.isArray(消息们) ? 消息们 : []) {
    const 指纹 = 消息指纹(m)
    if (已处理.has(指纹)) { 跳过 += 1; continue }
    待办.push({ 消息: m, 指纹 })
  }

  const 结果 = new Map()
  const 错误 = []
  let 失败批 = 0
  let 处理数 = 0

  for (let i = 0; i < 待办.length; i += 批大小) {
    if (typeof 选项.停止条件 === 'function' && 选项.停止条件()) {
      说('收到停止信号，提前结束')
      break
    }
    const 批 = 待办.slice(i, i + 批大小)
    const 批消息 = 批.map((x) => x.消息)
    let r = await 打一批(批消息, 配置)
    // 一次重试：模型偶发返回废文本很常见，但连续两次失败多半是配置或额度问题
    if (!r.ok) {
      说(`第 ${Math.floor(i / 批大小) + 1} 批失败，重试一次：${r.错误}`)
      await new Promise((res) => setTimeout(res, Math.max(间隔, 1500)))
      r = await 打一批(批消息, 配置)
    }
    if (r.ok) {
      for (let j = 0; j < 批.length; j++) {
        结果.set(批[j].指纹, r.结果[j])
      }
      处理数 += 批.length
      说(`第 ${Math.floor(i / 批大小) + 1} 批完成（${批.length} 条）`)
    } else {
      失败批 += 1
      错误.push(r.错误)
      说(`第 ${Math.floor(i / 批大小) + 1} 批放弃：${r.错误}`)
    }
    // 批间隔：免费模型有 RPM 限制，这是硬需求
    if (i + 批大小 < 待办.length) await new Promise((res) => setTimeout(res, 间隔))
  }

  return {
    ok: 失败批 === 0,
    结果,
    处理数,
    跳过数: 跳过,
    失败批,
    错误,
  }
}

/**
 * 合并规则分层与模型分层：模型有结果就用模型的，没有就用规则的。
 *
 * 为什么以模型为准：模型的语义判断比正则准。但模型可能漏项
 * （返回数组比输入短），漏的那些退回规则值，保证每条都有层级。
 *
 * @param {Array<对象>} 规则结果 带 指纹 和 层级 的数组
 * @param {Map<string, {层级:number}>} 模型结果
 * @returns {Array<对象>}
 */
export function 合并分层 (规则结果, 模型结果) {
  const 模型 = 模型结果 instanceof Map ? 模型结果 : new Map()
  return (Array.isArray(规则结果) ? 规则结果 : []).map((x) => {
    const m = 模型.get(x.指纹)
    if (m && Number.isFinite(m.层级)) {
      return { ...x, 层级: m.层级, 分: m.分, 理由: m.理由, 分层来源: 'model', 规则层级: x.层级 }
    }
    return { ...x, 理由: '', 分层来源: 'rule' }
  })
}

/** 三档常量导出，方便调用方不必再 import screen。 */
export { 分层 }
