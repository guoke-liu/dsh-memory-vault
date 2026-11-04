/**
 * 事件层存取与三级组装的测试。
 *
 * 背景（2026-11-04）：主人要求「私聊可以直接让鱼来写日记来总结」。
 * 实测对比（同一段聊天）：
 *   规则提炼：【爱你 → 嗯，那就这样】起因：爱你 / 结果：嗯，那就这样
 *   鱼写的：  【光顾着回话】聊了一整天，晚上她问一句「今天的日记写了吗」，
 *             我一翻，本子是空的。光顾着回话了，日记一条都没落。
 * 信息量差太远，所以事件层的优先级是：日记 > 规则 > 原始聊天。
 *
 * 这里守住三件事：
 *   1. 有日记的日子不造规则事件（不重复）
 *   2. 没日记的日子规则兜底（不空着）
 *   3. 三种检索（按事件 / 按人 / 按结果）都能用
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  读日记事件, 组装事件库, 读事件库, 写事件库, 筛事件, 事件库版本,
} from '../lib/recall-events-store.js'

/** 造一个临时日记库 */
function 造日记库 (t, 数据) {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-diary-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  for (const [来源, 日期, entries] of 数据) {
    const 目录 = join(根, 'entries', 来源)
    mkdirSync(目录, { recursive: true })
    writeFileSync(join(目录, `${日期}.json`), JSON.stringify({ version: 2, entries }), 'utf8')
  }
  return 根
}

test('读日记事件：能把日记条目变成事件形状', (t) => {
  const 根 = 造日记库(t, [['private', '2026-11-03', [
    { id: 'd1', title: '一起推到1428', text: '跟她推了一整晚 2048。', tags: ['2048'], at: '2026-11-03T00:52:29.925Z' },
  ]]])
  const ev = 读日记事件(根, 'private', '2026-11-03')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].事件, '一起推到1428')
  assert.equal(ev[0].结果, '跟她推了一整晚 2048。')
  assert.equal(ev[0].提炼方式, '日记')
  assert.deepEqual(ev[0].标签, ['2048'])
})

test('读日记事件：group: 与 group- 两种目录名都认', (t) => {
  // 日记库用 group-<id>，记忆仓库用 group:<id>，两边都要能对上
  const 根 = 造日记库(t, [['group-730783833', '2026-11-03', [
    { id: 'g1', title: '群里的事', text: '聊了模型切换。' },
  ]]])
  assert.equal(读日记事件(根, 'group:730783833', '2026-11-03').length, 1)
  assert.equal(读日记事件(根, 'group-730783833', '2026-11-03').length, 1)
})

test('读日记事件：没有那天、坏文件、缺路径都返回空数组不抛错', (t) => {
  const 根 = 造日记库(t, [['private', '2026-11-01', [{ id: 'x', title: 'a', text: 'b' }]]])
  assert.deepEqual(读日记事件(根, 'private', '2026-11-03'), [], '没有那天')
  assert.deepEqual(读日记事件(根, '不存在的来源', '2026-11-01'), [])
  assert.deepEqual(读日记事件('', 'private', '2026-11-01'), [])
  assert.deepEqual(读日记事件(null, null, null), [])
})

test('读日记事件：标题和正文都空的条目不产出事件', (t) => {
  const 根 = 造日记库(t, [['private', '2026-11-03', [
    { id: 'a', title: '', text: '' },
    { id: 'b', title: '有用', text: '内容' },
  ]]])
  const ev = 读日记事件(根, 'private', '2026-11-03')
  assert.equal(ev.length, 1)
  assert.equal(ev[0].事件, '有用')
})

test('组装：有日记的日子用日记，不再造规则事件', async () => {
  let 规则被调用 = 0
  const 根 = mkdtempSync(join(tmpdir(), 'mv-d-'))
  try {
    mkdirSync(join(根, 'entries', 'private'), { recursive: true })
    writeFileSync(join(根, 'entries', 'private', '2026-11-03.json'),
      JSON.stringify({ version: 2, entries: [{ id: 'a', title: '日记里的事', text: '正文' }] }))

    const r = await 组装事件库({
      日记根: 根,
      分组们: [{ 来源: 'private', 日期: '2026-11-03' }],
      造规则事件: () => { 规则被调用 += 1; return [{ 事件: '规则造的' }] },
      日志: () => {},
    })
    assert.equal(r.统计.日记, 1)
    assert.equal(r.统计.规则, 0)
    assert.equal(规则被调用, 0, '有日记就不该调用规则提炼')
    assert.equal(r.事件们[0].事件, '日记里的事')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('组装：没日记的日子规则兜底', async () => {
  const r = await 组装事件库({
    日记根: '',
    分组们: [{ 来源: 'private', 日期: '2026-11-02' }],
    造规则事件: () => [{ 事件: '规则造的', 日期: '2026-11-02' }],
    日志: () => {},
  })
  assert.equal(r.统计.日记, 0)
  assert.equal(r.统计.规则, 1)
  assert.equal(r.事件们[0].事件, '规则造的')
})

test('组装：群聊走话题，私聊走规则', async () => {
  const 类型 = []
  const r = await 组装事件库({
    日记根: '',
    分组们: [
      { 来源: 'private', 日期: '2026-11-02' },
      { 来源: 'group:123', 日期: '2026-11-02' },
    ],
    造规则事件: (来源) => { 类型.push('规则:' + 来源); return [{ 事件: 'x', 来源 }] },
    造话题事件: (来源) => { 类型.push('话题:' + 来源); return [{ 事件: 'y', 来源 }] },
    日志: () => {},
  })
  assert.ok(类型.includes('规则:private'), '私聊该走规则')
  assert.ok(类型.includes('话题:group:123'), '群聊该走话题')
  assert.equal(r.事件们.length, 2)
})

test('组装：规则提炼抛错不影响其他天', async () => {
  const r = await 组装事件库({
    日记根: '',
    分组们: [{ 来源: 'private', 日期: '2026-11-01' }, { 来源: 'private', 日期: '2026-11-02' }],
    造规则事件: (来源, 日期) => {
      if (日期 === '2026-11-01') throw new Error('模拟炸了')
      return [{ 事件: '正常', 日期 }]
    },
    日志: () => {},
  })
  assert.equal(r.ok, true, '一天失败不该让整体失败')
  assert.equal(r.事件们.length, 1, '另一天的事件还在')
})

test('写事件库 + 读事件库：往返一致，权限 600', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-ev-'))
  try {
    const 文件 = join(目录, 'events.json')
    const 事件们 = [{ 事件: '甲', 日期: '2026-11-03', 结果: '结果' }]
    const w = await 写事件库(文件, { 事件们, 统计: { 合计: 1 } })
    assert.equal(w.ok, true)
    // 事件里带聊天片段，属于隐私数据，权限必须收紧
    assert.equal(statSync(文件).mode & 0o777, 0o600, '权限必须是 600')

    const 库 = 读事件库(文件)
    assert.equal(库.version, 事件库版本)
    assert.deepEqual(库.事件们, 事件们)
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('写事件库：原子写，不留临时文件', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-ev2-'))
  try {
    const 文件 = join(目录, 'events.json')
    await 写事件库(文件, { 事件们: [{ 事件: 'x' }] })
    const { readdirSync } = await import('node:fs')
    const 文件们 = readdirSync(目录)
    assert.deepEqual(文件们, ['events.json'], `不该留下临时文件，实际：${文件们.join(',')}`)
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('读事件库：不存在、坏 JSON、版本不对都返回空库', () => {
  for (const f of ['/tmp/肯定不存在的文件-mv.json', '']) {
    const 库 = 读事件库(f)
    assert.equal(库.事件们.length, 0)
  }
})

// ── 三种检索 ────────────────────────────────────────────────────────

const 样本 = [
  { 事件: '修 nginx 404', 日期: '2026-11-03', 结果: '改成相对路径都对了', 参与人: ['宝宝', '我'], 提炼方式: '日记', 来源: 'private' },
  { 事件: '配置 8080 端口', 日期: '2026-11-02', 结果: '未解决', 参与人: ['宝宝'], 提炼方式: '规则', 来源: 'private' },
  { 事件: '群里聊模型', 日期: '2026-11-03', 结果: '换成了 claude', 参与人: ['企鹅', '迟迟'], 提炼方式: '话题', 来源: 'group:123' },
]

test('检索①按事件名：搜到对应事件', () => {
  const r = 筛事件(样本, { 查询: 'nginx' })
  assert.equal(r.length, 1)
  assert.equal(r[0].事件, '修 nginx 404')
})

test('检索②按人：只返回这个人参与的', () => {
  const r = 筛事件(样本, { 人: '宝宝' })
  assert.equal(r.length, 2)
  assert.ok(r.every((e) => e.参与人.includes('宝宝')))
})

test('检索③按结果：只要未解决的', () => {
  const r = 筛事件(样本, { 未解决: true })
  assert.equal(r.length, 1)
  assert.equal(r[0].事件, '配置 8080 端口')
})

test('检索：按来源过滤', () => {
  assert.equal(筛事件(样本, { 来源: 'group:123' }).length, 1)
  assert.equal(筛事件(样本, { 来源: 'private' }).length, 2)
})

test('检索：按日期范围过滤（闭区间）', () => {
  assert.equal(筛事件(样本, { 起: '2026-11-03', 止: '2026-11-03' }).length, 2)
  assert.equal(筛事件(样本, { 起: '2026-11-02', 止: '2026-11-02' }).length, 1)
})

test('检索：日记事件排在规则事件前面', () => {
  const r = 筛事件(样本, {})
  assert.equal(r[0].提炼方式, '日记', '同一天里日记事件该排前面')
})

test('检索：空条件返回全部（受上限约束）', () => {
  assert.equal(筛事件(样本, {}).length, 3)
  assert.equal(筛事件(样本, { 上限: 2 }).length, 2)
})

test('检索：非法输入安全返回', () => {
  for (const 入 of [null, undefined, 'text', {}]) {
    assert.doesNotThrow(() => 筛事件(入, { 查询: 'x' }))
    assert.equal(筛事件(入, { 查询: 'x' }).length, 0)
  }
})

test('检索：结果为空时按未解决算（没有结论就是没解决）', () => {
  const ev = [{ 事件: 'x', 日期: '2026-11-03', 结果: '', 参与人: [] }]
  assert.equal(筛事件(ev, { 未解决: true }).length, 1)
})

// ── 三种检索的入口校验 ──────────────────────────────────────────────
//
// 实测踩过（2026-11-04）：只按人或只按结果查时，被「query 不能为空」挡死。
// 主人明确要求三种检索都要能用，所以这条守着入口。

test('跑检索：只按人查、不带 query 也能出结果', async () => {
  const { 跑检索 } = await import('../lib/recall-tools.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const 目录 = mkdtempSync(join(tmpdir(), 'mv-q-'))
  try {
    const 文件 = join(目录, 'events.json')
    await 写事件库(文件, { 事件们: [
      { 事件: '宝宝的事', 日期: '2026-11-03', 结果: '做完了', 参与人: ['宝宝'], 提炼方式: '日记', 来源: 'private' },
      { 事件: '别人的事', 日期: '2026-11-03', 结果: '没解决', 参与人: ['企鹅'], 提炼方式: '话题', 来源: 'group:1' },
    ] })

    const 公共 = { 日记根: '', 仓库根: 目录, 分层库文件: '', 导入目录: '', 事件库文件: 文件, 说: () => {} }

    const 按人 = await 跑检索({ args: { query: '', 人: '宝宝', 来源: '*' }, ...公共 })
    assert.equal(按人.命中数, 1, '按人查该有结果，不该被 query 为空挡住')
    assert.ok(按人.text.includes('宝宝的事'))

    const 按结果 = await 跑检索({ args: { query: '', 只看未解决: true, 来源: '*' }, ...公共 })
    assert.equal(按结果.命中数, 1, '按未解决查该有结果')
    assert.ok(按结果.text.includes('别人的事'))

    // 一个条件都不给 → 明确提示，而不是空跑
    const 空 = await 跑检索({ args: { query: '', 来源: '*' }, ...公共 })
    assert.equal(空.命中数, 0)
    assert.match(空.text, /至少要给一个条件/)
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

// ── 回查坐标语义 ────────────────────────────────────────────────────
//
// 实测踩过两次（2026-11-04）：
//   第一次把日记的 ISO 时间戳直接塞进「时间」，回查 slice(0,8) 得到 '2026-11-'。
//   第二次改成 HH:MM:SS 得到 '05:35:16' —— 还是找不到，
//   因为 11-03 私聊里根本没有 05:35 那一段。
//
// 根因：日记条目的 at 是「这条日记被写下来的时间」，不是「那句话在聊天里出现的时间」。
// 事后补记时两者对不上是常态。所以日记事件的回查坐标**不该带具体时间**。

test('日记事件的回查坐标不带时间（按整天回查，不按秒）', (t) => {
  const 根 = 造日记库(t, [['private', '2026-11-03', [
    { id: 'd1', title: '光顾着回话', text: '正文', at: '2026-11-03T05:35:16.754Z' },
  ]]])
  const [ev] = 读日记事件(根, 'private', '2026-11-03')
  assert.equal(ev.回查[0].时间, '', '不能让调用方拿写日记的时刻去聊天里定位')
  assert.equal(ev.回查[0].日期, '2026-11-03', '要能按日期定位到那天')
  assert.equal(ev.回查[0].写入时刻, '05:35:16', '写入时刻单独存，仅作展示')
  assert.equal(ev.回查[0].日记id, 'd1')
})

test('提时钟：ISO 与 HH:MM:SS 都能取到，认不出返回空串', async () => {
  const { 提时钟 } = await import('../lib/recall-events-store.js')
  assert.equal(提时钟('2026-11-03T05:35:16.754Z'), '05:35:16')
  assert.equal(提时钟('05:35:16'), '05:35:16')
  assert.equal(提时钟('5:35'), '05:35:00')
  for (const 坏 of ['', null, undefined, '乱写']) {
    assert.equal(提时钟(坏), '', `${JSON.stringify(坏)} 该返回空串`)
  }
})

test('话题价值分：小群的正事不能因为命中次数少就被判死', async () => {
  const { 聚话题, 话题价值分 } = await import('../lib/recall-topics.js')
  // 小群：一个话题只被提了 3 次，但有 3 个人参与、内容有实质信息
  const 小群 = [
    { 时间: '10:00', 昵称: '甲', 内容: '新写的日记插件在哪', 日期: '2026-11-03' },
    { 时间: '10:01', 昵称: '乙', 内容: '日记插件在仓库里', 日期: '2026-11-03' },
    { 时间: '10:02', 昵称: '丙', 内容: '日记插件要怎么装', 日期: '2026-11-03' },
  ]
  const [t] = 聚话题(小群, { 最少次数: 2, 最少人: 2 })
  assert.ok(t, '该聚出话题')
  const 分 = 话题价值分(t)
  assert.ok(分 >= 0.5, `小群正事该过 0.5 线，实际 ${分}`)
})

// ── 时间衰减（主干要求）───────────────────────────────────────────────
//
// 主人 2026-11-04：「事件层也加上时间权重，过久没人提起就不检索」。
// 复用分层库那套规则（每月降一层、12 层归档、命中回满），
// 但参照时间是「事件发生的时间」而不是「入索引的时间」。

test('时间衰减：越久的事系数越低', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const 现在 = Date.parse('2026-11-04T12:00:00Z')
  const 造 = (天前, 名) => ({
    事件: 名,
    日期: new Date(现在 - 天前 * 86400000).toISOString().slice(0, 10),
    起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g',
  })
  const r = 筛事件([造(1, 'a'), 造(90, 'b'), 造(300, 'c')], { 上限: 10, 现在 })
  const 找 = (名) => r.find((e) => e.事件 === 名)
  assert.ok(找('a').衰减系数 > 找('b').衰减系数, '新的该比旧的高')
  assert.ok(找('b').衰减系数 > 找('c').衰减系数, '旧的更低')
})

test('时间衰减：满 12 层（360 天）且无人提起 → 不返回', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const 现在 = Date.parse('2026-11-04T12:00:00Z')
  const 老 = {
    事件: '一年前的旧事',
    日期: new Date(现在 - 400 * 86400000).toISOString().slice(0, 10),
    起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g',
  }
  assert.equal(筛事件([老], { 上限: 10, 现在 }).length, 0, '一年以上没人提起就不该再检索')
})

test('时间衰减：被检索过的事件回到第 1 层', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const 现在 = Date.parse('2026-11-04T12:00:00Z')
  const 被提过 = {
    事件: '老事但常被问起',
    日期: new Date(现在 - 300 * 86400000).toISOString().slice(0, 10),
    起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g',
    lastHit: new Date(现在 - 86400000).toISOString(),
  }
  const [e] = 筛事件([被提过], { 上限: 10, 现在 })
  assert.ok(e, '被检索过的该能返回')
  assert.equal(e.衰减层级, 1, '命中过就该回满')
})

test('时间衰减：参照时间是事件发生时间，不是入库时间', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const 现在 = Date.parse('2026-11-04T12:00:00Z')
  // 一条很旧的聊天，今天刚被提炼出来 —— 不该因为「刚入库」就满权
  const 刚提炼的旧事 = {
    事件: '旧事',
    日期: '2025-01-01',
    起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g',
    created: new Date(现在).toISOString(),
  }
  const r = 筛事件([刚提炼的旧事], { 上限: 10, 现在 })
  assert.equal(r.length, 0, '一年前的旧事即使今天刚提炼，也该按旧事算')
})

test('时间衰减：时间缺失的事件压到最低层，不凭空给满分', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const r = 筛事件([{ 事件: '没日期', 日期: '', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g' }], { 上限: 10 })
  // 和分层库保持一致：时间缺失按最老处理 → 第 12 层、系数 0.3。
  // 注意**仍然返回**（归档为 false）—— 分层库就是这么定的：
  // 「降到第 12 层还没归档时，它仍应能被搜到，只是排序靠后」。
  // 事件层不能自己发明一套更严的规则，否则同一个数据在两个层里说法不一致。
  assert.equal(r.length, 1, '时间缺失仍该返回（与分层库一致）')
  assert.equal(r[0].衰减层级, 12, '但压到最低层')
  assert.equal(r[0].衰减系数, 0.3)
})

// ── 遗忘层（主人 2026-11-04 的要求）───────────────────────────────────
//
// 「第12层命名为遗忘层，用户可直接看到遗忘层来选择要不要彻底遗忘这个事件」
//
// 要点：遗忘层**不是黑洞**。满 12 层的事件要能被看到，
// 用户才能决定「救回来」还是「彻底忘掉」。
// 我最初写的是直接过滤掉 —— 那样用户连知道的机会都没有。

test('遗忘层：满 12 层的事件不进正常检索', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const 现在 = Date.parse('2026-11-04T12:00:00Z')
  const 老 = { 事件: '很久以前', 日期: '2025-01-01', 起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g' }
  assert.equal(筛事件([老], { 上限: 10, 现在 }).length, 0, '正常检索不该出现')
})

test('遗忘层：但用「只看遗忘层」能看见', async () => {
  const { 筛事件 } = await import('../lib/recall-events-store.js')
  const 现在 = Date.parse('2026-11-04T12:00:00Z')
  const 老 = { 事件: '很久以前', 日期: '2025-01-01', 起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g' }
  const r = 筛事件([老], { 只看遗忘层: true, 上限: 10, 现在 })
  assert.equal(r.length, 1, '遗忘层必须可见 —— 否则用户没法决定要不要彻底忘掉')
  assert.equal(r[0].遗忘层, true, '要打上遗忘层标记')
  assert.equal(r[0].衰减层级, 12)
})

test('救回：把遗忘层的事件拉回第 1 层', async () => {
  const { 写事件库, 读事件库, 筛事件, 救回 } = await import('../lib/recall-events-store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-rescue-'))
  try {
    const 文件 = join(目录, 'events.json')
    const 现在 = Date.parse('2026-11-04T12:00:00Z')
    await 写事件库(文件, { 事件们: [{ 事件: '旧事', 日期: '2025-01-01', 起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g' }], 统计: {} })
    assert.equal(筛事件(读事件库(文件).事件们, { 上限: 10, 现在 }).length, 0, '救之前看不见')

    const r = await 救回(文件, ['旧事'], 现在)
    assert.equal(r.ok, true)
    assert.equal(r.救回, 1)

    const 后 = 筛事件(读事件库(文件).事件们, { 上限: 10, 现在 })
    assert.equal(后.length, 1, '救之后该能看见')
    assert.equal(后[0].衰减层级, 1, '回到第 1 层')
    assert.ok(后[0].lastHit, '要记下命中时间')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('彻底遗忘：真的从事件库删掉', async () => {
  const { 写事件库, 读事件库, 彻底遗忘 } = await import('../lib/recall-events-store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-forget-'))
  try {
    const 文件 = join(目录, 'events.json')
    await 写事件库(文件, { 事件们: [
      { 事件: '要删的', 日期: '2026-11-01', 起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g' },
      { 事件: '留着的', 日期: '2026-11-02', 起: '10:00', 结果: 'y', 参与人: [], 提炼方式: '话题', 来源: 'g' },
    ], 统计: {} })

    const r = await 彻底遗忘(文件, ['要删的'])
    assert.equal(r.ok, true)
    assert.equal(r.删了, 1)

    const 后 = 读事件库(文件).事件们
    assert.equal(后.length, 1, '只该删一条')
    assert.equal(后[0].事件, '留着的')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('彻底遗忘：找不到时什么都不删，并明确回报', async () => {
  const { 写事件库, 读事件库, 彻底遗忘 } = await import('../lib/recall-events-store.js')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-forget2-'))
  try {
    const 文件 = join(目录, 'events.json')
    await 写事件库(文件, { 事件们: [{ 事件: '保留', 日期: '2026-11-01', 起: '10:00', 结果: 'x', 参与人: [], 提炼方式: '话题', 来源: 'g' }], 统计: {} })
    const r = await 彻底遗忘(文件, ['根本没有'])
    assert.equal(r.ok, false, '一条都没匹配上就不该报成功')
    assert.equal(r.删了, 0)
    assert.equal(读事件库(文件).事件们.length, 1, '不能误删')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})
