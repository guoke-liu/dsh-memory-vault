import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { archiveImage, getStats } from '../lib/archive.js'

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('x'),
])

test('同一条消息重复归档：引用次数不涨（去重靠存储层，不靠内存）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-idem-'))
  try {
    const a = await archiveImage(root, png, { messageId: 'm-1', userId: 'u1' })
    assert.equal(a.refCount, 1)
    assert.equal(a.alreadyRefed, false)
    // 模拟"进程重启后再扫到同一条消息"
    const b = await archiveImage(root, png, { messageId: 'm-1', userId: 'u1' })
    assert.equal(b.alreadyRefed, true, '应识别为早已记过')
    assert.equal(b.refCount, 1, '引用次数不能涨')
    assert.equal(b.no, a.no, '编号不变')
    const s = await getStats(root)
    assert.equal(s.unique, 1)
    assert.equal(s.totalRefs, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('同图不同消息：编号不变，引用各算一次', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arc-idem2-'))
  try {
    await archiveImage(root, png, { messageId: 'm-1', userId: 'u1' })
    const b = await archiveImage(root, png, { messageId: 'm-2', userId: 'u1' })
    assert.equal(b.alreadyRefed, false)
    assert.equal(b.refCount, 2)
    const s = await getStats(root)
    assert.equal(s.unique, 1)
    assert.equal(s.totalRefs, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})
