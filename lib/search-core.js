// ============================================================================
// search-core.js —— 检索核心：切词 + 打分
//
// 机械重构：从 lib/tools.js 原样抽出，函数体一字未改。
// lib/tools.js 从这里导入复用（并再导出，保持旧入口可用）。
// ============================================================================

/**
 * 极简中文分词：标点/空白切开后，对连续汉字做 2 字滑窗。
 *
 * 为什么不引入 jieba：开源版要零依赖。2 字滑窗够用 ——
 * 搜「猫」能命中「橘猫」，搜「服务」能命中「服务器」。
 *
 * @param {string} text
 * @returns {string[]} 去重后的词表
 *
 * 例：切词('腾讯云轻量服务器') → ['腾讯','讯云','云轻','轻量','量服','服务','务器']
 */
export function 切词(text) {
  const 串 = String(text || '').toLowerCase()
  const 词 = new Set()
  // 英文/数字整词
  for (const m of 串.matchAll(/[a-z0-9]{2,}/g)) 词.add(m[0])
  // 连续汉字段
  for (const m of 串.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const s = m[0]
    if (s.length <= 2) { 词.add(s); continue }
    for (let i = 0; i + 2 <= s.length; i++) 词.add(s.slice(i, i + 2))
  }
  return [...词]
}

/** 给一条记录按查询词打分 */
export function 打分(记录文本, 查询词) {
  const 文中 = String(记录文本 || '').toLowerCase()
  let 分 = 0
  for (const w of 查询词) {
    if (文中.includes(w)) 分 += w.length >= 2 ? 2 : 1
  }
  return 分
}
