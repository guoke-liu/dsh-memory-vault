// ============================================================================
// recall-fed.js —— 「哪些聊天已经喂过大模型」的账本
//
// 【这个模块负责什么】
//   记录每条聊天消息**是否真的送进过模型、模型有没有成功返回**，
//   并把这条消息算作哪个事件的成员。
//   下次要喂模型时，先查这本账 —— 已经喂过且成功的不会再喂，省掉重复的 token。
//
// 【为什么不能复用原来的「已处理」集合】
//   原来的 已处理 记的是「这条消息被规则分过层」—— 那几乎等于全部消息。
//   它有三个致命问题（2026-11-04 实测复现）：
//     1. 模型调用**失败**的那批也被记进去了。一次网络抖动，那批消息
//        就永远不会再送到模型面前 —— 数据永久丢失，而且不报任何错。
//     2. 它不区分「规则打的」和「模型打的」。用户后来配了模型，
//        想用模型重打一遍历史数据？做不到，全被标成已处理了。
//     3. 它不记「喂给模型时用的是什么内容」。档位从 core 改成 full 之后，
//        原本只被规则看过的消息依然被跳过。
//
//   新账本按 (指纹, 档位) 记账 —— 同一条消息在「只喂核心」和「全量喂」
//   两种档位下算两次投喂，因为送进去的内容确实不同。
//
// 【为什么不单独存一个文件】
//   账本跟分层库必须**同生同死**：分层库被清掉重建，账本却还记着
//   「这条喂过了」，就再也不会喂了。所以账本存在 chat-levels.json 里，
//   跟着分层库一起写。单独一个文件多一份丢同步的机会。
// ============================================================================

/**
 * 账本格式版本。结构变了就加一，读老版本时按空账本处理并给出提示，
 * 而不是崩掉或静默算错。
 */
export const 账本版本 = 1

/** 合法的档位名。和设置里的「事件提炼档位」是同一套词。 */
// 档位白名单。
//   full / screened / core —— 聊天分层投喂的三个档位（喂多少内容给模型）
//   '判断'               —— 事件层「这段值不值得记」的模型判断
//                           和上面三个不是一回事，单独一个桶，互不干扰
const 合法档位 = new Set(['full', 'screened', 'core', '判断'])

/**
 * 事件的身份键：来源 + 日期 + 事件名 + 起始时间。
 *
 * 为什么不用对象引用：事件在流水线里被复制过好几轮，
 * 用 Set<对象> 比较永远不相等（实测踩过：日志说保留了 1 段，结果 0 条）。
 *
 * 为什么不用下标或 id：事件每次重跑顺序可能变，只有内容才是稳定的。
 *
 * @param {object} e 事件
 * @returns {string}
 */
export function 事件身份 (e) {
  const 净 = (v) => String(v ?? '').replace(/\u0001/g, ' ')
  return [净(e?.来源), 净(e?.日期), 净(e?.事件), 净(e?.起)].join('\u0001')
}

/**
 * 从文件读账本；文件不存在或坏了返回空账本。
 *
 * 分层库的账本存在 chat-levels.json 里（跟分层库同生同死），
 * 事件层的账本单独一个文件 —— 两者身份键不同，混在一本账里会互相干扰。
 *
 * @param {string} 文件
 * @returns {Promise<{version:number, 按档位:Object}>}
 */
export async function 读账本文件 (文件) {
  if (!文件) return 空账本()
  try {
    const { readFile } = await import('node:fs/promises')
    const 原 = JSON.parse(await readFile(文件, 'utf8'))
    // ⚠️ 两种形状都要认：
    //   · 独立账本文件：整个文件就是账本本身 { version, 按档位 }
    //   · 嵌在分层库里：{ ..., 投喂账本: { version, 按档位 } }
    // 写账本() 写的是前者，读账本() 读的是后者 —— 对不上就会
    // 「写进去读不回来」，表现是每次都重花一次钱。实测踩过。
    if (原 && typeof 原 === 'object' && 原.按档位 && !原.投喂账本) {
      return 读账本({ 投喂账本: 原 })
    }
    return 读账本(原)
  } catch {
    // 文件还没生成 = 还没判过任何事件，这是正常情况
    return 空账本()
  }
}

/**
 * 把账本写到文件（权限 600，原子写）。
 * @param {string} 文件
 * @param {{version:number, 按档位:Object}} 账
 * @returns {Promise<{ok:boolean, 错误?:string}>}
 */
export async function 写账本 (文件, 账) {
  if (!文件) return { ok: false, 错误: '没有文件路径' }
  try {
    const { writeFile, rename, chmod, mkdir } = await import('node:fs/promises')
    const { dirname } = await import('node:path')
    await mkdir(dirname(文件), { recursive: true })
    const 临时 = `${文件}.tmp-${process.pid}`
    await writeFile(临时, JSON.stringify(账), 'utf8')
    try { await chmod(临时, 0o600) } catch { /* 某些文件系统不支持 */ }
    await rename(临时, 文件)
    return { ok: true }
  } catch (e) {
    return { ok: false, 错误: String(e?.message || e) }
  }
}

/**
 * 归一化档位名：去掉空白、统一小写。
 *
 * ⚠️ 非法值必须报错，不能静默回退到某一档。
 *
 * 这里本来写的是「不认识就当 screened 处理」，看起来更"稳"，
 * 但和 2026-11-04 修的「空阈值被当成 0」是同一类错误：
 * 把非法输入悄悄解释成一个合法值，账单记到错误的桶里，
 * 用户看到的是「明明喂过了怎么又花钱」，而且不报任何错。
 *
 * 调用方要么传对，要么立刻知道传错了。
 *
 * @param {string} 档
 * @returns {string}
 * @throws {Error} 档位名不合法时
 */
export function 归一档位 (档) {
  const s = String(档 ?? '').trim().toLowerCase()
  if (!合法档位.has(s)) {
    throw new Error(`投喂账本：未知档位 ${JSON.stringify(档)}，只认 ${[...合法档位].join(' / ')}`)
  }
  return s
}

/**
 * 造一本空账本。
 * @returns {{version:number, 按档位:Object<string, Object<string, {at:string, 事件?:string}>>}}
 */
export function 空账本 () {
  const 按档位 = {}
  for (const d of 合法档位) 按档位[d] = {}
  return { version: 账本版本, 按档位 }
}

/**
 * 从分层库内容里读出账本；没有或格式不对就返回空账本。
 *
 * 老的分层库没有这个字段（版本 1.5.1 之前），读出来是空账本 ——
 * 表现就是「还没喂过任何模型」，下次喂模型时全量喂一遍。
 * 这对老用户是安全的：多花一次钱，但不会丢数据。
 *
 * @param {object} 库 读出来的 chat-levels.json 内容
 * @returns {{version:number, 按档位:Object}}
 */
export function 读账本 (库) {
  const 源 = 库 && typeof 库 === 'object' ? 库.投喂账本 : null
  if (!源 || typeof 源 !== 'object' || !源.按档位 || typeof 源.按档位 !== 'object') return 空账本()
  const 出 = 空账本()
  for (const 档 of Object.keys(出.按档位)) {
    const m = 源.按档位[档]
    if (m && typeof m === 'object' && !Array.isArray(m)) 出.按档位[档] = { ...m }
  }
  return 出
}

/**
 * 取一条记账里存的判断结论。
 *
 * @param {{按档位:Object}} 账
 * @param {string} 指纹
 * @param {string} 档
 * @returns {boolean|null} true=值得记、false=闲聊；没记过或没存结论返回 null
 */
export function 取结论 (账, 指纹, 档) {
  if (!账 || !账.按档位 || !指纹) return null
  const 桶 = 账.按档位[归一档位(档)]
  const 条 = 桶 && 桶[String(指纹)]
  return 条 && typeof 条.值得记 === 'boolean' ? 条.值得记 : null
}

/**
 * 这条消息在某个档位下喂过模型了没有。
 *
 * @param {{按档位:Object}} 账 读账本() 的结果
 * @param {string} 指纹 消息指纹
 * @param {string} 档 档位名
 * @returns {boolean}
 */
export function 已投喂 (账, 指纹, 档) {
  if (!账 || !账.按档位 || !指纹) return false
  const 桶 = 账.按档位[归一档位(档)]
  return !!(桶 && Object.hasOwn(桶, String(指纹)))
}

/**
 * 记一笔「这条喂过模型了」。
 *
 * ⚠️ 只能在模型**成功返回**之后调用。
 * 失败也记的话，那批消息就永远不会再被送到模型面前 ——
 * 一次网络抖动等于永久丢数据，而且不报错。这是原「已处理」集合的致命问题。
 *
 * @param {{按档位:Object}} 账 会被就地修改
 * @param {string} 指纹
 * @param {string} 档
 * @param {{时间?:string, 事件?:string}} [额外] 记录时间戳，可选关联到某个事件名
 */
export function 记投喂 (账, 指纹, 档, 额外 = {}) {
  if (!账 || !指纹) return
  if (!账.按档位) 账.按档位 = {}
  const 名 = 归一档位(档)
  if (!账.按档位[名] || typeof 账.按档位[名] !== 'object') 账.按档位[名] = {}
  const 条 = { at: 额外.时间 || new Date().toISOString() }
  // 事件名可选：记一笔「这条消息属于哪个事件」
  if (额外.事件) 条.事件 = String(额外.事件)
  // 判断结论：true=值得记、false=闲聊。
  // 存它是为了让重跑时不花钱也能还原去留 —— 只记「判过」不记「判成什么」，
  // 重跑时那些事件会凭空消失（实测踩过：事件数从 1 变 0）。
  if (typeof 额外.值得记 === 'boolean') 条.值得记 = 额外.值得记
  账.按档位[名][String(指纹)] = 条
}

/**
 * 批量记投喂 —— 一批成功后一次性全记上，避免逐条写的时候漏掉一半。
 *
 * @param {{按档位:Object}} 账
 * @param {Array<string>} 指纹们
 * @param {string} 档
 * @param {{时间?:string, 事件?:string}} [额外]
 * @returns {number} 实际新记了几条（已经记过的不算）
 */
export function 批量记投喂 (账, 指纹们, 档, 额外 = {}) {
  const 名 = 归一档位(档)
  let 新增 = 0
  for (const f of Array.isArray(指纹们) ? 指纹们 : []) {
    if (!f) continue
    if (已投喂(账, f, 名)) continue
    记投喂(账, f, 名, 额外)
    新增 += 1
  }
  return 新增
}

/**
 * 从候选里挑出「还没在这个档位下喂过模型」的。
 *
 * 这是省钱的关键入口：所有要送模型的地方都先过一遍这个函数。
 *
 * @param {{按档位:Object}} 账
 * @param {Array<{指纹:string}>} 候选
 * @param {string} 档
 * @returns {{待投喂:Array, 已喂过:number}}
 */
export function 筛出未投喂 (账, 候选, 档) {
  const 待投喂 = []
  let 已喂过 = 0
  for (const x of Array.isArray(候选) ? 候选 : []) {
    if (已投喂(账, x?.指纹, 档)) { 已喂过 += 1; continue }
    待投喂.push(x)
  }
  return { 待投喂, 已喂过 }
}

/**
 * 账本的统计信息 —— 给工具层显示「省了多少」用。
 *
 * 只说「记了多少条」没用，用户想知道的是「还有多少没喂、这个档位下喂过多少」。
 *
 * @param {{按档位:Object}} 账
 * @returns {{按档位:Object<string, number>, 合计:number}}
 */
export function 账本统计 (账) {
  const 按档位 = {}
  let 合计 = 0
  for (const 档 of 合法档位) {
    const 桶 = 账?.按档位?.[档] || {}
    const n = Object.keys(桶).length
    按档位[档] = n
    合计 += n
  }
  return { 按档位, 合计 }
}

/**
 * 修剪账本：只保留仍然存在的消息的记账。
 *
 * 为什么要修剪：分层库有容量上限（5 万条），淘汰掉的闲聊如果账本里还留着，
 * 账本会无限长下去 —— 而且那些指纹对应的消息已经不在库里了，留着没有意义。
 * 更糟的是：以后同一条消息被重新处理（比如人工恢复了那条聊天），
 * 会因为账本里还记着而被跳过。
 *
 * @param {{按档位:Object}} 账
 * @param {Set<string>|Array<string>} 存活指纹 还应该保留的指纹集合
 * @returns {{删除:number}}
 */
export function 修剪账本 (账, 存活指纹) {
  const 集 = 存活指纹 instanceof Set ? 存活指纹 : new Set(Array.isArray(存活指纹) ? 存活指纹 : [])
  if (!账 || !账.按档位) return { 删除: 0 }
  let 删除 = 0
  for (const 档 of Object.keys(账.按档位)) {
    const 桶 = 账.按档位[档]
    if (!桶 || typeof 桶 !== 'object') continue
    for (const 指纹 of Object.keys(桶)) {
      if (!集.has(指纹)) { delete 桶[指纹]; 删除 += 1 }
    }
  }
  return { 删除 }
}

/**
 * 扣账：把一批指纹从账本里抹掉，让它们下次重新被投喂。
 *
 * 【为什么必须走这里，而不是「临时绕开账本」】
 *   绕过账本（比如传一个 force 标志让 已投喂判断 恒返回 false）看着更简单，
 *   但它有个致命后果：那些消息**永远不会被记为已投喂**。
 *   于是每跑一次分层就重花一次钱，账本上还一条记录都没有 ——
 *   用户根本查不出钱花在哪。这是本模块存在的意义，不能被绕开。
 *
 *   正确做法就是扣账：先抹掉记录，再正常跑。这样重新投喂成功的消息
 *   会被重新记上，失败的不会被记 —— 和第一次投喂完全同一套规则。
 *
 * 【为什么按日期范围扣，而不是按「全清」】
 *   用户说「某天投喂不满意」，要重来的是那一天。
 *   全清会把所有日期的记账一起抹掉，下次跑分层等于全量重喂 ——
 *   那是几百倍的意外开销，而且用户以为自己只重喂了一天。
 *
 * @param {{按档位:Object}} 账 会被就地修改
 * @param {Array<string>} 指纹们 要扣掉的指纹
 * @param {string} 档 只扣这个档位的记录（其他档位不动）
 * @returns {{扣掉:number}}
 */
export function 扣账 (账, 指纹们, 档) {
  if (!账 || !账.按档位) return { 扣掉: 0 }
  const 名 = 归一档位(档)
  const 桶 = 账.按档位[名]
  if (!桶 || typeof 桶 !== 'object') return { 扣掉: 0 }
  let 扣掉 = 0
  for (const f of Array.isArray(指纹们) ? 指纹们 : []) {
    if (f && Object.hasOwn(桶, String(f))) { delete 桶[String(f)]; 扣掉 += 1 }
  }
  return { 扣掉 }
}

/**
 * 按日期范围扣账 —— 用户「对某天不满意，想重来」的入口。
 *
 * 为什么要一个专门函数：调用方手里是「日期」，账本里存的是「指纹」。
 * 这中间的映射（指纹 → 是哪天的消息）只有本模块之外的调用方知道
 * （要靠消息本身算指纹），所以这里接收「已经筛好的指纹列表 + 档位」，
 * 而不是日期字符串 —— 免得两处各写一套日期格式判断，迟早对不上。
 *
 * @param {{按档位:Object}} 账
 * @param {Array<string>} 指纹们 该日期范围内、要重新投喂的消息指纹
 * @param {string} 档
 * @returns {{扣掉:number}}
 */
export function 按日期扣账 (账, 指纹们, 档) {
  return 扣账(账, 指纹们, 档)
}

/**
 * 把「日期范围」解析成能比较的起止边界。
 *
 * 支持三种写法，用户爱怎么填怎么填：
 *   · 单日            '2026-11-03'        → 起=止=2026-11-03
 *   · 闭区间          '2026-11-01..11-03' → 起=2026-11-01 止=2026-11-03
 *   · 带空格的区间    '2026-11-01 ~ 2026-11-03'
 *
 * ⚠️ 不认识的写法必须报错，不能猜。
 * 猜错方向的后果非常实在：「重喂 2026-11-03」被解析成年初到现在，
 * 用户以为只花一天的钱，实际把整个库重喂了一遍。
 *
 * @param {string} 原文
 * @returns {{起:string, 止:string, 是区间:boolean}}
 * @throws {Error} 格式不认识时
 */
export function 解析日期范围 (原文) {
  const s = String(原文 ?? '').trim()
  if (!s) throw new Error('需要指定日期，例如 2026-11-03 或 2026-11-01..2026-11-03')

  const 日期正则 = /^\d{4}-\d{2}-\d{2}$/
  const 验一个 = (d) => {
    if (!日期正则.test(d)) return null
    // 还要验「是不是真的存在这一天」—— 2026-02-30 格式对但不存在，
    // 静默接受会变成一个空区间，用户以为重喂了却什么都没发生
    const t = new Date(`${d}T00:00:00Z`)
    if (Number.isNaN(t.getTime())) return null
    return t.toISOString().slice(0, 10) === d ? d : null
  }

  // 先看形状对不对，再判断日子存不存在 —— 两种情况给不同的错。
  //
  // 都报「看不懂的日期写法」的话，用户会以为自己格式写错了，
  // 反复改格式却永远改不对（2026-02-30 格式完全正确，只是没有这一天）。
  const 形状对 = 日期正则.test(s) || /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|~|至|到)\s*(\d{4}-\d{2}-\d{2})$/.test(s)

  const 单日 = 验一个(s)
  if (单日) return { 起: 单日, 止: 单日, 是区间: false }
  if (日期正则.test(s) && !单日) {
    throw new Error(`日期不存在：${s}（格式对，但没有这一天）`)
  }

  // 区间：用 .. 或 ~ 或 ~ 分隔，两侧允许空白
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|~|至|到)\s*(\d{4}-\d{2}-\d{2})$/)
  if (m) {
    const 起 = 验一个(m[1])
    const 止 = 验一个(m[2])
    if (!起) throw new Error(`起始日期不存在：${m[1]}`)
    if (!止) throw new Error(`结束日期不存在：${m[2]}`)
    if (起 > 止) throw new Error(`起始日期晚于结束日期：${起} > ${止}`)
    return { 起, 止, 是区间: true }
  }

  if (形状对) throw new Error(`日期不存在：${s}（格式对，但没有这一天）`)
  throw new Error(`看不懂的日期写法：${JSON.stringify(s)}（支持 2026-11-03 或 2026-11-01..2026-11-03）`)
}

/**
 * 判断一个日期是否落在范围内。
 * @param {string} 日期 YYYY-MM-DD
 * @param {{起:string, 止:string}} 范围
 * @returns {boolean}
 */
export function 日期在范围内 (日期, 范围) {
  if (!范围 || !日期) return false
  const d = String(日期)
  return d >= 范围.起 && d <= 范围.止
}
