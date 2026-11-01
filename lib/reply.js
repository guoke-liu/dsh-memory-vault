// 引用消息 → 直接用已有编号
//
// 需求（主人 2026-11-01）：「引用消息直接用之前设置的编号」
//
// 场景：A 发了张图，编号 #3 入库；后来有人引用那张图再说话。
// 这时不该把图画再存一遍、也不该只留一句「[引用了一条消息]」，
// 而应该记下「这条消息引用的是 #3」。
//
// 做法：从 reply 段拿到被引用的消息 id → 去 index.json 里查哪张图由这条消息归档过
//      → 直接复用那个编号 no。

import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 原子写索引（和 archive.js 一致：临时文件 + rename） */
async function 写索引(rootDir, 索引) {
  const 最终 = join(rootDir, 'index.json')
  const 临时 = 最终 + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(临时, JSON.stringify(索引, null, 2))
  await rename(临时, 最终)
}

/** 读索引，失败当空库 */
async function 读索引(rootDir) {
  try {
    const d = JSON.parse(await readFile(join(rootDir, 'index.json'), 'utf8'))
    if (d && typeof d === 'object' && d.images) return d
  } catch {}
  return { version: 1, nextNo: 1, images: {} }
}

/**
 * 某个消息 id 归档过哪些图？返回编号数组（一张消息可能带多图）。
 * @returns {Promise<number[]>}
 */
export async function 按消息找编号(rootDir, messageId) {
  const mid = String(messageId ?? '').trim()
  if (!mid) return []
  const 索引 = await 读索引(rootDir)
  const 出 = []
  for (const e of Object.values(索引.images)) {
    if (!e || !Array.isArray(e.refs)) continue
    if (e.refs.some((r) => r && String(r.messageId) === mid)) 出.push(e.no)
  }
  // 编号升序，稳定可预期
  return 出.sort((a, b) => a - b)
}

/**
 * 处理一条引用消息：解析它引用的是哪张图，返回编号。
 *
 * @param {string} rootDir
 * @param {object} msg          一条 OneBot 消息事件
 * @param {object} onebot       createOneBot() 的返回值（用于 get_msg 反查）
 * @param {Function} extractReplyId
 * @returns {Promise<{replyTo: string|null, nos: number[], resolved: boolean}>}
 *   replyTo  被引用的消息 id
 *   nos      对应的图片编号（可能多个，也可能空）
 *   resolved true = 成功在库里找到了编号
 */
export async function 解析引用(rootDir, msg, onebot, extractReplyId) {
  const replyTo = extractReplyId(msg)
  if (!replyTo) return { replyTo: null, nos: [], resolved: false }

  // 先在库里直接查
  let nos = await 按消息找编号(rootDir, replyTo)
  if (nos.length) return { replyTo, nos, resolved: true }

  // 库里没有：可能是那条消息本来就还没被归档过（比如是纯文字），
  // 也可能是历史数据。尝试用 get_msg 把原消息取回来，看看它自己带不带图。
  try {
    if (onebot && typeof onebot.call === 'function') {
      const r = await onebot.call('get_msg', { message_id: Number(replyTo) || replyTo })
      const 原 = r && r.data
      if (原 && Array.isArray(原.message)) {
        // 原消息里的图如果已经入过库，也能对上编号
        for (const seg of 原.message) {
          if (seg?.type !== 'image') continue
          // 用原消息的 id 再查一次编号
          const more = await 按消息找编号(rootDir, 原.message_id)
          if (more.length) { nos = more; break }
        }
      }
    }
  } catch {
    // 反查失败不影响主流程：只是没对上编号而已
  }

  return { replyTo, nos, resolved: nos.length > 0 }
}

/**
 * 把引用关系写进索引：在对应的图片条目上记一条「谁引用了它」。
 * 这样「这张图被引用过几次」也能算出来，而且不重复存图。
 */
export function 记引用关系(rootDir, { no, messageId, pid, time }) {
  return 串行(rootDir, async () => {
    const 索引 = await 读索引(rootDir)
    const e = Object.values(索引.images).find((x) => x && x.no === no)
    if (!e) return null
    e.quotedBy ||= []
    // 同一条消息不重复记
    if (e.quotedBy.some((q) => q && String(q.messageId) === String(messageId))) return e
    e.quotedBy.push({ messageId: String(messageId ?? ''), pid, time: time ?? Date.now() })
    await 写索引(rootDir, 索引)
    return e
  })
}

// 同库串行，避免与 archive.js 的写入互相覆盖
const 队列 = new Map()
function 串行(rootDir, fn) {
  const 前 = 队列.get(rootDir) ?? Promise.resolve()
  const 这次 = 前.then(fn, fn)
  队列.set(rootDir, 这次.catch(() => {}))
  return 这次
}
