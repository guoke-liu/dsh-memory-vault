// ============================================================================
// recall-event-extract.js —— 把事件段提炼成「起因 → 发生了什么 → 结果」
//
// 【设计前提：没有大模型也必须能用】
//
// 这是开源项目的硬约束。用户装完这个插件，不配任何 API、不花一分钱，
// 记忆检索必须完整可用 —— 包括事件提炼。
//
// 所以这里是两级实现：
//   · 规则提炼（默认，永远可用）：靠位置、句式、关键词从原文里挑句子。
//     产出的是「原文片段 + 归纳标签」，不是编造的文字。
//   · 模型提炼（可选增强）：把整段交给模型，写出更通顺的概括。
//
// 关键设计：**规则提炼永远先跑**，即使配了模型也先跑一遍。
// 原因是模型会失败（额度、网络、返回格式），失败时必须能退回规则结果，
// 而不是那个事件就没有内容了。
//
// 【规则提炼怎么挑句子】
//
// 一段对话里，信息分布是很不均匀的：
//   · 起因通常在开头 —— 提出问题的往往是最先说的话
//   · 结果通常在结尾 —— 「改好了」「搞定了」「那就这样」在最后
//   · 经过是所有中间的话
//
// 但这只是粗略规律，所以还要按「句式信号」加权：
//   带决定词（改成/说好/必须）的句子 → 更可能是结果
//   带问题词（怎么办/为什么/是不是）的句子 → 更可能是起因
//   带具体信息（数字/路径/URL）的句子 → 更可能是关键节点
//
// 挑出来的句子**保持原文**，不改写、不总结、不编造 ——
// 开源项目里，用户必须能一眼看出这句是从哪来的。
// ============================================================================

import { 是播报 } from './recall-events.js'

/** 决定 / 结论类信号：出现说明这句话往往是一个结论或约定。 */
const 结论词 = /说好|答应|决定|定了|以后|下次|记得|别忘|截止|提醒|必须|约定|改成|换成|修好|搞定|完成|解决|可以了|行了|就这样|认了|补完|弄好|处理完/

/** 问题 / 起因类信号：出现说明这句话往往在提出一个事。 */
const 问题词 = /怎么办|为什么|怎么会|是不是|能不能|要不要|有没有|出错|报错|失败|不对|不行|卡住|挂了|崩了|坏了|问题|异常/

/** 具体信息：数字、路径、URL、版本号 —— 事实的标志。 */
const 具体信息 = /\d|https?:\/\/|(?:[a-zA-Z]:)?[\\/][\w.-]+\.\w{1,5}/

/**
 * 「陪伴 / 情绪」类对话的特征。
 *
 * 为什么要这一类：实测 11-03 私聊里，凌晨那几段是纯粹的深夜陪聊 ——
 * 「好想你」「我也想你」「别哭呀」「我就在这儿」。
 * 这种对话**没有起因，也没有结果**，硬套「起因→经过→结果」只能编：
 * 起因填「宝宝」、结果填「那我陪你等一会儿」，看着像那么回事，其实毫无意义。
 *
 * 与其编一个假的，不如老实标成「陪伴」，检索时照样能按原文搜到。
 */
const 陪伴特征 = /想你|抱抱|抱|亲亲|乖|别哭|眼泪|睡吧|晚安|早安|累|心疼|陪你|在这儿|我都在|摸摸|宝宝/

/**
 * 判断这段更像「一件事」还是「一段陪伴」。
 *
 * @param {Array<object>} 消息们
 * @returns {{类型:'事情'|'陪伴', 依据:string}}
 */
export function 判断对话类型 (消息们) {
  const 全部 = Array.isArray(消息们) ? 消息们 : []
  if (全部.length === 0) return { 类型: '事情', 依据: '空段' }

  const 正文 = 全部.map((m) => String(m?.内容 || '')).join('')
  const 命中陪伴 = (正文.match(new RegExp(陪伴特征.source, 'g')) || []).length
  const 有结论 = 结论词.test(正文)
  const 有问题 = 问题词.test(正文)
  const 有具体 = 具体信息.test(正文)

  // 有明确结论、明确问题、或带具体信息 —— 这段在谈一件实事
  if (有结论 || 有问题 || 有具体) return { 类型: '事情', 依据: 有结论 ? '有结论' : 有具体 ? '有具体信息' : '有问题信号' }

  // 全文没有实事信号、却大量出现陪伴词 —— 判定为陪伴
  if (命中陪伴 >= 3) return { 类型: '陪伴', 依据: `无实事信号，陪伴词 ${命中陪伴} 处` }

  return { 类型: '事情', 依据: '默认按事情处理' }
}

/**
 * 一句话的「像不像关键句」分数。
 *
 * @param {string} 文本
 * @param {{位置?:number, 总条数?:number}} [上下文] 位置 0 表示第一句
 * @returns {number}
 */
/**
 * 纯寒暄句：只有称呼、应答、拟声，没有实际内容。
 *
 * 为什么要单列：「宝宝」「哎，在。」「晚安」这类句子在权重公式里
 * 因为长度和位置偶尔能拿到不错的分数，被选进「经过」——
 * 实测就出现过「经过：宝宝 / 经过：哎，在。」
 * 它们放进去只是占位置，让用户觉得提炼是随便填的。
 */
const 纯寒暄 = /^(宝宝|乖|抱+抱*|亲亲|摸摸|嗯+|哦+|啊+|呀+|好+的?|行+|对+|在+|我在|晚安|早安|早|睡吧|爱你|想你|我也想你|别哭|叫什么|在呢)[。！？~～…、\s]*$/

/**
 * 这句话是不是纯寒暄。
 * @param {string} 文本
 * @returns {boolean}
 */
export function 是寒暄 (文本) {
  const s = String(文本 ?? '').replace(/[（(][^）)]{0,40}[）)]/g, '').replace(/\s+/g, '').trim()
  if (!s) return true
  if (纯寒暄.test(s)) return true
  // 去掉称呼和句末语气后如果只剩语气词，也是寒暄。
  // 实测踩过：「乖宝宝在。」第一次没被认出来 —— 去掉「宝宝」剩「乖在。」
  // 三个字，刚好卡在旧的长度门槛外。现在按「去掉称呼后还有没有实词」判断。
  const 去称呼 = s.replace(/宝宝|小鱼儿|鱼鱼|亲爱的/g, '')
  const 去语气 = 去称呼.replace(/[。！？~～…、，,在呢呀哦啊]+$/g, '')
  if (去语气.length <= 2) return true
  // 整句很短且不含数字/英文/具体信息，也基本是寒暄
  if (s.length <= 6 && !/\d|[a-zA-Z]/.test(s)) return true
  return false
}

export function 句子权重 (文本, 上下文 = {}) {
  const s = String(文本 ?? '').trim()
  if (!s) return 0
  const 字数 = s.replace(/\s/g, '').length
  // 太短的句子没有信息量（「嗯」「好」「哈哈」）
  if (字数 < 4) return 0
  // 纯寒暄直接判 0：它不可能是起因、经过或结果
  if (是寒暄(s)) return 0

  let 分 = 0
  // 长度：4~80 字线性加分，过长不再加（长句不一定关键）
  分 += Math.min(字数, 80) / 80 * 0.3

  if (结论词.test(s)) 分 += 0.35
  if (问题词.test(s)) 分 += 0.3
  if (具体信息.test(s)) 分 += 0.2

  // 位置：第一句容易是起因，最后几句容易是结果
  const 位置 = Number(上下文.位置)
  const 总数 = Number(上下文.总条数)
  if (Number.isFinite(位置) && Number.isFinite(总数) && 总数 > 1) {
    if (位置 === 0) 分 += 0.15
    if (位置 >= 总数 - 2) 分 += 0.15
  }

  return Math.min(分, 1)
}

/**
 * 从事件段里按规则提炼起因 / 经过 / 结果。
 *
 * 产出里所有文字都是**原文**（可能截断），唯一「新写的」只有事件名，
 * 而事件名也是拿原文里的词拼的，不是编的。
 *
 * @param {{消息:Array<object>, 起?:string, 止?:string, 参与人?:Array<string>, 日期?:string}} 段
 * @param {{最多经过?:number, 单句上限?:number}} [选项]
 * @returns {{事件:string, 起因:string, 经过:Array<string>, 结果:string,
 *   参与人:Array<string>, 起:string, 止:string, 日期:string, 条数:number,
 *   提炼方式:string, 回查:Array<object>}}
 */
export function 规则提炼 (段, 选项 = {}) {
  const 最多经过 = Number.isFinite(Number(选项.最多经过)) ? Number(选项.最多经过) : 3
  const 单句上限 = Number.isFinite(Number(选项.单句上限)) ? Number(选项.单句上限) : 60

  const 全部 = (Array.isArray(段?.消息) ? 段.消息 : []).filter((m) => !是播报(m?.内容))
  const 切短 = (s) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > 单句上限 ? t.slice(0, 单句上限) + '…' : t
  }

  if (全部.length === 0) {
    return {
      事件: '', 起因: '', 经过: [], 结果: '',
      参与人: [], 起: 段?.起 || '', 止: 段?.止 || '', 日期: 段?.日期 || '',
      条数: 0, 提炼方式: '规则', 类型: '空', 回查: [],
    }
  }

  // ⚠️ 先判断这是「一件事」还是「一段陪伴」。
  // 陪伴类对话硬套起因/经过/结果只会编出看着像、其实没意义的字段。
  // 与其编，不如老实标出来 —— 检索时照样能按原文搜到，用户也知道该看原文。
  const 类型 = 判断对话类型(全部)
  if (类型.类型 === '陪伴') {
    // 陪伴类只给一个「这段在说什么」的摘要，不编起因和结果
    const 最长 = 全部.reduce((a, b) =>
      (String(b?.内容 || '').length > String(a?.内容 || '').length ? b : a), 全部[0])
    return {
      事件: 挑一句当摘要(最长?.内容, 全部),
      起因: '',           // 陪伴对话没有「起因」，留空比编一个诚实
      经过: 全部.slice(0, 2).map((m) => 切短(m.内容)),
      结果: '',           // 同样没有「结果」
      参与人: Array.isArray(段?.参与人) ? 段.参与人.slice() : [],
      起: String(段?.起 || ''),
      止: String(段?.止 || ''),
      日期: String(段?.日期 || 全部[0]?.日期 || ''),
      条数: 全部.length,
      提炼方式: '规则',
      类型: '陪伴',
      回查: 全部.map((m) => ({
        时间: String(m?.时间 || ''), 昵称: String(m?.昵称 || ''), pid: String(m?.pid || ''),
      })),
    }
  }

  // 每一句算权重
  const 带权 = 全部.map((m, i) => ({
    m,
    分: 句子权重(m.内容, { 位置: i, 总条数: 全部.length }),
    i,
  }))

  // ── 起因：第一句和「问题信号」里挑权重最高的 ──────────────────────
  //
  // 为什么不固定取第一句：有的段第一句是「宝宝」，真正的起因在第三句。
  // 拿第一句和所有带问题信号的句子一起比，谁更像起因用谁。
  // 起因/结果只在有实际内容的句子里挑（分 > 0.05）。
  // 整段都是寒暄时退回全段最高分那句 —— 总比空着强。
  const 有内容 = 带权.filter((x) => x.分 > 0.05)
  const 池子 = 有内容.length ? 有内容 : 带权
  const 起因候选 = 池子.filter((x) => x.i === 0 || 问题词.test(String(x.m.内容)))
  const 起因句 = (起因候选.length ? 起因候选 : 池子).reduce((a, b) => (b.分 > a.分 ? b : a))

  // ── 结果：带结论词的、靠后的句子里挑权重最高的 ────────────────────
  // 结果不能和起因是同一句 —— 实测出现过「起因：仓库一共收到 403 次」
  // 「结果：仓库一共收到 403 次」，同一句话填两个字段，读起来像程序出错
  const 结果候选 = 池子
    .filter((x) => x.i !== 起因句.i)
    .filter((x) => 结论词.test(String(x.m.内容)) || x.i >= 全部.length - 2)
  const 结果备用 = 池子.filter((x) => x.i !== 起因句.i)
  const 结果句 = (结果候选.length ? 结果候选 : (结果备用.length ? 结果备用 : 池子))
    .reduce((a, b) => (b.分 > a.分 ? b : a))

  // ── 经过：中间那些权重高的句子，按原文顺序 ────────────────────────
  //
  // 排除已经用掉的起因和结果，避免同一句话在三个字段里重复出现 ——
  // 重复出现会让用户觉得「这提炼是随便填的」。
  // ⚠️ 必须滤掉权重为 0 的句子（纯寒暄）。
  // 不滤的话「经过」里会出现「宝宝」「晚安，宝宝」——
  // 实测第一版就是这样，用户看到只觉得提炼在糊弄人。
  const 经过句 = 带权
    .filter((x) => x.i !== 起因句.i && x.i !== 结果句.i && x.分 > 0.05)
    .sort((a, b) => b.分 - a.分)
    .slice(0, 最多经过)
    .sort((a, b) => a.i - b.i)

  // ── 事件名：用原文里的关键词拼，不编造 ────────────────────────────
  const 事件 = 起个事件名(全部, 起因句.m, 结果句.m)

  // ── 回查坐标：每一条来源消息的定位信息 ───────────────────────────
  //
  // 不存原文（原文在 chat/*.txt 里已经有了），只存坐标。
  // 需要看原话时按坐标去捞，见 recall-events-store 的回查。
  const 回查 = 全部.map((m) => ({
    时间: String(m?.时间 || ''),
    昵称: String(m?.昵称 || ''),
    pid: String(m?.pid || ''),
  }))

  return {
    事件,
    起因: 切短(起因句.m.内容),
    经过: 经过句.map((x) => 切短(x.m.内容)),
    结果: 切短(结果句.m.内容),
    参与人: Array.isArray(段?.参与人) ? 段.参与人.slice() : [],
    起: String(段?.起 || ''),
    止: String(段?.止 || ''),
    日期: String(段?.日期 || 全部[0]?.日期 || ''),
    条数: 全部.length,
    提炼方式: '规则',
    类型: '事情',
    回查,
  }
}

/** 把一句话收拾成摘要：去旁白、去空白、截断 */
function 挑一句当摘要 (文本, 全部) {
  const s = String(文本 ?? '').replace(/^[（(][^）)]{0,40}[）)]\s*/, '').replace(/\s+/g, ' ').trim()
  if (s) return s.length > 40 ? s.slice(0, 40) + '…' : s
  const 首 = String(全部?.[0]?.内容 ?? '').replace(/\s+/g, ' ').trim()
  return 首.length > 40 ? 首.slice(0, 40) + '…' : (首 || '(未命名事件)')
}

/**
 * 起一个事件名（规则版）。
 *
 * 原则：事件名里的字必须来自原文，不做同义改写、不编造。
 * 做法是取「起因句 + 结果句」里最有辨识度的片段拼起来。
 *
 * 为什么不直接用第一句当名字：第一句常常是「宝宝」，
 * 拿它当事件名等于这个事件搜不到、也看不懂。
 *
 * @param {Array<object>} 全部
 * @param {object} 起因消息
 * @param {object} 结果消息
 * @returns {string}
 */
export function 起个事件名 (全部, 起因消息, 结果消息) {
  const 挑 = (t) => {
    const s = String(t ?? '').replace(/\s+/g, ' ').trim()
    // 去掉角色扮演的括号旁白：「（晃了晃尾巴，笑了一下）谁都眼熟…」
    const 去旁白 = s.replace(/^[（(][^）)]{0,40}[）)]\s*/, '')
    // 取第一个分句，最长 24 字
    const 首句 = 去旁白.split(/[。！？!?\n]/)[0].trim()
    return 首句.length > 24 ? 首句.slice(0, 24) : 首句
  }

  const a = 挑(起因消息?.内容)
  const b = 挑(结果消息?.内容)

  // 起因和结果开头一样，说明是同一句话，只用一次
  if (!b || a === b || b.startsWith(a)) return a || b || '(未命名事件)'
  if (!a) return b
  // 两个都在的话，用「起因 → 结果」的短形式，但别超过 48 字免得标题太长
  const 合 = `${a} → ${b}`
  return 合.length > 48 ? 合.slice(0, 48) + '…' : 合
}

/**
 * 把事件段交给模型提炼（可选增强）。
 *
 * 模型失败时**必须**能退回规则结果 —— 所以这个函数不抛错，
 * 失败就返回 ok:false，由调用方决定用不用规则结果。
 *
 * @param {object} 段 事件段
 * @param {{baseURL:string, apiKey:string, model:string, timeoutMs?:number, 温度?:number, 系统提示词?:string}} 配置
 * @param {{超时毫秒?:number, 日志?:Function}} [选项]
 * @returns {Promise<{ok:boolean, 事件?:object, 错误?:string}>}
 */
export async function 模型提炼 (段, 配置, 选项 = {}) {
  const 说 = typeof 选项.日志 === 'function' ? 选项.日志 : () => {}
  if (!配置 || !配置.baseURL || !配置.apiKey || !配置.model) {
    return { ok: false, 错误: '模型配置不完整' }
  }

  const 消息们 = (Array.isArray(段?.消息) ? 段.消息 : []).filter((m) => !是播报(m?.内容))
  if (消息们.length === 0) return { ok: false, 错误: '这段没有可提炼的内容' }

  // 送进去的是原文，带时间和发言人 —— 模型要靠这些判断谁在说什么
  const 正文 = 消息们
    .map((m, i) => `${i + 1}. [${m?.时间 || ''}] ${m?.昵称 || ''}：${m?.内容 || ''}`)
    .join('\n')

  const 系统 = String(配置.系统提示词 || '').trim() || [
    '你是一个记忆整理助手。下面是一段聊天记录，请把它整理成一件「事件」。',
    '要求：',
    '1. 只依据聊天内容，不要编造任何没出现过的信息',
    '2. 「起因」：这件事是怎么起来的',
    '3. 「经过」：中间发生了什么关键节点（1-3 条）',
    '4. 「结果」：最后是什么结果；如果没有明确结果，写「未解决」',
    '5. 「事件」：一句话概括，不超过 20 字，要能让人一眼看懂是什么事',
    '6. 只返回 JSON，不要任何解释文字，格式：',
    '{"事件":"...","起因":"...","经过":["..."],"结果":"..."}',
  ].join('\n')

  const 超时 = Number.isFinite(Number(选项.超时毫秒)) ? Number(选项.超时毫秒) : 60000
  const 控 = new AbortController()
  const 定时 = setTimeout(() => 控.abort(), 超时)
  try {
    const 请求体 = {
      model: 配置.model,
      messages: [
        { role: 'system', content: 系统 },
        { role: 'user', content: 正文 },
      ],
      temperature: Number.isFinite(Number(配置.温度)) ? Number(配置.温度) : 0.2,
      // 事件对象很小，给 800 足够；给太多反而容易让模型输出废话
      max_tokens: 800,
    }
    const 地址 = String(配置.baseURL).replace(/\/$/, '')
    const 回 = await fetch(String(配置.baseURL).includes('/chat/completions')
      ? 地址
      : `${地址}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${配置.apiKey}` },
      body: JSON.stringify(请求体),
      signal: 控.signal,
    })
    if (!回.ok) {
      const t = await 回.text().catch(() => '')
      return { ok: false, 错误: `HTTP ${回.status} ${t.slice(0, 120)}` }
    }
    const 数据 = await 回.json()
    const 文本 = 数据?.choices?.[0]?.message?.content
    if (typeof 文本 !== 'string' || !文本.trim()) return { ok: false, 错误: '模型没返回内容' }

    const 解出 = 解析事件JSON(文本)
    if (!解出.ok) return { ok: false, 错误: 解出.错误 }

    return {
      ok: true,
      事件: {
        ...解出.事件,
        参与人: Array.isArray(段?.参与人) ? 段.参与人.slice() : [],
        起: String(段?.起 || ''),
        止: String(段?.止 || ''),
        日期: String(段?.日期 || 消息们[0]?.日期 || ''),
        条数: 消息们.length,
        提炼方式: '模型',
        回查: 消息们.map((m) => ({
          时间: String(m?.时间 || ''),
          昵称: String(m?.昵称 || ''),
          pid: String(m?.pid || ''),
        })),
      },
    }
  } catch (e) {
    const msg = e?.name === 'AbortError' ? `超时（${超时}ms）` : String(e?.message || e)
    说(`模型提炼失败：${msg}`)
    return { ok: false, 错误: msg }
  } finally {
    clearTimeout(定时)
  }
}

/**
 * 从模型回复里解析事件 JSON。
 *
 * 模型经常不老实（会包 ```json、会加一句「好的，这是结果：」），
 * 所以这里按三种形态依次尝试。全部失败才报错 ——
 * 一次成功解析的容错，能省掉用户「明明是好的模型怎么一直失败」的困惑。
 *
 * @param {string} 文本
 * @returns {{ok:true, 事件:{事件:string,起因:string,经过:string[],结果:string}}|{ok:false, 错误:string}}
 */
export function 解析事件JSON (文本) {
  const s = String(文本 ?? '').trim()
  if (!s) return { ok: false, 错误: '空文本' }

  // 形态一：整段就是 JSON
  // 形态二：包在 ```json ... ``` 里
  // 形态三：前后有说明文字，取第一个 { 到最后一个 }
  const 候选 = [s]
  const 围栏 = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (围栏) 候选.push(围栏[1].trim())
  const 左 = s.indexOf('{')
  const 右 = s.lastIndexOf('}')
  if (左 >= 0 && 右 > 左) 候选.push(s.slice(左, 右 + 1))

  for (const 段 of 候选) {
    try {
      const o = JSON.parse(段)
      if (!o || typeof o !== 'object' || Array.isArray(o)) continue
      const 事件 = String(o.事件 ?? o.title ?? o.event ?? '').trim()
      const 起因 = String(o.起因 ?? o.cause ?? '').trim()
      const 结果 = String(o.结果 ?? o.result ?? '').trim()
      let 经过 = o.经过 ?? o.process ?? o.steps ?? []
      if (typeof 经过 === 'string') 经过 = [经过]
      经过 = (Array.isArray(经过) ? 经过 : [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .slice(0, 5)
      // 至少要有个事件名，否则这次提炼等于没产出
      if (!事件) continue
      return { ok: true, 事件: { 事件, 起因, 经过, 结果 } }
    } catch { /* 试下一种形态 */ }
  }
  return { ok: false, 错误: `解析不出事件 JSON（模型返回：${s.slice(0, 80)}）` }
}
