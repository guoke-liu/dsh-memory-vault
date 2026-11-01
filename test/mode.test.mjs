import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 按模式归档, 读文字库 } from '../lib/mode.js'

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('mode-test'),
])

async function 有原图(root) {
  try {
    const f = await readdir(join(root, 'objects'))
    return f.length > 0
  } catch { return false }
}

test('both 模式：原图和文字都存', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-both-'))
  try {
    const r = await 按模式归档(root, { bytes: png, description: '一只橘猫在笑', mode: 'both', meta: { messageId: 'm1' } })
    assert.equal(r.storedImage, true)
    assert.equal(r.storedText, true)
    assert.equal(await 有原图(root), true, '原图必须落盘')
    const 文 = await 读文字库(root)
    assert.equal(Object.keys(文.images).length, 1)
    assert.equal(Object.values(文.images)[0].text, '一只橘猫在笑')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('text 模式：只存文字，原图绝不落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-text-'))
  try {
    const r = await 按模式归档(root, { bytes: png, description: '一只橘猫在笑', mode: 'text', meta: { messageId: 'm1' } })
    assert.equal(r.storedImage, false)
    assert.equal(r.storedText, true)
    assert.equal(await 有原图(root), false, '★ text 模式下原图不能落盘')
    // 索引文件也不该存在（archive 没被调用）
    let 有索引 = true
    try { await stat(join(root, 'index.json')) } catch { 有索引 = false }
    assert.equal(有索引, false, 'text 模式不该生成图片索引')
    // 但指纹仍然算出来了，可用于去重
    assert.equal(r.sha256.length, 64)
    const 文 = await 读文字库(root)
    assert.equal(Object.values(文.images)[0].text, '一只橘猫在笑')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('image 模式：只存原图，不存文字', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-img-'))
  try {
    const r = await 按模式归档(root, { bytes: png, description: '这只不该被存', mode: 'image', meta: { messageId: 'm1' } })
    assert.equal(r.storedImage, true)
    assert.equal(r.storedText, false)
    assert.equal(await 有原图(root), true)
    const 文 = await 读文字库(root)
    assert.equal(Object.keys(文.images).length, 0, 'image 模式不该存文字')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('text 模式：同一张图 + 同一段描述，第二次不新增', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-dedup-'))
  try {
    await 按模式归档(root, { bytes: png, description: '橘猫', mode: 'text', meta: { messageId: 'm1' } })
    const r2 = await 按模式归档(root, { bytes: png, description: '橘猫', mode: 'text', meta: { messageId: 'm2' } })
    assert.equal(r2.deduped, true)
    const 文 = await 读文字库(root)
    assert.equal(Object.keys(文.images).length, 1, '同一描述只存一份')
    assert.equal(Object.values(文.images)[0].refs.length, 2, '引用计 2')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('非法模式回退 both', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-bad-'))
  try {
    const r = await 按模式归档(root, { bytes: png, description: 'x', mode: '乱写', meta: { messageId: 'm1' } })
    assert.equal(r.storedImage, true)
    assert.equal(r.storedText, true)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('both 模式：没有描述时只存图，不报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-nodesc-'))
  try {
    const r = await 按模式归档(root, { bytes: png, mode: 'both', meta: { messageId: 'm1' } })
    assert.equal(r.storedImage, true)
    assert.equal(r.storedText, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
