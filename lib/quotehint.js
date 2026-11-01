// ============================================================================
// quotehint.js —— 「最近被引用的图」提示器
//
// 【为什么有这个文件】
//   qq-bridge 遇到引用消息只往正文写一句 `[引用了一条消息]`，被引用的图完全不传，
//   鱼就说「还是什么都没有」。这个模块自己拉群消息、反查被引用的原图、
//   用描述器生成说明，再通过 systemPrompt.context 注入给她。
//
// 【改这个文件前先知道】
//   · 用 systemPrompt.**context** 不是 section —— section 会改系统提示词，
//     导致整段 prompt 缓存失效（实测贵 20 倍）
//   · get_msg 结果要取 `.data`，否则拿不到图段
//   · 只保留最近 3 条，没有引用时 当前文本() 返回空串（宿主就不追加）
// ============================================================================

// 「最近被引用的图」提示器。
//
// 背景：QQ 机器人「鱼」通过 qq-bridge 收消息，引用消息里被引用的图完全传不过来
// （正文只留一句「[引用了一条消息]」）。但 OneBot 侧其实能拿到完整引用关系：
// 群消息里的 {type:'reply', data:{id}} 段可以反查 get_msg 取回原消息。
// 这里定时把「最近被引用过的图片」的描述攒起来，用宿主 systemPrompt.context()
// 追加到对话末尾（**不用 section** —— section 进系统提示词会让整段 prompt
// 缓存失效，实测贵 20 倍；context 只追加、且只在内容变了才追加）。
//
// 硬性约定（同 onebot.js / describer.js）：
//   - 零第三方依赖
//   - 所有异常吞掉并记日志，绝不把宿主拖崩
//   - 没引用图时 当前文本() 返回空串，宿主就不会追加任何东西
//   - 首次刷新完成前 当前文本() 也返回 ''（避免「没刷过就当没数据」的假象）

import { extractImages, extractReplyId, fetchImageBytes } from './onebot.js'
import { createDescriber } from './describer.js'

const 保留条数 = 3

function 格式时间(ts) {
  try {
    const t = Number(ts)
    if (!Number.isFinite(t)) return null
    const d = new Date(t * 1000)
    if (isNaN(d.getTime())) return null
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  } catch {
    return null
  }
}

/**
 * 创建引用提示器。
 *
 * @param {object} opts
 * @param {object} opts.onebot      createOneBot() 的返回值（含 call / getRecentGroupMessages）
 * @param {string|number} [opts.群号]  要监控的群号（多群在 index.js 侧展开，每群一个实例）
 * @param {(message:object)=>string|null} [opts.取引用id]  缺省用 onebot.js 的 extractReplyId
 * @param {Function} [opts.日志]    留痕用（缺省静默）
 * @returns {{刷新(): Promise<void>, 当前文本(): string, 停(): void}}
 *   刷新()     —— 拉最近群消息，找被引用的图片，取字节、生成描述，缓存在内存（只留最近 3 条）
 *   当前文本() —— 同步返回给模型看的一段文字；没有引用图、或还没刷过，都返回 ''
 *   停()       —— 清理内存，之后调用全部安全
 */
export function 造引用提示(opts = {}) {
  const onebot = opts.onebot
  const 群号 = opts.群号
  const 取引用id = typeof opts.取引用id === 'function' ? opts.取引用id : extractReplyId
  const 日志 = typeof opts.日志 === 'function' ? opts.日志 : () => {}
  // 允许外部传描述器（比如挂了视觉模型的），没传就用默认的元信息描述器
  const 描述器 = opts.描述器 || createDescriber({})
  let 最近 = []        // 内存里只留最近 3 条：{ 引用消息id, 被引用id, 原图描述, 时间 }
  let 已停 = false
  let 在途 = null      // 正在跑的那次刷新（合并并发调用）
  let 刷过 = false

  async function 刷一次() {
    if (已停) return
    if (在途) { await 在途; return }   // 已有一次在跑，等它跑完就好（避免并发双拉）
    const 本次 = (async () => {
      try {
        let 消息们 = []
        try {
          if (onebot && typeof onebot.getRecentGroupMessages === 'function' && 群号 != null) {
            消息们 = (await onebot.getRecentGroupMessages(群号)) || []
          }
        } catch (e) {
          日志('拉群消息失败: ' + (e?.message || e))
          return
        }
        if (!Array.isArray(消息们) || 消息们.length === 0) {
          最近 = []     // 这个群确实没有消息：清空缓存（而不是留着旧的）
          return
        }

        const 候选 = []
        for (const m of 消息们) {
          let 被引用id = null
          try { 被引用id = 取引用id(m) } catch { 被引用id = null }
          if (!被引用id) continue
          if (!onebot || typeof onebot.call !== 'function') continue
          let 原消息
          try { 原消息 = await onebot.call('get_msg', { message_id: 被引用id }) }
          catch { continue }                        // get_msg 抛错：跳过这条，不崩
          // ⚠️ OneBot 的响应是 {status, retcode, data:{...}} 包装过的。
          //    以前直接把整包当消息对象传给 extractImages，永远拿不到图段（实测返回空）。
          if (原消息 && typeof 原消息 === 'object' && 原消息.data && typeof 原消息.data === 'object') {
            原消息 = 原消息.data
          }
          let 图段
          try { 图段 = extractImages(原消息) || [] } catch { continue }
          if (!图段.length) continue                 // 被引用的是文字（或无 image 段），忽略
          for (const seg of 图段) {
            let bytes = null
            try { bytes = await fetchImageBytes(seg) } catch { bytes = null }
            if (!bytes) continue                    // 字节没取到（比如 url 失效）：这条没法描述
            let 描述
            try { 描述 = await 描述器.describe(bytes, { 被引用id }) }
            catch { 描述 = '一张图（描述失败）' }
            let 时间 = null
            try { 时间 = 原消息.time ?? m.time ?? null } catch { 时间 = null }
            候选.push({
              引用消息id: String(m.message_id ?? m.messageId ?? ''),
              被引用id,
              原图描述: 描述,
              时间: 时间 != null ? 格式时间(时间) : null,
            })
          }
        }
        // 拉取成功但这次没有引用图：清掉旧缓存（引用图是「最近」的概念，30 秒后没人引用就该消失）
        最近 = 候选.slice(-保留条数)
        if (候选.length) 日志(`引用图刷新：${候选.length} 条候选，保留最近 ${最近.length} 条`)
      } catch (e) {
        日志('刷新引用图异常: ' + (e?.message || e))
      } finally {
        刷过 = true
      }
    })()
    在途 = 本次
    try { await 本次 } catch {}
    finally { 在途 = null }
  }

  function 当前文本() {
    if (!刷过 || 已停) return ''
    if (!最近.length) return ''
    const 行 = 最近.map((x) => {
      const 时 = x.时间 ? `，时间 ${x.时间}` : ''
      const 后 = `（消息 ${x.被引用id || '未知'}${x.引用消息id ? '，被引用消息 ' + x.引用消息id : ''}${时}）`
      return `- 引用了一张图：${x.原图描述} ${后}`
    })
    return [
      '【引用图】',
      '有人引用了图片，你本身看不到图，但这些信息能帮你回应：',
      ...行,
      '如果真的需要看清内容，可以让对方单独发一张。',
    ].join('\n')
  }

  function 停() {
    if (已停) return
    已停 = true
    最近 = []
    刷过 = true
    日志('引用提示器已停')
  }

  // 创建时立即刷一次（失败静默；timer 还会接着每 30 秒刷）
  刷一次().catch(() => {})

  return {
    刷新: 刷一次,
    当前文本,
    停,
  }
}
