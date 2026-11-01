import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractReplyId } from '../lib/onebot.js'
import { 按消息找编号, 解析引用, 记引用关系 } from '../lib/reply.js'
import { archiveImage } from '../lib/archive.js'

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('r'),
])

test('extractReplyId: segment 数组形态', () => {
  const msg = { message: [{ type: 'reply', data: { id: '123456' } }, { type: 'text', data: { text: '这个' } }] }
  assert.equal(extractReplyId(msg), '123456')
})

test('extractReplyId: CQ 码形态', () => {
  assert.equal(extractReplyId({ message: '[CQ:reply,id=789]你好' }), '789')
})

test('extractReplyId: 没引用返回 null', () => {
  assert.equal(extractReplyId({ message: [{ type: 'text', data: { text: 'hi' } }] }), null)
})

test('按消息 id 找到图编号', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rep-'))
  try {
    const a = await archiveImage(root, png, { messageId: 'm-100', pid: 'p1' })
    const nos = await 按消息找编号(root, 'm-100')
    assert.deepEqual(nos, [a.no])
    assert.deepEqual(await 按消息找编号(root, '不存在'), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('引用消息直接复用已有编号，不新增图', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rep2-'))
  try {
    const a = await archiveImage(root, png, { messageId: 'm-100', pid: 'p1' })
    // 有人引用那条图消息
    const 引用消息 = {
      message_id: 'm-200',
      message: [{ type: 'reply', data: { id: 'm-100' } }, { type: 'text', data: { text: '这图好看' } }],
    }
    const r = await 解析引用(root, 引用消息, null, extractReplyId)
    assert.equal(r.replyTo, 'm-100')
    assert.deepEqual(r.nos, [a.no], '应直接给出之前的编号')
    assert.equal(r.resolved, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('记引用关系会落盘，且同一条消息不重复记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rep3-'))
  try {
    const a = await archiveImage(root, png, { messageId: 'm-100', pid: 'p1' })
    await 记引用关系(root, { no: a.no, messageId: 'q-1', pid: 'p2' })
    await 记引用关系(root, { no: a.no, messageId: 'q-1', pid: 'p2' })
    const idx = JSON.parse(await readFile(join(root, 'index.json'), 'utf8'))
    const e = Object.values(idx.images).find((x) => x.no === a.no)
    assert.equal(e.quotedBy.length, 1, '同一条引用消息只记一次')
    assert.equal(e.quotedBy[0].messageId, 'q-1')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('引用一条没归档过的消息：resolved=false，不报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rep4-'))
  try {
    const r = await 解析引用(root, { message: [{ type: 'reply', data: { id: '999' } }] }, null, extractReplyId)
    assert.equal(r.resolved, false)
    assert.deepEqual(r.nos, [])
  } finally { await rm(root, { recursive: true, force: true }) }
})
