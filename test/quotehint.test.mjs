import { test } from 'node:test'
import assert from 'node:assert/strict'
import { 造引用提示 } from '../lib/quotehint.js'

// ── 假数据构造（不需要真网络）──

// 最小合法 PNG（签名 + IHDR：宽 300 高 230）
function 假png() {
  const b = Buffer.alloc(28)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)               // IHDR 长度
  Buffer.from('IHDR', 'latin1').copy(b, 12)
  b.writeUInt32BE(300, 16)             // 宽
  b.writeUInt32BE(230, 20)             // 高
  b.writeUInt8(8, 24)                  // 位深
  return b
}

const pngB64 = 假png().toString('base64')
function 图片段() { return { message: [{ type: 'image', data: { file: 'base64://' + pngB64, url: null } }] } }
function 文本段() { return { message: [{ type: 'text', data: { text: '这是纯文字' } }] } }
function 引用段(id) { return { message: [{ type: 'reply', data: { id } }, { type: 'text', data: { text: '你看这个' } }] } }

/**
 * 造假 onebot：
 * 群消息 —— 群里的最近消息（带 message_id / time）
 * getMsg —— 被引用id → 原消息 的映射（缺省当文字消息）
 * 坏id   —— get_msg 对哪些被引用id要抛错
 */
function 造fake({ 群消息, getMsg = {}, 坏id = [] } = {}) {
  const onebot = {
    getRecentGroupMessages: async () => 群消息 || [],
    call: async (action, params) => {
      if (action === 'get_msg') {
        const id = String(params.message_id)
        if (坏id.includes(id)) throw new Error('模拟 get_msg 失败 ' + id)
        return getMsg[id] ?? 文本段()
      }
      throw new Error('未知 action ' + action)
    },
  }
  return onebot
}

test('没有引用消息 → 当前文本 返回空串', async () => {
  const onebot = 造fake({ 群消息: [{ message_id: 'm1', time: 1, ...文本段() }] })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  assert.equal(q.当前文本(), '')
  q.停()
})

test('被引用的是图片 → 文本含「引用图」和图片描述', async () => {
  const onebot = 造fake({
    群消息: [{ message_id: 'q1', time: 2000, ...引用段('900') }],
    getMsg: { '900': { time: 1900, ...图片段() } },
  })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  const text = q.当前文本()
  assert.match(text, /【引用图】/)
  assert.match(text, /一张 PNG/)
  assert.match(text, /300x230/)
  assert.match(text, /q1/)
  q.停()
})

test('被引用的是文字 → 忽略，不出现', async () => {
  const onebot = 造fake({
    群消息: [
      { message_id: 'q1', time: 1000, ...引用段('800') },
      { message_id: 'q2', time: 2000, ...文本段() },
    ],
    getMsg: { '800': 文本段() },   // 被引用的是文字
  })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  assert.equal(q.当前文本(), '')
  q.停()
})

test('超过 3 条引用 → 只保留最近 3 条', async () => {
  const 群消息 = []
  const getMsg = {}
  for (let i = 1; i <= 5; i++) {
    群消息.push({ message_id: 'q' + i, time: i * 10, ...引用段('r' + i) })
    getMsg['r' + i] = { time: i * 5, ...图片段() }
  }
  const onebot = 造fake({ 群消息, getMsg })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  const text = q.当前文本()
  const 行数 = text.split('\n').filter((l) => l.startsWith('- ')).length
  assert.equal(行数, 3)
  assert.match(text, /q5/)
  assert.match(text, /q4/)
  assert.match(text, /q3/)
  assert.doesNotMatch(text, /q2/)
  assert.doesNotMatch(text, /q1/)
  q.停()
})

test('get_msg 抛错 → 不崩，跳过那条', async () => {
  const 群消息 = [
    { message_id: 'qa', time: 1000, ...引用段('bad') },
    { message_id: 'qb', time: 2000, ...引用段('good') },
  ]
  const onebot = 造fake({ 群消息, 坏id: ['bad'], getMsg: { good: { time: 3000, ...图片段() } } })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()   // 不抛
  const text = q.当前文本()
  assert.match(text, /qb/)
  assert.doesNotMatch(text, /qa/)
  q.停()
})

test('没有 image 段（get_msg 返回奇形怪状）→ 不崩、忽略', async () => {
  const onebot = 造fake({
    群消息: [{ message_id: 'qc', time: 1000, ...引用段('x1') }, { message_id: 'qd', time: 2000, ...引用段('x2') }],
    getMsg: { x1: {}, x2: { message: 'null' } },   // 连 message 字段都没有 / 是奇怪形态
  })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  assert.equal(q.当前文本(), '')
  q.停()
})

test('停() 后不报错、文本清空', async () => {
  const onebot = 造fake({
    群消息: [{ message_id: 'qe', time: 1000, ...引用段('e') }],
    getMsg: { e: { time: 500, ...图片段() } },
  })
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  q.停()
  assert.equal(q.当前文本(), '')
  await q.刷新()   // 停后再刷：安全
  q.停()           // 再停一次：安全
})

test('getRecentGroupMessages 抛错 → 不崩', async () => {
  let 炸 = false
  const onebot = {
    getRecentGroupMessages: async () => {
      if (炸) throw new Error('模拟拉群消息失败')
      return [{ message_id: 'qf', time: 1000, ...引用段('f') }]
    },
    call: async () => ({ time: 500, ...图片段() }),
  }
  const q = 造引用提示({ onebot, 群号: 1, 日志: () => {} })
  await q.刷新()
  assert.match(q.当前文本(), /【引用图】/)
  炸 = true
  await q.刷新()   // 不崩
  q.停()
})
