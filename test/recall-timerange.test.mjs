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
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
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

// ============================================================================
// 第二张截图（2026-11-04）：鱼说「我没找到，用『养鱼』搜也搜不出他昨晚最后那句」
//
// 问题不是「最后一句」，前半截才是断的：说话的记录里，同一个号一天能改八次名，
// 用户在群里看到的是「南瓜鸡」，存档里写的是别的名字。
// 还有「群主」「管理员」—— 那从来不是任何人的昵称，数据里根本没有身份字段。
// ============================================================================

import { 拆人名, 认身份, 昵称对得上 } from '../lib/recall-tools.js'

test('拆人名：普通昵称切成可匹配的碎片', () => {
  const r = 拆人名('南瓜鸡')
  assert.equal(r.称谓, '')
  assert.deepEqual(r.词们, ['南瓜鸡', '南瓜', '瓜鸡'])
})

test('拆人名：太长的昵称也不会把整串当唯一关键词', () => {
  // 实测过 4 字上限：昵称「负债な九尾天狐」取到的是「负债な九」，
  // 拿这个去 includes 永远匹配不上它自己。所以要能退化到片段。
  const r = 拆人名('负债な九尾天狐')
  assert.ok(r.词们.length > 0)
  assert.ok(昵称对得上('负债な九尾天狐', r.词们))
})

test('拆人名：「群主」「管理员」被认成身份，不进匹配池', () => {
  for (const v of ['群主', '管理员', '管理']) {
    const r = 拆人名(v)
    assert.ok(r.称谓, `${v} 该被认成身份`)
    assert.deepEqual(r.词们, [], `${v} 不该留下用来匹配的碎片`)
  }
})

test('拆人名：「群主龙娘」拆成身份 + 名字', () => {
  const r = 拆人名('群主龙娘')
  assert.equal(r.称谓, '群主')
  assert.equal(r.名, '龙娘')
  assert.deepEqual(r.词们, ['龙娘'])
})

test('拆人名：「管理人」是「管理 人」，不是「管理员 人」', () => {
  const r = 拆人名('管理人')
  assert.equal(r.名, '人')
  assert.deepEqual(r.词们, [], '单字不该进匹配池')
})

test('认身份：只认整串，不认「群主人」这种', () => {
  assert.equal(认身份('群主'), '群主')
  assert.equal(认身份('群 主'), '群主')
  assert.equal(认身份('admin'), '管理员')
  assert.equal(认身份('群主人'), '')
  assert.equal(认身份('小鱼儿'), '')
})

test('昵称对得上：改过名也能按碎片对上', () => {
  // 实测群 730783833 里 p83 一天之内叫过：
  const 曾用名 = ['GPT6Astra', '龙娘', '限时接入Claude', 'Claude（限时接入）', '魔丸']
  const 词们 = 拆人名('龙娘').词们
  assert.ok(曾用名.some((n) => 昵称对得上(n, 词们)), '用「龙娘」问该找得到')
  assert.ok(!昵称对得上('小鱼儿', 词们), '不相干的人不该被算进来')
})

test('昵称对得上：空名不匹配任何人（不能变成「匹配全部」）', () => {
  assert.equal(昵称对得上('', ['南瓜']), false)
  assert.equal(昵称对得上('南瓜教主', []), false)
})

// ── 真的走一遍检索 ──────────────────────────────────────────────────

/** 造一个「同一个号在不同日期改了名」的仓库 */
function 造改过名的仓库 (t) {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-name-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  writeFileSync(join(群, '2026-11-03.txt'),
    '[21:00:00] 南瓜教主(p18): 晚上好\n'
    + '[23:50:00] 南瓜教主(p18): 帮我画一张图\n'
    + '[23:59:12] 负债な九尾天狐(p18): 最后这句是我的\n'
    + '[23:59:42] 龙娘(p83): 你别哭\n')
  return 根
}

test('按时间查：用户用的名字和存档里的不一样也能找到', async (t) => {
  const 根 = 造改过名的仓库(t)
  // ① 用「天狐」问 —— 存档里就是这个名字
  let r = await 跑检索({
    args: { query: '', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, 人: '天狐', limit: 1 },
    ...公共(根),
  })
  assert.ok(r.text.includes('最后这句是我的'), `用「天狐」该找得到，实际：${r.text}`)
  // ② 用「南瓜」问 —— 同一个人前一天的旧名
  r = await 跑检索({
    args: { query: '', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, 人: '南瓜', limit: 1 },
    ...公共(根),
  })
  assert.ok(r.text.includes('帮我画一张图'), `用「南瓜」该找得到，实际：${r.text}`)
})

test('按时间查：名字对不上时说清「对不上」，不是只说「没有内容」', async (t) => {
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({
    args: { query: '', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, 人: '小鱼儿', limit: 1 },
    ...公共(根),
  })
  assert.equal(r.命中数, 0)
  assert.ok(!/^没有内容。$/.test(r.text))
  assert.match(r.text, /没有一条是「小鱼儿」说的/, `该告诉用户人没对上：${r.text}`)
  assert.match(r.text, /说过话的人/, '该列出当时谁说过话，方便用户换个名字再问')
})

test('按时间查：填「群主」时明确说清没有身份数据，而不是搜出一堆乱七八糟的', async (t) => {
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({
    args: { query: '', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, 人: '群主', limit: 3 },
    ...公共(根),
  })
  assert.equal(r.命中数, 0, '「群主」不是昵称，不该匹配到任何人')
  assert.match(r.text, /没有存过「群主」这类身份/)
})

test('按时间查：来源只给 group 不限定群号，也该搜到', async (t) => {
  // 实测风险：模型不知道群号，很可能只传 来源:'group'
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({
    args: { query: '', 来源: 'group', 止: '2026-11-03', 按时间: true, limit: 2 },
    ...公共(根),
  })
  assert.ok(r.text.includes('你别哭'), `只给 group 也该能查到群聊，实际：${r.text}`)
})

test('来源="*" 时按时间查要同时覆盖私聊和群聊', async (t) => {
  const 根 = 造改过名的仓库(t)
  mkdirSync(join(根, 'chat', 'private'), { recursive: true })
  writeFileSync(join(根, 'chat', 'private', '2026-11-03.txt'), '[23:59:50] 小鱼儿(p1): 私聊最后一句\n')
  const r = await 跑检索({
    args: { query: '', 来源: '*', 起: '2026-11-03', 止: '2026-11-03', 按时间: true, limit: 1 },
    ...公共(根),
  })
  assert.ok(r.text.includes('私聊最后一句'), `跨来源该取全局最新的那条，实际：${r.text}`)
})

// ── 只给人、不给 query、也不用 按时间 的情况 ────────────────────────
// 模型完全可能这么问（「小鱼儿最后一句说了什么」只传 人）。
// 这条路上以前有两处空集漏洞：聊天检索层没关键词直接返回空；
// 日期参数没透传下去。

test('只给「人」不给 query 也能找到人说的话（降级分支）', async (t) => {
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({
    args: { 人: '天狐', 来源: 'group:730783833' },
    ...公共(根),
  })
  assert.equal(r.命中数, 1, `该找到天狐说的那句，实际：${r.text}`)
  assert.ok(r.text.includes('最后这句是我的'))
})

test('降级分支：改过名的碎片也对得上', async (t) => {
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({ args: { 人: '南瓜', 来源: 'group:730783833' }, ...公共(根) })
  assert.ok(r.text.includes('帮我画一张图'), `用旧名该找得到，实际：${r.text}`)
})

test('降级分支：日期范围要真的生效', async (t) => {
  const 根 = 造改过名的仓库(t)
  const 前 = await 跑检索({
    args: { 起: '2026-11-02', 止: '2026-11-02', 来源: 'group:730783833' },
    ...公共(根),
  })
  assert.equal(前.命中数, 0, '11-02 没有聊天，不该返回 11-03 的内容')
  assert.match(前.text, /2026-11-02/)
})

test('降级分支：人名对不上时说清原因', async (t) => {
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({ args: { 人: '小鱼儿', 来源: 'group:730783833' }, ...公共(根) })
  assert.equal(r.命中数, 0)
  assert.match(r.text, /没有昵称含「小鱼儿」的消息/)
})

test('降级分支：填「群主」时同样说清没有身份数据', async (t) => {
  const 根 = 造改过名的仓库(t)
  const r = await 跑检索({ args: { 人: '群主', 来源: 'group:730783833' }, ...公共(根) })
  assert.equal(r.命中数, 0)
  assert.match(r.text, /没有存过「群主」这类身份/)
})

test('只给人：那人说话在很早的位置也翻得到（不能只读最新几行）', async (t) => {
  // 实测踩过（云端真数据）：南瓜鸡 11-03 的话在文件第 972 行，
  // 「只读最新 N 行」时一条都读不到，结果是「查无此人」。
  const 根 = mkdtempSync(join(tmpdir(), 'mv-page-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  let 长 = ''
  for (let i = 0; i < 900; i++) 长 += `[1${i % 10}:00:00] 别人(p99): 刷屏${i}\n`
  长 += '[23:59:12] 南瓜鸡(p18): 我最后一句\n'
  writeFileSync(join(群, '2026-11-03.txt'), 长)

  const r = await 跑检索({ args: { 人: '南瓜', 来源: 'group' }, ...公共(根) })
  assert.ok(r.text.includes('我最后一句'), `900 行之外的那句也该翻到，实际：${r.text}`)
})

// ============================================================================
// 第三轮（2026-11-04）：主人说「不行」，因为修的全是**参数**，没修**模型怎么传参数**
//
// 实测云端：模型最自然的做法是把整句扔进 query ——
//   memory_recall { query: "南瓜鸡昨晚最后一句说的什么" }
// 这条路上事件层拿整串去子串匹配，0 命中，然后直接返回。
// 所以补三层：① 从整句拆出人/日期/模式 ② 事件层空了往下走 ③ 结果必须交代筛了什么
// ============================================================================

import { 拆询问 } from '../lib/recall-tools.js'

const 基准 = new Date('2026-11-04T09:00:00+08:00')

test('拆询问：整句「XX昨晚最后一句说的什么」拆成人+日期+要最近', () => {
  const r = 拆询问('南瓜鸡昨晚最后一句说的什么', 基准)
  assert.equal(r.人, '南瓜鸡')
  assert.equal(r.起, '2026-11-03', '「昨晚」要算成前一天')
  assert.equal(r.止, '2026-11-03')
  assert.equal(r.只看最近, true)
  assert.equal(r.剩余, '', '问句骨架不该留在关键词里')
})

test('拆询问：「搜群主…」开头有检索动词也能拆', () => {
  const r = 拆询问('搜群主昨天晚上最后一句说话的啥', 基准)
  assert.equal(r.人, '群主')
  assert.equal(r.起, '2026-11-03')
  assert.equal(r.只看最近, true)
})

test('拆询问：「早起说」这种不算问时间', () => {
  // 正则不能把「说」前面的「起」吃掉
  const r = 拆询问('南瓜鸡昨天说我们起晚了', 基准)
  assert.equal(r.人, '南瓜鸡')
  assert.equal(r.只看最近, false)
})

test('拆询问：纯主题不拆出人（关于画图那事怎么定的）', () => {
  const r = 拆询问('关于画图那事怎么定的', 基准)
  assert.equal(r.人, '')
  assert.equal(r.只看最近, false)
  assert.ok(r.剩余.length > 0, '关键词要留着')
})

test('拆询问：明确写出的日期也认', () => {
  const r = 拆询问('2026-11-03 最后 3 句', 基准)
  assert.equal(r.起, '2026-11-03')
  assert.equal(r.止, '2026-11-03')
  assert.equal(r.要几条, 3)
})

test('拆询问：认不出就原样返回，不把句子吃掉', () => {
  const r = 拆询问('天气怎么样', 基准)
  assert.equal(r.人, '')
  assert.equal(r.剩余, '天气怎么样')
})

// ── 整句 query 真的能答对 ───────────────────────────────────────────

test('整句 query（模型最自然的调用）能答对：南瓜鸡昨晚最后一句', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-nlq-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  // 数据要写在「昨天」那天，这样 拆询问 算出来的相对日期才对得上。
  // ⚠️ 先算好日期再写文件 —— 一开始写成「先写 11-03 再读出来改名」，
  // 结果改名那步把源文件读空了，测试自己造了个空仓库。
  const 昨天 = new Date(Date.now() - 86400000)
  const 昨串 = `${昨天.getFullYear()}-${String(昨天.getMonth() + 1).padStart(2, '0')}-${String(昨天.getDate()).padStart(2, '0')}`
  writeFileSync(join(群, `${昨串}.txt`),
    '[09:00:00] 小鱼儿(p1): 早上好\n'
    + '[16:33:40] 南瓜鸡(p6): 这句才是我说的\n'
    + '[23:59:42] 龙娘(p83): 别人最后一句\n')

  const { 跑检索 } = await import('../lib/recall-tools.js')
  // 注意：不传 人、不传 起止、不传 按时间 —— 全部要从 query 里拆

  const r = await 跑检索({
    args: { query: '南瓜鸡昨晚最后一句说的什么', 来源: 'group:730783833' },
    ...公共(根),
  })
  assert.ok(r.text.includes('这句才是我说的'), `该答出南瓜鸡那句，实际：${r.text}`)
  assert.ok(!r.text.includes('别人最后一句'), '不能返回别人的话')
  assert.match(r.text, /从提问里识别出/, '要告诉用户识别出了什么')
})

// ── 事件层 0 命中要往下走 ───────────────────────────────────────────

test('事件层 0 命中不再直接返回，落到原文检索', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-fall-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  writeFileSync(join(群, '2026-11-03.txt'), '[16:33:40] 南瓜鸡(p6): 原文里的答案\n')

  const { 写事件库 } = await import('../lib/recall-events-store.js')
  const 事件文件 = join(根, 'events.json')
  await 写事件库(事件文件, {
    事件们: [{ 事件: '无关的事', 日期: '2026-11-03', 起: '10:00', 结果: '别的', 参与人: ['甲'], 提炼方式: '话题', 来源: 'group:730783833' }],
    统计: {},
  })

  const { 跑检索 } = await import('../lib/recall-tools.js')
  const r = await 跑检索({
    args: { query: '原文里的', 来源: 'group:730783833' },
    日记根: '', 仓库根: 根, 分层库文件: '', 导入目录: '', 事件库文件: 事件文件, 说: () => {},
  })
  assert.ok(r.text.includes('原文里的答案'), `事件层空了该落到原文，实际：${r.text}`)
})

test('事件层命中时仍然是它先答（不能被原文抢走）', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-ev-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  mkdirSync(join(根, 'chat', 'group', '730783833'), { recursive: true })
  writeFileSync(join(根, 'chat', 'group', '730783833', '2026-11-03.txt'), '[16:33:40] 甲(p1): 原文\n')

  const { 写事件库 } = await import('../lib/recall-events-store.js')
  const 事件文件 = join(根, 'events.json')
  await 写事件库(事件文件, {
    事件们: [{ 事件: '修 nginx', 日期: '2026-11-03', 起: '16:00', 结果: '修好了', 参与人: ['甲'], 提炼方式: '话题', 来源: 'group:730783833' }],
    统计: {},
  })
  const { 跑检索 } = await import('../lib/recall-tools.js')
  const r = await 跑检索({
    args: { query: 'nginx', 来源: 'group:730783833' },
    日记根: '', 仓库根: 根, 分层库文件: '', 导入目录: '', 事件库文件: 事件文件, 说: () => {},
  })
  assert.ok(r.text.includes('【修 nginx】'), `事件命中时要走事件层，实际：${r.text}`)
})

// ── 条件不许被静默吞掉 ─────────────────────────────────────────────

test('按时间 + 人 + 事件库：人必须生效，不能被事件层接走', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-silent-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  writeFileSync(join(群, '2026-11-03.txt'),
    '[09:00:00] 小鱼儿(p1): 我要的这句\n'
    + '[23:59:42] 龙娘(p83): 别人的话\n')
  const { 写事件库 } = await import('../lib/recall-events-store.js')
  const 事件文件 = join(根, 'events.json')
  await 写事件库(事件文件, {
    事件们: [{ 事件: '无关', 日期: '2026-11-03', 起: '10:00', 结果: 'x', 参与人: ['小鱼儿'], 提炼方式: '话题', 来源: 'group:730783833' }],
    统计: {},
  })
  const { 跑检索 } = await import('../lib/recall-tools.js')
  const r = await 跑检索({
    args: { 人: '小鱼儿', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, limit: 3 },
    日记根: '', 仓库根: 根, 分层库文件: '', 导入目录: '', 事件库文件: 事件文件, 说: () => {},
  })
  assert.ok(r.text.includes('我要的这句'), `人这个条件被吞了，实际：${r.text}`)
  assert.ok(!r.text.includes('别人的话'), '不该返回别人的话')
})

test('按时间 + 人：结果里必须写清筛了多少条', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-trace-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  writeFileSync(join(群, '2026-11-03.txt'),
    '[09:00:00] 小鱼儿(p1): 一\n[10:00:00] 小鱼儿(p1): 二\n[23:00:00] 龙娘(p83): 三\n')
  const { 跑检索 } = await import('../lib/recall-tools.js')
  const r = await 跑检索({
    args: { 人: '小鱼儿', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, limit: 3 },
    ...公共(根),
  })
  // ⚠️ 以前断言的是「这个时间段共 N 条，筛后 M 条」——
  // 那个数字是拿两次各自被上限截断的调用相减算出来的，云端真数据下出现过
  // 「共 200 条，筛后 0 条」而下面明明列着 6 条。所以改成只报实际返回条数。
  assert.match(r.text, /条件：人=小鱼儿（返回 2 条/, `实际：${r.text}`)
})

test('按时间 + query 只有一个人名：也当人筛，不退化成「所有人的话」', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-bare-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  writeFileSync(join(群, '2026-11-03.txt'),
    '[09:00:00] 小鱼儿(p1): 我的\n[23:00:00] 龙娘(p83): 别人的\n')
  const { 跑检索 } = await import('../lib/recall-tools.js')
  const r = await 跑检索({
    args: { query: '小鱼儿', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, limit: 3 },
    ...公共(根),
  })
  assert.ok(r.text.includes('我的'), `实际：${r.text}`)
  assert.ok(!r.text.includes('别人的'), `人名要当人筛，实际：${r.text}`)
})

test('按时间查：人不存在时列出当时说过话的人', async (t) => {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-miss-'))
  t.after(() => rmSync(根, { recursive: true, force: true }))
  const 群 = join(根, 'chat', 'group', '730783833')
  mkdirSync(群, { recursive: true })
  writeFileSync(join(群, '2026-11-03.txt'), '[09:00:00] 小鱼儿(p1): 你好\n')
  const { 跑检索 } = await import('../lib/recall-tools.js')
  const r = await 跑检索({
    args: { query: '查无此人', 来源: 'group:730783833', 止: '2026-11-03', 按时间: true, limit: 3 },
    ...公共(根),
  })
  assert.equal(r.命中数, 0)
  assert.match(r.text, /说过话的人：小鱼儿/)
})
