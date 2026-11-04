/**
 * 时间范围检索的测试。
 *
 * 背景（2026-11-04）：用户发来一张截图 —— 他问「搜群主昨天晚上最后一句
 * 说话的啥」，鱼连翻三次都没答对：
 *   · 第一次答的是比赛的事（跑题）
 *   · 第二次「群主昨天那句我没找到，搜『群主』搜到的全是群成员列表」
 *   · 第三次用户追问「不是都存着了吗」
 *
 * 根因：检索只有「按相关度排序」一种模式。而「最后一句」「昨晚说了什么」
 * 根本不是在问相关度 —— 是在问时间。相关度排序永远回答不了「最后」，
 * 它只会说「最像」。
 *
 * 这个文件守住新增的三个参数：起 / 止 / 按时间。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { 按时间读聊天 } from '../lib/recall-ingest.js'
import { 规范日期, 跑检索 } from '../lib/recall-tools.js'

/** 造一个带两天聊天的临时仓库 */
function 造仓库 (t) {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-time-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const chat = join(根, 'chat', 'private')
  mkdirSync(chat, { recursive: true })
  writeFileSync(join(chat, '2026-11-02.txt'),
    '[09:00:00] 小鱼儿(p1): 前天早上\n[22:00:00] 小鱼儿(p1): 前天最后一句\n')
  writeFileSync(join(chat, '2026-11-03.txt'),
    '[08:00:00] 小鱼儿(p1): 昨天早上\n'
    + '[23:30:00] 小鱼儿(p1): 昨天最后一句\n'
    + '[23:40:00] 灰灰(p2): 灰灰最后一句\n')
  return 根
}

const 公共 = (根) => ({ 日记根: '', 仓库根: 根, 分层库文件: '', 导入目录: '', 事件库文件: '', 说: () => {} })

// ── 日期规范化 ──────────────────────────────────────────────────────

test('规范日期：标准写法原样返回', () => {
  assert.equal(规范日期('2026-11-03'), '2026-11-03')
})

test('规范日期：斜杠、补零都认', () => {
  assert.equal(规范日期('2026/11/3'), '2026-11-03')
  assert.equal(规范日期('2026/11/03'), '2026-11-03')
})

test('规范日期：只给月日时补当前年份', () => {
  const 年 = new Date().getFullYear()
  assert.equal(规范日期('11-03'), `${年}-11-03`)
})

test('规范日期：不存在的日期返回空串（不能原样接受）', () => {
  // 2026-13-45 格式对但那天不存在。原样返回的话，过滤时会一条都
  // 匹配不上 —— 用户看到「这个范围内没有内容」，以为是数据问题，
  // 实际是日期写错了。宁可返回空串让调用方知道参数无效。
  for (const 坏 of ['2026-13-45', '2026-02-30', '2026-00-01', '']) {
    assert.equal(规范日期(坏), '', `${坏} 该返回空串`)
  }
})

test('规范日期：认不出的写法返回空串，不猜', () => {
  for (const 坏 of ['昨天', 'yesterday', '去年', '2026年11月3日']) {
    assert.equal(规范日期(坏), '', `${坏} 不该被猜成某个日期`)
  }
})

// ── 按时间读聊天 ────────────────────────────────────────────────────

test('按时间读聊天：按时间倒序返回', (t) => {
  const 根 = 造仓库(t)
  const 条 = 按时间读聊天(根, { 起: '2026-11-03', 止: '2026-11-03', 上限: 10 })
  assert.equal(条.length, 3)
  assert.equal(条[0].内容, '灰灰最后一句', '最新的排最前')
  assert.equal(条[条.length - 1].内容, '昨天早上')
})

test('按时间读聊天：日期范围是闭区间', (t) => {
  const 根 = 造仓库(t)
  assert.equal(按时间读聊天(根, { 起: '2026-11-02', 止: '2026-11-02' }).length, 2)
  assert.equal(按时间读聊天(根, { 起: '2026-11-01', 止: '2026-11-03' }).length, 5)
  assert.equal(按时间读聊天(根, { 起: '2026-11-04' }).length, 0)
})

test('按时间读聊天：只给一端也能用', (t) => {
  const 根 = 造仓库(t)
  assert.equal(按时间读聊天(根, { 起: '2026-11-03' }).length, 3)
  assert.equal(按时间读聊天(根, { 止: '2026-11-02' }).length, 2)
})

test('按时间读聊天：只看某人', (t) => {
  const 根 = 造仓库(t)
  const 条 = 按时间读聊天(根, { 人: '灰灰' })
  assert.equal(条.length, 1)
  assert.equal(条[0].昵称, '灰灰')
})

test('按时间读聊天：上限生效', (t) => {
  const 根 = 造仓库(t)
  assert.equal(按时间读聊天(根, { 上限: 2 }).length, 2)
})

test('按时间读聊天：目录不存在时安全返回空', () => {
  assert.deepEqual(按时间读聊天('/tmp/肯定不存在-mv-time', {}), [])
})

// ── 跑检索的三个时间参数 ────────────────────────────────────────────

test('「昨天最后一句」能答对（截图里失败的那个场景）', async (t) => {
  const 根 = 造仓库(t)
  const r = await 跑检索({
    args: { query: '', 起: '2026-11-03', 止: '2026-11-03', 按时间: true, limit: 2, 来源: '*' },
    ...公共(根),
  })
  assert.ok(r.命中数 >= 1, '该有结果')
  assert.ok(r.text.includes('灰灰最后一句'), '最新的那条要排最前')
  // 关键：不能掉进「没有日记库 → 降级」那条分支去
  assert.ok(!r.text.includes('未配置日记库目录'), '按时间查不该走到降级分支')
})

test('「某人最后一句」能答对', async (t) => {
  const 根 = 造仓库(t)
  const r = await 跑检索({
    args: { query: '', 人: '小鱼儿', 按时间: true, limit: 2, 来源: '*' },
    ...公共(根),
  })
  assert.ok(r.text.includes('昨天最后一句'), '该是小鱼儿在 11-03 23:30 那句')
})

test('按时间查：query 为空也不会被「至少给一个条件」挡住', async (t) => {
  const 根 = 造仓库(t)
  for (const args of [
    { query: '', 起: '2026-11-03', 按时间: true, 来源: '*' },
    { query: '', 人: '灰灰', 按时间: true, 来源: '*' },
    { query: '', 起: '2026-11-03', 止: '2026-11-03', 来源: '*' },
  ]) {
    const r = await 跑检索({ args, ...公共(根) })
    assert.ok(!String(r.text).includes('至少要给一个条件'), `这些参数不该被挡住：${JSON.stringify(args)}`)
  }
})

test('什么条件都不给：明确提示（不空跑）', async (t) => {
  const 根 = 造仓库(t)
  const r = await 跑检索({ args: { query: '', 来源: '*' }, ...公共(根) })
  assert.equal(r.命中数, 0)
  assert.match(r.text, /至少要给一个条件/)
})

test('按时间查：范围里没内容时明确说，不是空白', async (t) => {
  const 根 = 造仓库(t)
  const r = await 跑检索({
    args: { query: '', 起: '2026-11-05', 止: '2026-11-05', 按时间: true, 来源: '*' },
    ...公共(根),
  })
  assert.equal(r.命中数, 0)
  assert.match(r.text, /没有内容/)
})

test('按时间查要跳过事件层（事件层没有「最后一句」概念）', async (t) => {
  // 实测踩过：问「11-03 最后 3 句」，事件层先返回了相关度匹配的事件，
  // 用户要的是「那天最后说了什么」，拿到的却是「和查询词最像的事」。
  const { 写事件库 } = await import('../lib/recall-events-store.js')
  const 根 = 造仓库(t)
  const 事件文件 = join(根, 'events.json')
  await 写事件库(事件文件, {
    事件们: [{ 事件: '日记（群里 48 条讨论）', 日期: '2026-11-03', 起: '10:22', 止: '11:35', 结果: '闲聊摘要', 参与人: ['甲'], 提炼方式: '话题', 来源: 'private' }],
    统计: {},
  })

  const r = await 跑检索({
    args: { query: '', 起: '2026-11-03', 止: '2026-11-03', 按时间: true, limit: 3, 来源: '*' },
    日记根: '', 仓库根: 根, 分层库文件: '', 导入目录: '', 事件库文件: 事件文件, 说: () => {},
  })
  assert.ok(r.text.includes('按时间倒序'), '该走时间检索')
  assert.ok(r.text.includes('灰灰最后一句'), '该返回原文最后一句')
  assert.ok(!r.text.includes('事件库'), '不该被事件层截走')
})
