import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 记住人, 查人, 列出人, 记一次引用 } from '../lib/people.js'
import { archiveImage } from '../lib/archive.js'

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('z'),
])

test('同一个人两次拿到同一个编号', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppl-'))
  try {
    const a = await 记住人(root, { userId: '123456789', nickname: '小明' })
    const b = await 记住人(root, { userId: '123456789', nickname: '小明' })
    assert.equal(a.pid, 'p1')
    assert.equal(b.pid, 'p1', '同一 QQ 号必须复用编号')
    assert.equal(b.created, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('不同人编号递增', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppl2-'))
  try {
    const a = await 记住人(root, { userId: '111', nickname: '甲' })
    const b = await 记住人(root, { userId: '222', nickname: '乙' })
    assert.equal(a.pid, 'p1')
    assert.equal(b.pid, 'p2')
    const all = await 列出人(root)
    assert.equal(all.length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('昵称会更新，旧名留痕', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppl3-'))
  try {
    await 记住人(root, { userId: '111', nickname: '旧名' })
    const r = await 记住人(root, { userId: '111', nickname: '新名' })
    assert.equal(r.user.nickname, '新名')
    assert.deepEqual(r.user.曾用名, ['旧名'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('图片 refs 里写的是短编号，不是长 QQ 号', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppl4-'))
  try {
    const { pid } = await 记住人(root, { userId: '123456789', nickname: '小明' })
    await archiveImage(root, png, { messageId: 'm1', pid, time: 1 })
    const idx = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))
    const ref = Object.values(idx.images)[0].refs[0]
    assert.equal(ref.pid, 'p1', '应写短编号')
    assert.equal(ref.userId, undefined, '不应再写长 QQ 号')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('引用计数记到人头上', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppl5-'))
  try {
    const { pid } = await 记住人(root, { userId: '111', nickname: '甲' })
    await 记一次引用(root, pid)
    await 记一次引用(root, pid)
    const u = await 查人(root, pid)
    assert.equal(u.refs, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('people.json 并发写不丢人', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ppl6-'))
  try {
    await Promise.all(['1','2','3','4','5'].map((n) =>
      记住人(root, { userId: n, nickname: 'u' + n })))
    const all = await 列出人(root)
    assert.equal(all.length, 5, '5 个人都要在')
    const pids = new Set(all.map((x) => x.pid))
    assert.equal(pids.size, 5, '编号不能重复')
  } finally { await rm(root, { recursive: true, force: true }) }
})
