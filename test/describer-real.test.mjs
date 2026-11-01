// 用「结构正确的最小真实图片字节」测尺寸解析。
// 之前用随手构造的字节，偏移错了也测不出来（PNG 高度读成 134610944）。
// 这里按各格式的真实头结构逐字节拼出来，任何偏移错误都会立刻失败。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDescriber } from '../lib/describer.js'

/** 造一个结构正确的 PNG 头（签名 + IHDR 长度 + IHDR + 宽 + 高 + 其余） */
function 造PNG(宽, 高) {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0) // 签名 8
  b.writeUInt32BE(13, 8)                    // IHDR 数据长度 13
  b.write('IHDR', 12, 'ascii')              // 段名在 12
  b.writeUInt32BE(宽, 16)                   // 宽在 16
  b.writeUInt32BE(高, 20)                   // 高在 20
  b[24] = 8; b[25] = 2; b[26] = 0; b[27] = 0; b[28] = 0 // 位深/颜色等
  return b
}

/** 造一个结构正确的 GIF 头 */
function 造GIF(宽, 高, 帧数 = 1) {
  const 头 = Buffer.alloc(13)
  头.write('GIF89a', 0, 'ascii')
  头.writeUInt16LE(宽, 6)
  头.writeUInt16LE(高, 8)
  const 帧 = []
  for (let i = 0; i < 帧数; i++) 帧.push(Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 0, 0x3b]))
  return Buffer.concat([头, ...帧])
}

/** 造一个含 SOF0 的 JPEG */
function 造JPEG(宽, 高) {
  const b = Buffer.alloc(20)
  b[0] = 0xff; b[1] = 0xd8                    // SOI
  b[2] = 0xff; b[3] = 0xc0                    // SOF0
  b.writeUInt16BE(11, 4)                      // 段长
  b[6] = 8                                    // 精度
  b.writeUInt16BE(高, 7)                      // 高在 +7（相对 marker 起点 i=2 → i+5）
  b.writeUInt16BE(宽, 9)
  return b
}

const d = createDescriber({})

test('PNG 尺寸按真实偏移解析（IHDR 段名在 12，宽 16，高 20）', async () => {
  const 描述 = await d.describe(造PNG(1116, 2480), {})
  assert.match(描述, /1116x2480/, `应解析出 1116x2480，实际：${描述}`)
})

test('PNG 高度不能是垃圾值（回归：曾读出 134610944）', async () => {
  const 描述 = await d.describe(造PNG(600, 600), {})
  assert.match(描述, /600x600/, `实际：${描述}`)
  assert.doesNotMatch(描述, /134610944/)
})

test('GIF 尺寸小端解析', async () => {
  const 描述 = await d.describe(造GIF(320, 240), {})
  assert.match(描述, /320x240/, `实际：${描述}`)
})

test('GIF 多帧判为动图', async () => {
  const 描述 = await d.describe(造GIF(100, 100, 3), {})
  assert.match(描述, /动图/, `实际：${描述}`)
})

test('JPEG 尺寸解析', async () => {
  const 描述 = await d.describe(造JPEG(300, 230), {})
  assert.match(描述, /300x230/, `实际：${描述}`)
})

test('垃圾字节不抛错，写尺寸未知', async () => {
  const 描述 = await d.describe(Buffer.from('这不是图片'), {})
  assert.ok(描述.length > 0)
  assert.match(描述, /尺寸未知|未知/)
})
