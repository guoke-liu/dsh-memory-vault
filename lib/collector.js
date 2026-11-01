// ============================================================================
// collector.js —— 采集器（唯一会把 QQ 消息写进库的地方）
//
// 【改这个文件前先知道】
//   · 所有「该不该记」的判断都在这里：记私聊/记群聊/存图模式，别在别处重复判断
//   · settings 每轮重新读一次，所以设置页改了开关**不用重启**就生效
//   · 私聊走 sync()：收图 + 记聊天；群聊走 syncGroup()：只记聊天（群图默认不收）
//   · 同一个 messageId 只算一次引用，靠存储层判断（不是靠内存 Set）
// ============================================================================

// 采集器：把 OneBot 客户端和档案库接起来 —— 轮询主人私聊，发现新图就入库。
//
// 这一层是"缝合层"，本身不碰网络细节也不碰存储细节，方便单测。
// 并发保护：同一时刻只允许一个 sync 在跑，避免两次并发归档互相覆盖索引。

import { archiveImage, initArchive } from './archive.js'
import { 按模式归档 } from './mode.js'
import { createDescriber } from './describer.js'
import { extractImages, extractReplyId, fetchImageBytes } from './onebot.js'
import { 记住人, 记一次引用 } from './people.js'
import { 追加一条 } from './chatlog.js'
import { 解析引用, 记引用关系 } from './reply.js'

/**
 * 建一个采集器。
 * @param {object} opts
 * @param {object} opts.onebot   createOneBot() 的返回值
 * @param {string} opts.rootDir  档案库根目录
 * @param {string|number} opts.userId  主人 QQ 号（只收这个人的私聊）
 * @param {(msg:string)=>void} [opts.log]
 */
/**
 * 造一个采集器：定时把 QQ 里的消息拉进来，写进库。
 *
 * @param {object} opts
 * @param {object} opts.onebot    createOneBot() 的返回值
 * @param {string} opts.rootDir   库根目录
 * @param {string} [opts.userId]  私聊对象（主人 QQ）
 * @param {Function} [opts.log]
 * @param {object} [opts.settings] 设置对象 —— **每轮都重新读**，改开关不用重启
 * @param {Function} [opts.describer] 自定义描述器（挂了视觉模型时传，见 index.js）
 * @returns {{sync, syncGroup, __resetSeen, __seenCount}}
 *   sync()           拉私聊：收图 + 记聊天
 *   syncGroup(群号)   拉某个群：只记聊天（群图默认不收）
 *
 * ⚠️ 采集器是**唯一**会把外部数据写进库的路径（除了 ingest 路由）。
 *    任何「该不该记」的判断（开关、模式）都在这条链上做，别在别处重复判断。
 */
export function createCollector({ onebot, rootDir, userId, log, settings, describer }) {
  const 说 = typeof log === 'function' ? log : () => {}
  // 描述器：没看图模型时自动降级成元信息描述（格式+尺寸+大小）
  const 描述器 = describer || createDescriber({})
  // 已处理过的 message_id，避免重复入库（重复入库虽不会多存图，但会让引用次数虚高）
  const 已见 = new Set()
  let 在跑 = false
  let 最后序号

  /**
   * 把一条消息的文字部分写进聊天记录（一天一个文件，私聊群聊分开）。
   * 图片、表情等非文字段这里不处理。
   */
  async function 记聊天文本(msg, chatType, groupId) {
    try {
      // 设置页的「记私聊聊天 / 记群聊聊天」开关：关了就不写
      if (settings && typeof settings.read === 'function') {
        const c = await settings.read()
        if (chatType === 'private' && c['记私聊聊天'] === false) return false
        if (chatType === 'group' && c['记群聊聊天'] === false) return false
      }
      const 段们 = Array.isArray(msg.message) ? msg.message : []
      const 文本 = 段们
        .filter((x) => x && x.type === 'text' && typeof x.data?.text === 'string')
        .map((x) => x.data.text)
        .join(' ')
        .trim()
      if (!文本) return false
      // 群里优先用群名片（card），私聊用昵称；有些人 QQ 昵称就是 '-' 之类，
      // 但群名片是有意义的（例如「乌鸡麻黑」）。
      const 发送者 = msg.sender || {}
      const 显示名 = (chatType === 'group' && 发送者.card) ? 发送者.card : (发送者.nickname || '')
      const { pid } = await 记住人(rootDir, {
        userId: msg.user_id ?? userId,
        nickname: 显示名,
      })
      const r = await 追加一条(rootDir, {
        chatType,
        groupId,
        timeMs: msg.time ? Number(msg.time) * 1000 : Date.now(),
        nickname: 显示名,
        pid,
        messageId: msg.message_id ?? msg.messageId ?? `${msg.time}-${文本.slice(0, 16)}`,
        text: 文本,
      })
      if (r && r.appended) 说(`聊天记录 +1（${chatType}${groupId ? '/' + groupId : ''}）`)
      return !!(r && r.appended)
    } catch (e) {
      说('写聊天记录失败: ' + (e?.message || e))
      return false
    }
  }

  /** 处理一条消息，返回本次新归档的条目 */
  async function 处理一条(msg, 上下文 = {}) {
    const 出 = []
    const { chatType = 'private', groupId = null } = 上下文
    // 先记文字（无论有没有图都记）
    await 记聊天文本(msg, chatType, groupId)
    const mid = msg.message_id ?? msg.messageId
    if (mid != null) {
      if (已见.has(String(mid))) return 出
      已见.add(String(mid))
      // 只留最近 2000 个，防内存无限涨
      if (已见.size > 2000) {
        const 前几个 = [...已见].slice(0, 1000)
        for (const k of 前几个) 已见.delete(k)
      }
    }
    for (const seg of extractImages(msg)) {
      let bytes = null
      try {
        bytes = await fetchImageBytes(seg)
      } catch (e) {
        说('取图失败: ' + (e?.message || e))
      }
      if (!bytes || !bytes.length) { 说('跳过一张取不到字节的图'); continue }
      try {
        // 先把「谁」换成编号，图片引用里只写编号
        const { pid } = await 记住人(rootDir, {
          userId: msg.user_id ?? userId,
          nickname: msg.sender && msg.sender.nickname,
        })
        // ⚠️ 必须走「按模式归档」，不能直接调 archiveImage ——
        //    直接调会绕过存图模式，text 模式下原图照样落盘。
        let 模式 = 'both'
        try {
          if (settings && typeof settings.read === 'function') {
            const cfg = await settings.read()
            模式 = cfg && cfg.存图模式 ? cfg.存图模式 : 'both'
          }
        } catch {}
        const r = await 按模式归档(rootDir, {
          bytes,
          mode: 模式,
          description: '',
          describer: 描述器,
          meta: {
            messageId: mid != null ? String(mid) : undefined,
            pid,
            userId: String(msg.user_id ?? userId),
            time: msg.time ? Number(msg.time) * 1000 : undefined,
          },
        })
        // 只有真的算了一次引用才给这个人 +1，避免重复扫描虚增
        if (!r.alreadyRefed) await 记一次引用(rootDir, pid)
        说(`归档 #${r.no}${r.deduped ? '（重复，引用+1）' : '（新图）'} ${bytes.length}B`)
        出.push(r)
      } catch (e) {
        说('归档失败: ' + (e?.message || e))
      }
    }
    // ── 引用消息：直接用之前设置的编号 ──
    // 这条消息如果引用了某张图，就把「谁引用了 #几」记下来，不重复存图。
    try {
      const 引 = await 解析引用(rootDir, msg, onebot, extractReplyId)
      if (引.replyTo && 引.resolved && 引.nos.length) {
        const { pid } = await 记住人(rootDir, {
          userId: msg.user_id ?? userId,
          nickname: msg.sender && msg.sender.nickname,
        })
        for (const no of 引.nos) {
          await 记引用关系(rootDir, {
            no,
            messageId: msg.message_id ?? msg.messageId,
            pid,
            time: msg.time ? Number(msg.time) * 1000 : undefined,
          })
        }
        说(`引用了 #${引.nos.join(',#')}（复用已有编号，不重复存图）`)
      } else if (引.replyTo) {
        说(`引用了消息 ${引.replyTo}，但库里没对上编号`)
      }
    } catch (e) {
      说('引用解析失败: ' + (e?.message || e))
    }

    return 出
  }

  /**
   * 拉一轮私聊历史并归档新图。
   * @returns {Promise<{scanned:number, archived:number}>}
   */
  async function sync() {
    if (在跑) return { scanned: 0, archived: 0, busy: true }
    在跑 = true
    try {
      await initArchive(rootDir)
      const msgs = await onebot.getRecentPrivateMessages(userId, 最后序号)
      if (!Array.isArray(msgs) || msgs.length === 0) return { scanned: 0, archived: 0 }
      // 按时间正序处理，编号顺序才符合直觉
      const 有序 = [...msgs].sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
      let 归档数 = 0
      for (const m of 有序) {
        const got = await 处理一条(m, { chatType: 'private' })
        归档数 += got.length
      }
      // 记住最旧一条的 seq，下次继续往前翻
      const 最旧 = 有序[0]
      if (最旧 && 最旧.message_seq != null) 最后序号 = 最旧.message_seq
      return { scanned: 有序.length, archived: 归档数 }
    } finally {
      在跑 = false
    }
  }

  /**
   * 拉某个群的最近消息，写进聊天记录（群聊不存图，只记文字）。
   * @param {number|string} groupId
   * @returns {Promise<{scanned:number, logged:number}>}
   */
  async function syncGroup(groupId) {
    if (在跑) return { scanned: 0, logged: 0, busy: true }
    在跑 = true
    try {
      await initArchive(rootDir)
      if (typeof onebot.getRecentGroupMessages !== 'function') return { scanned: 0, logged: 0 }
      const msgs = await onebot.getRecentGroupMessages(groupId, undefined)
      if (!Array.isArray(msgs) || msgs.length === 0) return { scanned: 0, logged: 0 }
      const 有序 = [...msgs].sort((a, b) => Number(a.time || 0) - Number(b.time || 0))
      let 记数 = 0
      for (const m of 有序) {
        if (await 记聊天文本(m, 'group', String(groupId))) 记数++
      }
      return { scanned: 有序.length, logged: 记数 }
    } finally {
      在跑 = false
    }
  }

  return { sync, syncGroup, __resetSeen: () => 已见.clear(), __seenCount: () => 已见.size }
}
