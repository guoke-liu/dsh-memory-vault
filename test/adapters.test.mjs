// adapters.js 的测试：外部记忆格式（claude-mem 导出）的识别、转换、导入落盘。
// 覆盖：识别（合法/普通对象/null·数组·字符串）、转换（字段映射、缺字段兜底、都缺跳过、
// 摘要/提示前缀、sessions 不转、时间回退链、垃圾输入）、导入（落盘结构、去重、
// 不识别不落盘、source 字段、损坏自愈、与 ingest.js 写的文件互通、rootDir 容错）。
//
// 写法对齐 ingest.test.mjs：mkdtemp 临时目录 + after 统一清理。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { 识别格式, 转换成memo, 导入外部记忆 } from '../lib/adapters.js'

// ── 公共小工具 ──

const temps = []
async function 临时目录() {
  const d = await mkdtemp(join(tmpdir(), 'adapters-test-'))
  temps.push(d)
  return d
}
after(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

// 造一份标准的 claude-mem 导出样本（字段名与真实导出一致）
function 造样本(overrides = {}) {
  return {
    exportedAt: '2025-12-10T23:45:00.000Z',
    exportedAtEpoch: 1733876700000,
    query: 'windows',
    totalObservations: 2,
    totalSessions: 1,
    totalSummaries: 1,
    totalPrompts: 1,
    observations: [
      { title: '决定用单文件落盘', text: '记忆仓库落盘用 memos.json', memory_session_id: 'sess-001', created_at_epoch: 1733876600000, type: 'decision' },
      { title: '发现并发坑', text: '同通道并发会撞限流', memory_session_id: 'sess-002', created_at_epoch: 1733876650000, type: 'discovery' },
    ],
    sessions: [{ id: 'sess-001', title: '会话一' }],
    summaries: [{ title: '本周小结', text: '做了外部导入适配器', memory_session_id: 'sess-001', created_at_epoch: 1733876700000 }],
    prompts: [{ title: '怎么导出记忆', text: 'claude-mem export --query windows' }],
    ...overrides,
  }
}

// ── 识别格式 ──

test('识别格式: 合法的 claude-mem 导出 → claude-mem-export', () => {
  assert.equal(识别格式(造样本()), 'claude-mem-export')
  // 只有 exportedAtEpoch（没有 exportedAt）也认
  assert.equal(识别格式({ exportedAtEpoch: 1733876700000, observations: [] }), 'claude-mem-export')
  // 只有 exportedAt（没有 exportedAtEpoch）也认
  assert.equal(识别格式({ exportedAt: '2025-12-10T23:45:00.000Z', observations: [] }), 'claude-mem-export')
  // observations 是空数组也算
  assert.equal(识别格式({ exportedAtEpoch: 1, observations: [] }), 'claude-mem-export')
})

test('识别格式: 普通对象 → null', () => {
  assert.equal(识别格式({ hello: 'world' }), null)
  assert.equal(识别格式({ observations: [] }), null) // 缺 exportedAt / exportedAtEpoch
  assert.equal(识别格式({ exportedAtEpoch: 1 }), null) // 缺 observations
  assert.equal(识别格式({ exportedAtEpoch: 1, observations: '不是数组' }), null)
})

test('识别格式: null / 数组 / 字符串 → null 不抛错', () => {
  assert.equal(识别格式(null), null)
  assert.equal(识别格式(undefined), null)
  assert.equal(识别格式([]), null)
  assert.equal(识别格式([{ exportedAtEpoch: 1, observations: [] }]), null)
  assert.equal(识别格式('claude-mem-export'), null)
  assert.equal(识别格式(1733876700000), null)
  assert.equal(识别格式(true), null)
})

// ── 转换成memo ──

test('转换: observations → memo，字段映射正确', () => {
  const memos = 转换成memo(造样本(), { source: 'claude-mem' })
  assert.equal(memos.length, 4) // 2 观察 + 1 摘要 + 1 提示
  const m = memos[0]
  assert.equal(m.title, '决定用单文件落盘')
  assert.equal(m.text, '记忆仓库落盘用 memos.json')
  assert.deepEqual(m.tags, ['decision', 'session:sess-001'])
  assert.equal(m.time, 1733876600000)
  assert.equal(m.source, 'claude-mem')
  // 形状就是 { source, title, text, tags, time } 五个字段
  assert.deepEqual(Object.keys(m).sort(), ['source', 'tags', 'text', 'time', 'title'])
})

test('转换: 缺 title 用默认值，缺 text 用 title 兜底', () => {
  const data = 造样本({
    observations: [
      { text: '只有内容没有标题', created_at_epoch: 1 },
      { title: '只有标题没有内容', created_at_epoch: 2 },
      { title: '', text: '空串标题按缺失算' },
    ],
    summaries: [],
    prompts: [],
  })
  const memos = 转换成memo(data, { source: 'x' })
  assert.equal(memos.length, 3)
  assert.equal(memos[0].title, '（无标题）')
  assert.equal(memos[0].text, '只有内容没有标题')
  assert.equal(memos[1].text, '只有标题没有内容') // text 缺 → 用 title 本身兜底
  assert.equal(memos[2].title, '（无标题）')
  // 缺 type / memory_session_id → tags 是空数组
  assert.deepEqual(memos[0].tags, [])
})

test('转换: title 和 text 都缺 → 跳过这条', () => {
  const data = 造样本({
    observations: [
      {},
      { type: 'decision' }, // 有 type 也不行：title/text 都缺
      { title: '   ', text: '' }, // 纯空白标题 + 空内容 = 都缺
      null, // 脏数据也宽容
      { title: '这条留得下', text: '在' },
    ],
    summaries: [],
    prompts: [],
  })
  const memos = 转换成memo(data, { source: 'x' })
  assert.equal(memos.length, 1)
  assert.equal(memos[0].title, '这条留得下')
})

test('转换: summaries 带「摘要：」前缀', () => {
  const memos = 转换成memo(造样本(), { source: 'x' })
  const s = memos.filter((m) => m.title.startsWith('摘要：'))
  assert.equal(s.length, 1)
  assert.equal(s[0].title, '摘要：本周小结')
  assert.equal(s[0].text, '做了外部导入适配器')
})

test('转换: prompts 带「提示：」前缀', () => {
  const memos = 转换成memo(造样本(), { source: 'x' })
  const p = memos.filter((m) => m.title.startsWith('提示：'))
  assert.equal(p.length, 1)
  assert.equal(p[0].title, '提示：怎么导出记忆')
})

test('转换: sessions 不转换', () => {
  const data = 造样本({
    sessions: [
      { title: '会话标题不该出现', text: '会话内容不该出现' },
      { id: 'sess-002', title: '会话二' },
    ],
  })
  const memos = 转换成memo(data, { source: 'x' })
  assert.equal(memos.length, 4) // 只有 2 观察 + 1 摘要 + 1 提示
  assert.ok(!memos.some((m) => m.text === '会话内容不该出现'))
  assert.ok(!memos.some((m) => m.title.includes('会话')))
})

test('转换: 时间回退链 created_at_epoch → exportedAtEpoch → exportedAt → Date.now()', () => {
  const memos = 转换成memo(造样本({
    observations: [
      { title: 'a', text: 'b' }, // 没有自己的时间 → 回退 exportedAtEpoch
      { title: 'c', text: 'd', created_at_epoch: 1733876600000 }, // 用自己的
    ],
    summaries: [],
    prompts: [],
  }), { source: 'x' })
  assert.equal(memos[1].time, 1733876600000)
  assert.equal(memos[0].time, 1733876700000)
  // exportedAtEpoch 也没有 → 解析 exportedAt(ISO)
  const m2 = 转换成memo({
    exportedAt: '2025-12-10T23:45:00.000Z',
    observations: [{ title: 'a', text: 'b' }],
  }, { source: 'x' })
  assert.equal(m2[0].time, Date.parse('2025-12-10T23:45:00.000Z'))
  // 全缺 → Date.now()（是个正的有限数字即可）
  const m3 = 转换成memo({ observations: [{ title: 'a', text: 'b' }] }, { source: 'x' })
  assert.equal(typeof m3[0].time, 'number')
  assert.ok(Number.isFinite(m3[0].time) && m3[0].time > 0)
})

test('转换: 垃圾输入返回空数组不抛错；不传 source 也有 source 字段', () => {
  assert.deepEqual(转换成memo(null), [])
  assert.deepEqual(转换成memo('x'), [])
  assert.deepEqual(转换成memo([1, 2]), [])
  assert.deepEqual(转换成memo({}), [])
  assert.deepEqual(转换成memo({ observations: '不是数组' }), [])
  for (const m of 转换成memo(造样本())) {
    assert.ok('source' in m) // 一律带 source 字段（缺省 null 占位）
  }
})

// ── 导入外部记忆 ──

test('导入: 正常导入能落盘，memos.json 结构正确', async () => {
  const dir = await 临时目录()
  const r = await 导入外部记忆(dir, 造样本(), { source: 'claude-mem' })
  assert.deepEqual(r, { ok: true, 识别格式: 'claude-mem-export', 转换条数: 4, 新增: 4, 跳过: 0 })
  const d = JSON.parse(await readFile(join(dir, 'memos.json'), 'utf8'))
  assert.equal(d.version, 1)
  assert.equal(d.nextNo, 5)
  assert.deepEqual(Object.keys(d.memos), ['1', '2', '3', '4'])
  const e = d.memos['1']
  assert.equal(e.no, 1)
  assert.equal(e.source, 'claude-mem')
  assert.equal(e.title, '决定用单文件落盘')
  assert.equal(e.text, '记忆仓库落盘用 memos.json')
  assert.deepEqual(e.tags, ['decision', 'session:sess-001'])
  assert.equal(e.time, 1733876600000)
  assert.equal(typeof e.receivedAt, 'number') // 与 ingest.js 存的形状一致
})

test('导入: 同一条第二次导入被跳过（去重）', async () => {
  const dir = await 临时目录()
  const 样本 = 造样本()
  assert.equal((await 导入外部记忆(dir, 样本, { source: 'claude-mem' })).新增, 4)
  const r2 = await 导入外部记忆(dir, 样本, { source: 'claude-mem' })
  assert.deepEqual(r2, { ok: true, 识别格式: 'claude-mem-export', 转换条数: 4, 新增: 0, 跳过: 4 })
  const d = JSON.parse(await readFile(join(dir, 'memos.json'), 'utf8'))
  assert.equal(Object.keys(d.memos).length, 4)
  assert.equal(d.nextNo, 5)
  // 去重键是 source + text：换个 source 的相同 text 不算重复
  const r3 = await 导入外部记忆(dir, 样本, { source: 'other-plugin' })
  assert.equal(r3.新增, 4)
  assert.equal(r3.跳过, 0)
  assert.equal(Object.keys(JSON.parse(await readFile(join(dir, 'memos.json'), 'utf8')).memos).length, 8)
})

test('导入: 无法识别的数据返回 ok:false 不抛错，也不落盘', async () => {
  const dir = await 临时目录()
  for (const bad of [null, undefined, '乱字符串', 123, [1, 2], { foo: 1 }, { observations: [] }]) {
    const r = await 导入外部记忆(dir, bad, { source: 'claude-mem' })
    assert.deepEqual(r, { ok: false, error: '无法识别的格式' })
  }
  await assert.rejects(readFile(join(dir, 'memos.json'), 'utf8'), /ENOENT/)
})

test('导入: 导出的 memo 都带 source 字段', async () => {
  const dir = await 临时目录()
  await 导入外部记忆(dir, 造样本(), { source: 'claude-mem' })
  const d = JSON.parse(await readFile(join(dir, 'memos.json'), 'utf8'))
  for (const e of Object.values(d.memos)) assert.equal(e.source, 'claude-mem')
  // 转换层不传 source：字段仍存在（null 占位）；导入层不传 source：缺省用识别出的格式名
  for (const m of 转换成memo(造样本())) assert.ok('source' in m)
  const dir2 = await 临时目录()
  await 导入外部记忆(dir2, 造样本())
  const d2 = JSON.parse(await readFile(join(dir2, 'memos.json'), 'utf8'))
  for (const e of Object.values(d2.memos)) assert.equal(e.source, 'claude-mem-export')
})

test('导入: memos.json 损坏时自愈成空表，不抛错', async () => {
  const dir = await 临时目录()
  await writeFile(join(dir, 'memos.json'), '{{{不是JSON', 'utf8')
  const r = await 导入外部记忆(dir, 造样本({
    observations: [{ title: '新的一条', text: '新' }],
    summaries: [],
    prompts: [],
  }), { source: 's' })
  assert.equal(r.ok, true)
  assert.equal(r.新增, 1)
  const d = JSON.parse(await readFile(join(dir, 'memos.json'), 'utf8'))
  assert.deepEqual(Object.keys(d.memos), ['1'])
})

test('导入: 与 ingest.js 写的 memos.json 互通（nextNo 接着排、按 source+text 去重）', async () => {
  const dir = await 临时目录()
  // 手工造一份 ingest.js 形状的存量（ingest 的 写memos 用 JSON.stringify(d, null, 1)）
  await writeFile(join(dir, 'memos.json'), JSON.stringify({
    version: 1,
    nextNo: 9,
    memos: { 8: { no: 8, source: 'claude-mem', title: '旧条', text: '旧内容', tags: [], time: 1000, receivedAt: 1000 } },
  }, null, 1), 'utf8')
  const r = await 导入外部记忆(dir, 造样本({
    observations: [
      { title: '新条', text: '新内容', type: 'decision' },
      { title: '撞车条', text: '旧内容' }, // 与 ingest 存的 source+text 相同 → 跳过
    ],
    summaries: [],
    prompts: [],
  }), { source: 'claude-mem' })
  assert.equal(r.ok, true)
  assert.equal(r.转换条数, 2)
  assert.equal(r.新增, 1)
  assert.equal(r.跳过, 1)
  const d = JSON.parse(await readFile(join(dir, 'memos.json'), 'utf8'))
  assert.deepEqual(Object.keys(d.memos).sort(), ['8', '9'])
  assert.equal(d.memos['9'].no, 9) // 接着 ingest 的 nextNo 排，不重号
  assert.equal(d.memos['9'].title, '新条')
  assert.equal(d.memos['8'].title, '旧条') // 旧条原样保留
  assert.equal(d.nextNo, 10)
})

test('导入: rootDir 不存在会自动创建', async () => {
  const dir = await 临时目录()
  const 深处 = join(dir, 'nested', 'vault')
  const r = await 导入外部记忆(深处, 造样本({ observations: [{ title: 'a', text: 'b' }], summaries: [], prompts: [] }), { source: 's' })
  assert.equal(r.ok, true)
  const d = JSON.parse(await readFile(join(深处, 'memos.json'), 'utf8'))
  assert.equal(d.memos['1'].title, 'a')
})

test('导入: rootDir 无效返回 ok:false 不抛错', async () => {
  assert.equal((await 导入外部记忆('', 造样本(), { source: 's' })).ok, false)
  assert.equal((await 导入外部记忆(null, 造样本(), { source: 's' })).ok, false)
  assert.equal((await 导入外部记忆(undefined, 造样本(), { source: 's' })).ok, false)
})
