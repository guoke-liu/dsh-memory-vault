import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 切词, 搜索, 取详情, 最近, 注册AI工具 } from '../lib/tools.js'

/** 造一个库 */
async function 建库(root, 条目, 人 = {}) {
  await writeFile(join(root, 'descriptions.json'), JSON.stringify({
    version: 1, nextNo: 条目.length + 1,
    images: Object.fromEntries(条目.map((e, i) => ['k' + i, {
      no: e.no, text: e.text, sha256: 'k' + i, imageSha: e.imageSha ?? null,
      firstSeen: e.t ?? 1000, lastSeen: e.t ?? 1000,
      refs: [{ messageId: 'm' + e.no, pid: e.pid || 'p1', time: e.t ?? 1000 }],
    }])),
  }))
  await writeFile(join(root, 'people.json'), JSON.stringify({
    version: 1, nextNo: 2, byQq: {}, people: 人,
  }))
}

test('切词：中文按 2 字滑窗，「橘猫」能命中', () => {
  const 词 = 切词('橘猫')
  assert.ok(词.includes('橘猫'))
})

test('切词：长句能切出子词', () => {
  const 词 = 切词('腾讯云轻量服务器')
  assert.ok(词.includes('腾讯'), '应切出腾讯')
  assert.ok(词.includes('服务'), '应切出服务')
})

test('切词：英文数字整词', () => {
  const 词 = 切词('DSH 4096')
  assert.ok(词.includes('dsh'))
  assert.ok(词.includes('4096'))
})

test('搜索：能找到相关条目并按分数排序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool-'))
  try {
    await 建库(root, [
      { no: 1, text: '橘猫大笑的表情包' },
      { no: 2, text: '腾讯云服务器购买页，橘色主题' },
      { no: 3, text: 'QQ 聊天截图' },
    ])
    const r = await 搜索(root, '橘猫')
    assert.ok(r.length >= 1)
    assert.equal(r[0].no, 1, '最相关的是橘猫那条')
    assert.ok(r[0].score > 0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('搜索：没有关键词返回空，不报错', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool2-'))
  try {
    await 建库(root, [{ no: 1, text: '橘猫' }])
    assert.deepEqual(await 搜索(root, '完全不相干的词语xyz'), [])
    assert.deepEqual(await 搜索(root, ''), [])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('取详情：带出谁发的、昵称、引用次数', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool3-'))
  try {
    await 建库(root, [{ no: 5, text: '橘猫', pid: 'p1', imageSha: 'abc123' }],
      { p1: { qq: '123456789', nickname: '小明', refs: 1 } })
    const d = await 取详情(root, 5)
    assert.equal(d.no, 5)
    assert.equal(d.text, '橘猫')
    assert.equal(d.原图有没有, true)
    assert.equal(d.谁发的.昵称, '小明')
    assert.equal(d.被引用次数, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('取详情：不存在的编号返回 null', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool4-'))
  try {
    await 建库(root, [])
    assert.equal(await 取详情(root, 999), null)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('最近：按时间倒序', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tool5-'))
  try {
    await 建库(root, [
      { no: 1, text: '老图', t: 1000 },
      { no: 2, text: '新图', t: 9000 },
      { no: 3, text: '中间', t: 5000 },
    ])
    const r = await 最近(root, { limit: 2 })
    assert.equal(r.length, 2)
    assert.equal(r[0].no, 2, '最新的排第一')
    assert.equal(r[1].no, 3)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('注册AI工具：没有 ctx.tools 时不抛错', () => {
  let 提示 = ''
  const r = 注册AI工具({ defineTool: (o) => o, ctx: {}, rootDir: () => '/tmp', log: (m) => { 提示 = m } })
  assert.deepEqual(r, [])
  assert.ok(提示.includes('不可用'))
})

test('注册AI工具：注册十二个工具（含 chat_search、person_list、import_memories、memory_recall、memory_coverage、memory_score_chats、memory_import_diary、memory_build_events、memory_forget_events），参数是属性映射格式', () => {
  const registered = []
  const ctx = { tools: { register: (t) => registered.push(t) } }
  const defineTool = (o) => o
  const r = 注册AI工具({ defineTool, ctx, rootDir: () => '/tmp', log: () => {} })
  // 2026-11-03：并入记忆检索后 6 → 8 个；加聊天分层 → 9 个；加外部日记导入 → 10 个；
  // 2026-11-04 加事件提炼 memory_build_events → 11 个。
  // 这些都是调用时才动态 import 实现模块，注册阶段不加载任何重依赖，
  // 所以这里即使不传 diaryRootDir 也应当注册成功 —— 没配是降级，不是不注册。
  assert.deepEqual(r.sort(), ['chat_search', 'import_memories', 'memory_build_events', 'memory_coverage', 'memory_forget_events', 'memory_get', 'memory_import_diary', 'memory_recall', 'memory_recent', 'memory_score_chats', 'memory_search', 'person_list'])
  const s = registered.find((t) => t.name === 'memory_search')
  assert.ok(s.parameters.query, 'query 必须是属性映射里的一项')
  assert.equal(s.parameters.query.required, true)
  assert.equal(s.parameters.type, undefined, '不能写成 {type:object,properties:{}}')
})
