// recallhint 的测试：验证「什么时候该注入、注入什么」
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { 造回忆引导 } from '../lib/recallhint.js'

test('默认：有记忆时返回完整引导', async () => {
  const f = 造回忆引导({})
  const t = await f()
  assert.ok(t.includes('记忆仓库'))
  assert.ok(t.includes('chat_search'))
  assert.ok(t.includes('memory_search'))
})

test('引导里必须点出「别凭印象答」「别直接说我忘了」', async () => {
  const t = await 造回忆引导({})()
  assert.ok(t.includes('别凭印象答'))
  assert.ok(t.includes('我忘了'))
})

test('引导里给出了具体触发词', async () => {
  const t = await 造回忆引导({})()
  for (const kw of ['以前', '上次', '之前', '还记得吗']) {
    assert.ok(t.includes(kw), `应该提到「${kw}」`)
  }
})

test('有记忆=false 时返回空串（空库不引导）', async () => {
  const f = 造回忆引导({ 有记忆: () => false })
  assert.equal(await f(), '')
})

test('有记忆=true 时正常返回', async () => {
  const f = 造回忆引导({ 有记忆: () => true })
  assert.ok((await f()).includes('记忆仓库'))
})

test('有记忆异步返回 false → 空串', async () => {
  const f = 造回忆引导({ 有记忆: async () => false })
  assert.equal(await f(), '')
})

test('有记忆函数抛错 → 返回空串，不抛异常', async () => {
  const f = 造回忆引导({ 有记忆: () => { throw new Error('boom') } })
  assert.equal(await f(), '')
})

test('有记忆返回 Promise 里 reject → 空串', async () => {
  const f = 造回忆引导({ 有记忆: async () => { throw new Error('boom') } })
  assert.equal(await f(), '')
})

test('多次调用内容一致（缓存友好）', async () => {
  const f = 造回忆引导({})
  assert.equal(await f(), await f())
})

test('内容不应过长（每轮都随上下文走）', async () => {
  const t = await 造回忆引导({})()
  assert.ok(t.length < 1500, `引导 ${t.length} 字，太长了`)
})
