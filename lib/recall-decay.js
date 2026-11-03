// ============================================================================
// recall-decay.js —— 按「多久没被检索」自动降权的衰减机制
//
// 【这个模块负责什么】
//   给每条记忆算一个**衰减层级**（1..12）和一个**权重系数**（1.0..0.3）：
//     · 每满 1 个月没被检索 → 降一层
//     · 被检索过 → 立即回到第 1 层（权重最高）
//     · 降到第 12 层且再无检索 → 归档（移出索引，但名单留着可恢复）
//
// 【为什么这样设计】
//   · 为什么是独立维度而不是改现有三档：现有三档（核心/有用/闲聊）
//     回答的是「这条内容本身多重要」，衰减回答的是「这条多久没派上用场」。
//     两者合进一个数字后，就没法区分「重要但很久没用」和「不重要但刚说过」——
//     而这两种恰恰是最需要分开处理的。所以最终权重 = 重要度 × 衰减系数。
//
//   · 为什么衰减是线性的（每月降一层）而不是指数：指数衰减在早期掉得
//     太快 —— 一条两个月没用的技术决定会被压到几乎不可见，但它可能正是
//     一年后要查的东西。12 层每月一档的线性节奏更符合直觉，用户也能
//     精确预期「三个月没用会掉到什么程度」。
//
//   · 为什么被检索就**直接回满**而不是回升几层：命中说明它此刻有用。
//     让它慢慢爬回最高层，会出现「明明刚查过还是排不上」的问题 ——
//     用户刚验证过有用，系统却还按老账压着它，很难解释。
//
//   · 为什么按「天数/30」而不是按自然月：自然月的天数不等（28~31），
//     同一条记忆在不同月份会掉得不一样快，难以解释。30 天是稳定的近似。
//
//   · 为什么要落盘 lastHit：衰减必须跨进程、跨重启持续。放内存里
//     一重启就清零，等于永远不衰减。
//
// 【对外导出】
//   · 最大层 / 每月天数 / 归档层 —— 常量
//   · 天数差(时间串, 现在) —— 两个时间点差多少天
//   · 算衰减(条目记录, 现在) —— { 层级, 系数, 归档, 距上次天数 }
//   · 衰减系数表() —— 12 档系数数组
//   · 更新命中(索引, ids, 现在) —— 把被检索到的条目 lastHit 更新为现在
//   · 归档清理(索引, 现在) —— 分出 { 活跃, 归档 }
// ============================================================================

/** 层数上限。第 12 层之后就是归档。 */
export const 最大层 = 12

/** 每多少天降一层。30 天是稳定近似（自然月 28~31 天会掉得不一样快）。 */
export const 每月天数 = 30

/** 最低权重系数（第 12 层时的系数）。 */
export const 最低系数 = 0.3

/**
 * 12 档权重系数：第 1 层 1.0，第 12 层 0.3，线性递减。
 *
 * 为什么最低是 0.3 而不是 0：降到第 12 层还没归档时，它仍应**能被搜到**，
 * 只是排在很后面。系数为 0 等于软删除，用户偶尔想找老东西时
 * 会遇到「明明记得有，就是搜不到」，比直接归档还困惑。
 *
 * @returns {number[]}
 */
export function 衰减系数表 () {
  const 表 = []
  for (let 层 = 1; 层 <= 最大层; 层++) {
    const ratio = (层 - 1) / (最大层 - 1)
    表.push(Number((1 - (1 - 最低系数) * ratio).toFixed(3)))
  }
  return 表
}

/**
 * 两个时间点差多少天。认不出时间串时返回 Infinity（当作很久以前）。
 *
 * @param {string|number} 时间串 ISO 字符串或毫秒数
 * @param {number} 现在
 * @returns {number}
 */
export function 天数差 (时间串, 现在) {
  if (时间串 == null || 时间串 === '') return Infinity
  const t = typeof 时间串 === 'number' ? 时间串 : Date.parse(String(时间串))
  if (!Number.isFinite(t)) return Infinity
  const 毫秒 = Math.max(0, 现在 - t)
  return 毫秒 / 86400000
}

/**
 * 算一条记录的衰减。
 *
 * 「上次活跃时间」取 lastHit（最近一次被检索）和 created（入库时间）里较晚的：
 *   · 从没被检索过 → 从入库那一刻开始计时（而不是永远满权）
 *   · 被检索过 → 从最后一次命中重新计时
 *
 * @param {{lastHit?:string|number, created?:string|number}} 记录
 * @param {number} [现在]
 * @returns {{层级:number, 系数:number, 归档:boolean, 距上次天数:number}}
 */
export function 算衰减 (记录, 现在 = Date.now()) {
  // 参照时间按优先级取：
  //   lastHit —— 最近一次被检索（衰减的主依据）
  //   created —— 入库时间
  //   at / 日期 —— 日记条目的原始时间（索引条目用这个字段名）
  //
  // 漏掉 at 的后果实测过：所有日记条目判成「没有时间信息」→ 一律按最老
  // 处理 → 全部压到第 12 层，时效分从 1 掉到 0.3。测试立刻炸，但如果
  // 没测，表现会是「日记全排不上，聊天全排前面」——一个很难归因的现象。
  const 参照 = 较晚(较晚(记录?.lastHit, 记录?.created), 记录?.at || 记录?.日期)
  const 天 = 天数差(参照, 现在)
  if (!Number.isFinite(天)) {
    // 时间缺失：按最老处理。宁可让它沉底，也不要凭空给它满分 ——
    // 一条没有时间信息的记录，我们无从判断它新不新。
    return { 层级: 最大层, 系数: 最低系数, 归档: false, 距上次天数: Infinity }
  }
  const 降了几层 = Math.floor(天 / 每月天数)
  const 层 = Math.min(最大层, 1 + 降了几层)
  const 系数 = 衰减系数表()[层 - 1]
  return {
    层级: 层,
    系数,
    归档: 降了几层 >= 最大层,
    距上次天数: 天,
  }
}

/** 取两个时间串里较晚的那个（都能解析才算）。 */
function 较晚 (a, b) {
  const ta = typeof a === 'number' ? a : Date.parse(String(a ?? ''))
  const tb = typeof b === 'number' ? b : Date.parse(String(b ?? ''))
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta >= tb ? ta : tb
  if (Number.isFinite(ta)) return ta
  if (Number.isFinite(tb)) return tb
  return null
}

/**
 * 把被检索到的条目记一次命中（lastHit = 现在）。
 *
 * 为什么用「就地修改 + 返回改了哪些」而不是返回新对象：
 * 调用方拿着的是索引里的条目引用，改引用会让排序结果和索引脱节。
 *
 * @param {Array<{id?:string, lastHit?:string}>} 条目们
 * @param {string[]} ids 本次进了返回结果的条目 id
 * @param {number} [现在]
 * @returns {{改了几条:number, ids:string[]}}
 */
export function 更新命中 (条目们, ids, 现在 = Date.now()) {
  const 要改 = new Set((Array.isArray(ids) ? ids : []).map(String))
  const 改了 = []
  const 时刻 = new Date(现在).toISOString()
  for (const e of Array.isArray(条目们) ? 条目们 : []) {
    if (!e || !要改.has(String(e.id))) continue
    e.lastHit = 时刻
    改了.push(String(e.id))
  }
  return { 改了几条: 改了.length, ids: 改了 }
}

/**
 * 按衰减把条目分成「活跃」和「归档」。
 *
 * 归档 = 降满 12 层且之后再无命中。归档条目不进索引，但会被单独记进
 * 归档名单（调用方负责落盘），可以手动恢复 —— 直接删掉是不可逆的，
 * 「一条三年前有用过的话，现在真的一点价值都没有了吗」谁也答不上来。
 *
 * @param {Array<object>} 条目们
 * @param {number} [现在]
 * @returns {{活跃: object[], 归档: object[]}}
 */
export function 归档清理 (条目们, 现在 = Date.now()) {
  const 活跃 = []
  const 归档 = []
  for (const e of Array.isArray(条目们) ? 条目们 : []) {
    if (!e) continue
    const d = 算衰减(e, 现在)
    if (d.归档) 归档.push({ ...e, 衰减层: d.层级 })
    else 活跃.push(e)
  }
  return { 活跃, 归档 }
}

/**
 * 给检索结果附上衰减信息，并把「进了返回结果」记为命中。
 *
 * 这一步放在检索出口做，而不是在打分内部做，是因为：
 *   · 打分是纯函数（可重放、可测试），不该有副作用；
 *   · 「被检索」的判定标准是「进了返回结果」，只有出口知道哪些真的返回了。
 *
 * @param {Array<object>} 结果 检索返回的结果数组
 * @param {Array<object>} 索引条目 索引里的全部条目（会被就地更新 lastHit）
 * @param {number} [现在]
 * @returns {{更新:number}}
 */
export function 记命中 (结果, 索引条目, 现在 = Date.now()) {
  const ids = (Array.isArray(结果) ? 结果 : []).map((r) => r && r.id).filter(Boolean)
  return { 更新: 更新命中(索引条目, ids, 现在).改了几条 }
}
