import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDescriber } from '../lib/describer.js'
import { 按模式归档, 读文字库 } from '../lib/mode.js'

// ── 手工构造测试图片字节（不读外部文件）──

// 最小 PNG：魔数(8) + IHDR 头(4+1=5 长度 'IHDR' 类型) + 4+4+1+1+1 像素区 + CRC(4)
function 造PNG(参数 = {}) {
  const { 宽 = 1116, 高 = 2480 } = 参数
  const b = Buffer.alloc(8 + (4 + 4) + 13 + 4)
  // PNG 魔数
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  // PNG 真实结构：签名 8 + 长度 4(@8) + 'IHDR'(@12) + 宽(@16) + 高(@20)
  // ⚠️ 原来把 'IHDR' 写 @16、宽 @20、高 @24 —— 跟当时实现的偏移错误一致，
  //    所以测试全绿也测不出 bug。现在按真实 PNG 规范构造。
  b.writeUInt32BE(13, 8)
  Buffer.from('IHDR').copy(b, 12)
  // 宽高各 4 字节大端 @20 / @24
  b.writeUInt32BE(宽, 16)
  b.writeUInt32BE(高, 20)
  // bitdepth/colorType/comp/filter/interlace 各 1 字节 @28..32
  // CRC 4 字节 @33
  return b
}

// 单帧 GIF：逻辑屏幕描述(0x01 标志位不关 global color table) + 1 个图像描述符(0x2C)
function 造GIF(参数 = {}) {
  const { 宽 = 300, 高 = 230, 帧 = 1 } = 参数
  const 头 = Buffer.concat([
    Buffer.from('GIF89a', 'latin1'), // 'GIF8' + 版本
    Buffer.alloc(0),
  ])
  // 逻辑屏幕描述符：宽高小端 @6/@8，1 字节 packed，1 字节 bg index
  const 逻辑 = Buffer.alloc(7)
  逻辑.writeUInt16LE(宽, 0)
  逻辑.writeUInt16LE(高, 2)
  const b = Buffer.concat([头, 逻辑])
  const out = Buffer.concat([b, ...Array(帧).fill(Buffer.from([0x2c, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00]))])
  return out
}

// 构造最小 JPEG（SOI + SOF0）：SOI(2) + SOF0 段
// SOF0 段布局：FF C0 | len(2 大端) | 精度(1) | 高(2 大端) | 宽(2 大端) | 组件数(1)
// 偏移（段起点 i）：i+2=len, i+4=精度, i+5=高, i+7=宽
function 造JPEG(参数 = {}) {
  const { 宽 = 800, 高 = 600 } = 参数
  const b = Buffer.alloc(12)
  b.writeUInt16BE(0xffd8, 0)            // SOI
  b.writeUInt16BE(0xffc0, 2)            // SOF0 marker
  b.writeUInt16BE(8, 4)                 // 段长 8
  b[6] = 8                               // 精度
  b.writeUInt16BE(高, 7)                // 高
  b.writeUInt16BE(宽, 9)                // 宽
  return b
}

// 最小 WebP（VP8X 扩展）：RIFF <len> WEBP VP8X <size4> <flags4> 高3字节 宽3字节
// 字节布局 @20: flags(4) @24: reserved+高(3) @27: 宽(3)
function 造WebP(参数 = {}) {
  const { 宽 = 640, 高 = 480 } = 参数
  const b = Buffer.alloc(30)
  Buffer.from('RIFF', 'latin1').copy(b, 0)
  Buffer.from('WEBP', 'latin1').copy(b, 8)
  Buffer.from('VP8X', 'latin1').copy(b, 12)
  b.writeUInt32BE(10, 16) // VP8X 段载荷 10 字节
  b[20] = 0x00; b[21] = 0x00; b[22] = 0x00; b[23] = 0x00 // flags
  b[24] = 0x00; b[25] = (高 >> 8) & 0x7f; b[26] = 高 & 0xff
  b[27] = 0x00; b[28] = (宽 >> 8) & 0x7f; b[29] = 宽 & 0xff
  return b
}

// ── 自定义描述器测试用：调用记录 ──
function 记录型描述器(结果, 抛错 = false) {
  const calls = []
  const fn = async (bytes, meta) => {
    calls.push({ bytesLen: bytes?.length, meta })
    if (抛错) throw new Error('模拟看图模型失败')
    return 结果
  }
  fn.calls = calls
  return fn
}

// ═══════════════════════════════════════════════
// 1. 没装自定义描述器 → 降级生成元信息描述（含格式 + 字节大小）
test('无自定义描述器：降级元信息描述含格式和大小', async () => {
  const d = createDescriber({})
  assert.equal(d.hasCustom(), false)
  const desc = await d.describe(造PNG({ 宽: 1116, 高: 2480 }), {})
  assert.match(desc, /PNG/)
  assert.match(desc, /KB|MB|B/) // 含字节大小
  assert.ok(desc.length > 0)
})

// 2. PNG 尺寸解析正确
test('PNG 尺寸解析：宽1116 高2480', async () => {
  const d = createDescriber({})
  const desc = await d.describe(造PNG({ 宽: 1116, 高: 2480 }), {})
  assert.match(desc, /1116x2480/)
})

// 3. GIF 尺寸解析正确
test('GIF 尺寸解析：300x230', async () => {
  const d = createDescriber({})
  const desc = await d.describe(造GIF({ 宽: 300, 高: 230, 帧: 1 }), {})
  assert.match(desc, /300x230/)
})

// 4. JPEG 尺寸解析正确
test('JPEG 尺寸解析：800x600', async () => {
  const d = createDescriber({})
  const desc = await d.describe(造JPEG({ 宽: 800, 高: 600 }), {})
  assert.match(desc, /800x600/)
})

// 4.5 WebP(VP8X) 尺寸解析
test('WebP VP8X 尺寸解析：640x480', async () => {
  const d = createDescriber({})
  const desc = await d.describe(造WebP({ 宽: 640, 高: 480 }), {})
  assert.match(desc, /640x480/)
})

// 4.6 WebP 长度不足：不抛错，尺寸未知
test('WebP 长度不足：不抛错，尺寸未知', async () => {
  const d = createDescriber({})
  const 短 = Buffer.from([0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58])
  const desc = await d.describe(短, {})
  assert.match(desc, /WebP/)
  assert.match(desc, /尺寸未知/)
})

// 5. 动图判断：单帧 GIF → 静态；多帧 GIF → 动图
test('GIF 单帧 = 静态，多帧 = 动图', async () => {
  const d = createDescriber({})
  const 单 = await d.describe(造GIF({ 帧: 1 }), {})
  assert.doesNotMatch(单, /动图/)
  assert.match(单, /GIF/)
  const 多 = await d.describe(造GIF({ 帧: 5 }), {})
  assert.match(多, /动图/)
})

// 6. 垃圾字节：不抛错，返回「尺寸未知」
test('垃圾字节不抛错，尺寸写成「尺寸未知」', async () => {
  const d = createDescriber({})
  const 垃圾 = Buffer.from('这不是图片\x00\x01\x02\x03', 'binary')
  let 抛了 = false
  let desc
  try { desc = await d.describe(垃圾, {}) } catch { 抛了 = true }
  assert.equal(抛了, false, 'describe() 绝不能抛错')
  assert.match(desc, /尺寸未知/)
})

// 6.5 格式已知但尺寸解析失败（比如 PNG 魔数但无 IHDR）
test('PNG 魔数但长度不足：不抛错，尺寸未知', async () => {
  const d = createDescriber({})
  const 截断 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const desc = await d.describe(截断, {})
  assert.match(desc, /PNG/)
  assert.match(desc, /尺寸未知/)
})

// 7. 装了自定义描述器 → 用它的结果
test('自定义描述器：用它的结果', async () => {
  const fn = 记录型描述器('一只橘猫在笑')
  const d = createDescriber({ 自定义描述器: fn })
  assert.equal(d.hasCustom(), true)
  const bytes = 造PNG()
  const desc = await d.describe(bytes, { messageId: 'm1' })
  assert.equal(desc, '一只橘猫在笑')
  assert.equal(fn.calls.length, 1)
})

// 8. 自定义描述器抛错 → 自动降级，不抛错
test('自定义描述器抛错 → 自动降级元信息', async () => {
  const fn = 记录型描述器('不该出现', true)
  const d = createDescriber({ 自定义描述器: fn })
  const bytes = 造PNG({ 宽: 100, 高: 50 })
  let 抛了 = false
  let desc
  try { desc = await d.describe(bytes, {}) } catch { 抛了 = true }
  assert.equal(抛了, false, 'describe() 绝不能抛错')
  assert.match(desc, /PNG/)
  assert.match(desc, /100x50/)
})

// 9. 自定义描述器返回空串 → 自动降级
test('自定义描述器返回空串 → 自动降级', async () => {
  const fn = 记录型描述器('')
  const d = createDescriber({ 自定义描述器: fn })
  const bytes = 造GIF({ 宽: 10, 高: 20, 帧: 1 })
  const desc = await d.describe(bytes, {})
  assert.match(desc, /GIF/)
  assert.match(desc, /10x20/)
})

// ═══════════════════════════════════════════════
// 10. 按模式归档：text 模式不传 description、传 describer → 自动生成描述并存 descriptions.json
test('text 模式 + describer（无 description）：自动生成描述存 descriptions.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-desc-'))
  try {
    const d = createDescriber({})
    const r = await 按模式归档(root, {
      bytes: 造PNG({ 宽: 1116, 高: 2480 }),
      mode: 'text',
      meta: { messageId: 'm1' },
      describer: d,
    })
    assert.equal(r.storedImage, false)
    assert.equal(r.storedText, true)
    const 文 = await 读文字库(root)
    assert.equal(Object.keys(文.images).length, 1)
    const 文本 = Object.values(文.images)[0].text
    assert.match(文本, /PNG/)
    assert.match(文本, /1116x2480/)
    assert.match(文本, /KB|MB|B/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// 10.5 both 模式 + describer（无 description）：也自动生成
test('both 模式 + describer（无 description）：自动生成描述', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-both-desc-'))
  try {
    const d = createDescriber({})
    const r = await 按模式归档(root, {
      bytes: 造JPEG({ 宽: 800, 高: 600 }),
      mode: 'both',
      meta: { messageId: 'm1' },
      describer: d,
    })
    assert.equal(r.storedImage, true)
    assert.equal(r.storedText, true)
    const 文 = await 读文字库(root)
    assert.match(Object.values(文.images)[0].text, /JPEG/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// 11. 按模式归档：传了 description → 优先用传入的，不调 describer
test('传了 description → 优先用传入的，不调 describer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-prefer-'))
  try {
    const fn = 记录型描述器('自定义结果')
    const d = createDescriber({ 自定义描述器: fn })
    const r = await 按模式归档(root, {
      bytes: 造PNG(),
      description: '传入的描述',
      mode: 'text',
      meta: { messageId: 'm1' },
      describer: d,
    })
    assert.equal(r.storedText, true)
    const 文 = await 读文字库(root)
    assert.equal(Object.values(文.images)[0].text, '传入的描述')
    assert.equal(fn.calls.length, 0, '传了 description 时不该调 describer')
  } finally { await rm(root, { recursive: true, force: true }) }
})

// 11.5 没传 describer 也没传 description：保持旧行为（不存文字，不报错）
test('没传 describer 也没传 description：保持旧行为不存文字', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-legacy-'))
  try {
    const r = await 按模式归档(root, {
      bytes: 造PNG(),
      mode: 'text',
      meta: { messageId: 'm1' },
    })
    assert.equal(r.storedText, false)
    assert.equal(r.storedImage, false)
    const 文 = await 读文字库(root)
    assert.equal(Object.keys(文.images).length, 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

// 11.6 describer 在 image 模式下：不存文字（image 模式本来就不要文）
test('image 模式 + describer：不存文字', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mode-img-desc-'))
  try {
    const d = createDescriber({})
    const r = await 按模式归档(root, {
      bytes: 造PNG(),
      mode: 'image',
      meta: { messageId: 'm1' },
      describer: d,
    })
    assert.equal(r.storedImage, true)
    assert.equal(r.storedText, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
