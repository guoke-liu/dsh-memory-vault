/**
 * 投喂账本的测试。
 *
 * 背景（2026-11-04）：主人要求「给喂过大模型的聊天记录添加标签，避免反复投喂」。
 *
 * 做这个功能时发现原来的「已处理」集合有个致命 bug：
 * 它记的是「被规则分过层」的消息，而且**模型调用失败的那批也被记进去了**。
 * 一次网络抖动，那批消息就永远不会再送到模型面前 —— 数据永久丢失，不报任何错。
 * 实测复现：模型全失败，已处理却记了 2 条。
 *
 * 这个文件守住新的投喂账本：
 *   1. 只有模型成功返回才记账
 *   2. 记账按档位分开（同一条消息在「核心」和「全量」下送的内容不同，算两次投喂）
 *   3. 非法档位名直接报错，不静默猜一个
 *   4. 修剪账本不会误删还在的消息
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  空账本, 读账本, 已投喂, 记投喂, 批量记投喂,
  筛出未投喂, 账本统计, 归一档位, 修剪账本, 账本版本,
} from '../lib/recall-fed.js'

test('空账本有三个档位的空桶', () => {
  const 账 = 空账本()
  assert.equal(账.version, 账本版本)
  for (const 档 of ['full', 'screened', 'core']) {
    assert.deepEqual(账.按档位[档], {}, `${档} 档应该是空对象`)
  }
})

test('记一笔之后能查到，没记的查不到', () => {
  const 账 = 空账本()
  assert.equal(已投喂(账, 'f1', 'full'), false)
  记投喂(账, 'f1', 'full')
  assert.equal(已投喂(账, 'f1', 'full'), true)
  assert.equal(已投喂(账, 'f1', 'core'), false, '不同档位不能串')
  assert.equal(已投喂(账, 'f2', 'full'), false)
})

test('按档位分开记账：同一条消息在不同档位下各算一次', () => {
  const 账 = 空账本()
  记投喂(账, 'f1', 'screened')
  assert.equal(已投喂(账, 'f1', 'screened'), true)
  // 换成 full 档还没喂过 —— 送进去的内容不同，这是有意的
  assert.equal(已投喂(账, 'f1', 'full'), false)

  记投喂(账, 'f1', 'full')
  assert.equal(已投喂(账, 'f1', 'full'), true)
  assert.equal(账本统计(账).合计, 2, '两个档位各一条，合计 2')
})

test('非法档位名直接报错，不静默猜', () => {
  // 这是本模块最容易写错的地方：非法值静默回退到某一档，
  // 账单会记到错误的桶里，用户看到「明明喂过了又花钱」却查不出原因。
  //
  // 注意区分「需要归一」和「真的非法」：
  //   · 'FULL' / ' core ' 只是大小写和空白 —— 归一后合法，不该报错
  //   · '' / 'unknown' / null 是真的不认识 —— 必须报错
  for (const 坏 of ['', 'unknown', 'fulll', 'core2', null, undefined]) {
    assert.throws(() => 归一档位(坏), /未知档位/, `${JSON.stringify(坏)} 应该报错`)
  }
})

test('档位名的空白和大小写会被归一，不是不同档位', () => {
  assert.equal(归一档位('FULL'), 'full')
  assert.equal(归一档位(' Core '), 'core')
  assert.equal(归一档位('screened'), 'screened')
})

test('批量记投喂：返回真正新增的条数，重复的不算', () => {
  const 账 = 空账本()
  const 第一次 = 批量记投喂(账, ['a', 'b', 'c'], 'core')
  assert.equal(第一次, 3)
  const 第二次 = 批量记投喂(账, ['b', 'c', 'd'], 'core')
  assert.equal(第二次, 1, 'b、c 已经记过，只有 d 是新的')
  assert.equal(账本统计(账).按档位.core, 4)
})

test('批量记投喂：空数组、含空指纹都不炸', () => {
  const 账 = 空账本()
  assert.equal(批量记投喂(账, [], 'full'), 0)
  assert.equal(批量记投喂(账, [null, undefined, '', 'x'], 'full'), 1)
  assert.equal(批量记投喂(账, null, 'full'), 0)
})

test('筛出未投喂：分开返回待喂和已喂的条数', () => {
  const 账 = 空账本()
  记投喂(账, 'f1', 'core')
  const 候选 = [{ 指纹: 'f1' }, { 指纹: 'f2' }, { 指纹: 'f3' }]
  const r = 筛出未投喂(账, 候选, 'core')
  assert.deepEqual(r.待投喂.map((x) => x.指纹), ['f2', 'f3'])
  assert.equal(r.已喂过, 1)
})

test('筛出未投喂：换档位后全部变成待喂', () => {
  const 账 = 空账本()
  const 候选 = [{ 指纹: 'f1' }, { 指纹: 'f2' }]
  批量记投喂(账, ['f1', 'f2'], 'screened')
  assert.equal(筛出未投喂(账, 候选, 'screened').待投喂.length, 0)
  assert.equal(筛出未投喂(账, 候选, 'full').待投喂.length, 2)
})

test('账本统计按档位计数', () => {
  const 账 = 空账本()
  批量记投喂(账, ['a', 'b'], 'full')
  批量记投喂(账, ['a'], 'core')
  const 统计 = 账本统计(账)
  assert.equal(统计.按档位.full, 2)
  assert.equal(统计.按档位.core, 1)
  assert.equal(统计.按档位.screened, 0)
  assert.equal(统计.合计, 3)
})

test('读账本：没有字段、格式错、null 都返回空账本', () => {
  for (const 入 of [null, undefined, {}, { 投喂账本: null }, { 投喂账本: 'text' }, { 投喂账本: { 按档位: 'bad' } }]) {
    const 账 = 读账本(入)
    assert.equal(账.version, 账本版本)
    assert.equal(账本统计(账).合计, 0, `${JSON.stringify(入)} 应该读成空账本`)
  }
})

test('读账本：老版本分层库（没有这个字段）读出来是空的，不报错', () => {
  // 1.5.1 之前的分层库没有 投喂账本 字段。读成空账本意味着「还没喂过」，
  // 下次会全量喂一遍 —— 多花一次钱，但不会丢数据。这比崩掉好。
  const 老库 = { version: 1, 已处理: ['a', 'b'], 分组: [] }
  const 账 = 读账本(老库)
  assert.equal(账本统计(账).合计, 0)
})

test('读账本：已有的记账不丢', () => {
  const 账 = 空账本()
  批量记投喂(账, ['a', 'b'], 'full')
  const 再读 = 读账本({ 投喂账本: 账 })
  assert.equal(已投喂(再读, 'a', 'full'), true)
  assert.equal(已投喂(再读, 'b', 'full'), true)
})

test('读账本：丢弃未知档位的桶，不把脏数据带进内存', () => {
  const 脏 = { 投喂账本: { version: 1, 按档位: { full: { a: {} }, 不存在的档: { b: {} } } } }
  const 账 = 读账本(脏)
  assert.equal(账本统计(账).按档位.full, 1)
  assert.equal(账.按档位['不存在的档'], undefined)
})

test('修剪账本：删掉已经不存在的消息的记账', () => {
  const 账 = 空账本()
  批量记投喂(账, ['活1', '活2', '死1', '死2'], 'core')
  const r = 修剪账本(账, new Set(['活1', '活2']))
  assert.equal(r.删除, 2)
  assert.equal(已投喂(账, '活1', 'core'), true)
  assert.equal(已投喂(账, '死1', 'core'), false)
})

test('修剪账本：所有档位一起修，不会只修一个', () => {
  const 账 = 空账本()
  记投喂(账, '活', 'full')
  记投喂(账, '死', 'full')
  记投喂(账, '死', 'core')
  修剪账本(账, ['活'])
  assert.equal(已投喂(账, '死', 'full'), false)
  assert.equal(已投喂(账, '死', 'core'), false)
  assert.equal(已投喂(账, '活', 'full'), true)
})

test('修剪账本：传数组也能用', () => {
  const 账 = 空账本()
  批量记投喂(账, ['a', 'b'], 'core')
  const r = 修剪账本(账, ['a'])
  assert.equal(r.删除, 1)
})

test('修剪账本：非法输入安全返回', () => {
  const 账 = 空账本()
  for (const 入 of [null, undefined, 'text', 123]) {
    assert.doesNotThrow(() => 修剪账本(账, 入))
  }
})

test('记账带时间戳，能查到是什么时候喂的', () => {
  const 账 = 空账本()
  记投喂(账, 'f1', 'full', { 时间: '2026-11-04T10:00:00.000Z' })
  assert.equal(账.按档位.full.f1.at, '2026-11-04T10:00:00.000Z')
})

test('记账能关联事件名（事件引擎上线后要用）', () => {
  const 账 = 空账本()
  记投喂(账, 'f1', 'full', { 事件: '修 nginx 404' })
  assert.equal(账.按档位.full.f1.事件, '修 nginx 404')
})

test('不传时间时自动打当前时间戳', () => {
  const 账 = 空账本()
  记投喂(账, 'f1', 'full')
  assert.ok(账.按档位.full.f1.at, '应该有 at 字段')
  assert.doesNotThrow(() => new Date(账.按档位.full.f1.at).toISOString())
})

// ── 重新投喂：扣账与日期解析 ─────────────────────────────────────────
//
// 背景（2026-11-04）：主人要求「用户对某天投喂不满意时能手动重新投喂」。
//
// 关键设计：重喂走**扣账**，不是「绕过账本」。
// 绕过（传个 force 让判断恒返回 false）的后果是那些消息永远不会被记为
// 已投喂 —— 每跑一次就重花一次钱，账本上一条记录都没有，用户查不出钱花在哪。
// 下面这些用例就是守住这条线。

import { 扣账, 按日期扣账, 解析日期范围, 日期在范围内 } from '../lib/recall-fed.js'

test('扣账：抹掉指定指纹，只影响指定档位', () => {
  const 账 = 空账本()
  批量记投喂(账, ['a', 'b', 'c'], 'screened')
  批量记投喂(账, ['a', 'b', 'c'], 'core')
  const r = 扣账(账, ['a', 'b'], 'screened')
  assert.equal(r.扣掉, 2)
  assert.equal(已投喂(账, 'a', 'screened'), false)
  assert.equal(已投喂(账, 'c', 'screened'), true, '没点名的不该被动')
  assert.equal(已投喂(账, 'a', 'core'), true, '别的档位不该被动')
})

test('扣账：扣不存在的指纹不会报错，也不虚报', () => {
  const 账 = 空账本()
  批量记投喂(账, ['a'], 'full')
  assert.equal(扣账(账, ['不存在', 'a'], 'full').扣掉, 1)
  assert.equal(扣账(账, ['a'], 'full').扣掉, 0, '已经扣过了再扣是 0')
})

test('扣账：非法输入安全返回', () => {
  const 账 = 空账本()
  for (const 入 of [null, undefined, [], 'text']) {
    assert.doesNotThrow(() => 扣账(账, 入, 'full'))
  }
  assert.throws(() => 扣账(账, ['a'], '乱写'), /未知档位/, '非法档位要报错')
})

test('扣掉的账再筛，会变回待投喂（这才是重喂的关键）', () => {
  const 账 = 空账本()
  批量记投喂(账, ['a', 'b'], 'core')
  const 候选 = [{ 指纹: 'a' }, { 指纹: 'b' }]
  assert.equal(筛出未投喂(账, 候选, 'core').待投喂.length, 0)

  扣账(账, ['a'], 'core')
  const r = 筛出未投喂(账, 候选, 'core')
  assert.deepEqual(r.待投喂.map((x) => x.指纹), ['a'], '扣掉的那条要重新变成待喂')
  assert.equal(r.已喂过, 1, '没扣的那条仍然跳过')
})

test('按日期扣账：是扣账的别名，行为一致', () => {
  const 账 = 空账本()
  批量记投喂(账, ['x', 'y'], 'screened')
  assert.equal(按日期扣账(账, ['x'], 'screened').扣掉, 1)
  assert.equal(已投喂(账, 'x', 'screened'), false)
  assert.equal(已投喂(账, 'y', 'screened'), true)
})

test('解析日期范围：单日', () => {
  const r = 解析日期范围('2026-11-03')
  assert.deepEqual(r, { 起: '2026-11-03', 止: '2026-11-03', 是区间: false })
})

test('解析日期范围：区间支持多种分隔符', () => {
  for (const 写法 of ['2026-11-01..2026-11-03', '2026-11-01~2026-11-03', '2026-11-01 至 2026-11-03', '2026-11-01到2026-11-03']) {
    const r = 解析日期范围(写法)
    assert.equal(r.起, '2026-11-01', `${写法} 的起始错了`)
    assert.equal(r.止, '2026-11-03', `${写法} 的结束错了`)
    assert.equal(r.是区间, true)
  }
})

test('解析日期范围：两侧空白不影响', () => {
  const r = 解析日期范围('  2026-11-01 .. 2026-11-03  ')
  assert.equal(r.起, '2026-11-01')
  assert.equal(r.止, '2026-11-03')
})

test('解析日期范围：看不懂的写法必须报错，不能猜', () => {
  // 猜错方向的代价非常实在：「重喂 11-03」被解析成年初到现在，
  // 用户以为只花一天的钱，实际把整个库重喂了一遍。
  for (const 坏 of ['11月2号', '2026/11/03', '2026-11-03 之后', '', '昨天', '2026-11']) {
    assert.throws(() => 解析日期范围(坏), /日期|看不懂/, `${JSON.stringify(坏)} 应该报错`)
  }
})

test('解析日期范围：不存在的日期要报错', () => {
  // 格式对但日子不存在，静默接受会得到一个空区间 ——
  // 用户以为重喂了，其实什么都没发生
  assert.throws(() => 解析日期范围('2026-02-30'), /不存在/)
  assert.throws(() => 解析日期范围('2026-13-01'), /不存在/)
})

test('解析日期范围：起始晚于结束要报错', () => {
  assert.throws(() => 解析日期范围('2026-11-05..2026-11-01'), /晚于/)
})

test('日期在范围内：闭区间两端都算', () => {
  const 范围 = 解析日期范围('2026-11-01..2026-11-03')
  assert.equal(日期在范围内('2026-11-01', 范围), true)
  assert.equal(日期在范围内('2026-11-02', 范围), true)
  assert.equal(日期在范围内('2026-11-03', 范围), true)
  assert.equal(日期在范围内('2026-10-31', 范围), false)
  assert.equal(日期在范围内('2026-11-04', 范围), false)
})

test('日期在范围内：非法输入返回 false 不抛错', () => {
  const 范围 = 解析日期范围('2026-11-01')
  for (const 入 of [null, undefined, '', 0]) {
    assert.doesNotThrow(() => 日期在范围内(入, 范围))
    assert.equal(日期在范围内(入, 范围), false)
  }
  assert.equal(日期在范围内('2026-11-01', null), false)
})
