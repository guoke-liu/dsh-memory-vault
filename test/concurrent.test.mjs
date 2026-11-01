import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveImage, getStats, listImages } from '../lib/archive.js'

const mk = (n) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('payload-' + n),
])

test('并发归档：10 张不同图同时写，一张都不能丢', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-conc-'))
  try {
    // 同时发起，不加锁的话后写的会覆盖先写的索引
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      archiveImage(root, mk(i), { messageId: String(i), userId: 'u1' })))
    const s = await getStats(root)
    assert.equal(s.unique, 10, '应存下 10 张不同图')
    assert.equal(s.totalRefs, 10)
    const { items } = await listImages(root)
    const nos = items.map((x) => x.no).sort((a, b) => a - b)
    assert.deepEqual(nos, [1,2,3,4,5,6,7,8,9,10], '编号应连续无空洞')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('并发归档同一张图 10 次：只存一份，引用计 10', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-conc2-'))
  try {
    const same = mk('same')
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      archiveImage(root, same, { messageId: String(i), userId: 'u1' })))
    const s = await getStats(root)
    assert.equal(s.unique, 1, '同一内容只存一份')
    assert.equal(s.totalRefs, 10, '引用次数要一次不丢')
  } finally { await rm(root, { recursive: true, force: true }) }
})
