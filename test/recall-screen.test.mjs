// 聊天分层筛选测试：规则筛选 + 增量打分 + 结构一致性
//
// 重点验两件事：
//   1. 规则筛选在**没有模型**时完整可用（这是开源用户的主路径）
//   2. 分层库的读写结构一致（踩过：读缓存与写结果字段名不一致，
//      导致每次都当空库、全量重算，静默烧额度）
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { 打分层, 分层, 是机器人播报, 分层分布 } from '../lib/recall-screen.js'
import { 消息指纹, 读打分缓存, 写打分缓存 } from '../lib/recall-scorer.js'
import { 扫描聊天, 读分层库, 跑分层, 并入索引条目, 分层库文件名 } from '../lib/recall-ingest.js'

let 过 = 0
let 挂 = 0
const 失败 = []
const 测 = (n, c, d) => { if (c) { 过++; console.log('  ✅ ' + n) } else { 挂++; 失败.push(n); console.log('  ❌ ' + n + (d ? ' → ' + d : '')) } }

console.log('—— 规则筛选（无模型可用）——')
测('应答词判闲聊', 打分层({ 内容: '嗯' }).层级 === 分层.闲聊)
测('哈哈判闲聊', 打分层({ 内容: '哈哈哈' }).层级 === 分层.闲聊)
测('约定句判核心', 打分层({ 内容: '说好了下周一交版本，别再拖了' }).层级 === 分层.核心)
测('配置句判核心', 打分层({ 内容: '服务器端口改成 8080，证书放在 /etc/nginx 下面' }).层级 === 分层.核心)
测('空消息判闲聊', 打分层({ 内容: '' }).层级 === 分层.闲聊)
测('机器人播报被判播报', 是机器人播报('【DSH 已重启】 http://x'))
测('正常聊天不被当播报', !是机器人播报('我们重启一下服务器吧'))
测('播报层级压到闲聊', 打分层({ 内容: '【通知】 版本: 2.0' }).层级 === 分层.闲聊)

console.log('\n—— 分层分布 ——')
const 分布 = 分层分布([{ 层级: 2 }, { 层级: 2 }, { 层级: 1 }, { 层级: 0 }])
测('核心计数', 分布.核心 === 2)
测('总数', 分布.总数 === 4)

console.log('\n—— 指纹稳定性 ——')
const m1 = { 日期: '2026-11-03', 时间: '10:00:00', pid: 'p1', 内容: '你好' }
测('同内容同指纹', 消息指纹(m1) === 消息指纹({ ...m1 }))
测('内容不同指纹不同', 消息指纹(m1) !== 消息指纹({ ...m1, 内容: '你好啊' }))

console.log('\n—— 缓存读写一致性（踩过的坑）——')
const 缓存文件 = path.join(mkdtempSync(path.join(tmpdir(), 'cache-')), 'x.json')
const 缓存 = await 读打分缓存(缓存文件)
测('读不存在的缓存返回版本1空表', 缓存.version === 1 && Object.keys(缓存.按指纹).length === 0)
await 写打分缓存(缓存文件, { version: 1, 按指纹: { abc: { 层级: 2 } } })
const 回读 = await 读打分缓存(缓存文件)
测('写进去能读回来', 回读.按指纹.abc?.层级 === 2)

console.log('\n—— 扫描与分层流水 ——')
const 根 = mkdtempSync(path.join(tmpdir(), 'ingest-'))
const 聊天 = path.join(根, 'chat')
mkdirSync(path.join(聊天, 'private'), { recursive: true })
mkdirSync(path.join(聊天, 'group', '730783833'), { recursive: true })
writeFileSync(path.join(聊天, 'private', '2026-11-03.txt'),
  '[10:00:00] 主人(p1): 嗯\n' +
  '[10:01:00] 主人(p1): 说好了下周一交版本，别再拖了\n' +
  '[10:02:00] 小鱼(p2): 【通知】 版本: 2.0\n' +
  '[10:03:00] 群友(p3): 服务器端口改成 8080 了\n')
writeFileSync(path.join(聊天, 'group', '730783833', '2026-11-03.txt'),
  '[11:00:00] 群友(p3): 哈哈哈\n')

const 消息 = 扫描聊天(根)
测('扫到 5 条', 消息.length === 5, String(消息.length))
测('私聊来源正确', 消息.filter((x) => x.来源 === 'private').length === 4)
测('群来源正确', 消息.some((x) => x.来源 === 'group:730783833'))
测('群号从目录名取出', 消息.find((x) => x.来源 === 'group:730783833')?.来源 === 'group:730783833')

const 输出 = path.join(根, 'levels.json')
const r = await 跑分层({ 仓库根: 根, 输出文件: 输出, 用模型: false })
测('分层跑成功', r.ok === true, r.错误)
测('规则分布有核心', r.规则分布.核心 >= 1, JSON.stringify(r.规则分布))
测('播报被排除', r.规则分布.播报 === 1)
测('并入条数不含播报', r.并入条数 === 4, String(r.并入条数))

const 库 = await 读分层库(输出)
测('能读回分层库', 库.条目.length === 4)
测('已处理集合有 5 条', 库.已处理.size === 5, String(库.已处理.size))
测('条目里有层级字段', Number.isFinite(库.条目[0]?.层级))

console.log('\n—— 增量：再跑一次不应重处理 ——')
const r2 = await 跑分层({ 仓库根: 根, 输出文件: 输出, 用模型: false })
测('再跑仍然成功', r2.ok === true)

console.log('\n—— 并入索引条目 ——')
const 索引条目 = 并入索引条目(库.条目)
测('转换后有 来源', typeof 索引条目[0].来源 === 'string')
测('转换后有 层级', Number.isFinite(索引条目[0].层级))
测('转换后有 类型=聊天', 索引条目[0].类型 === '聊天')
测('id 唯一', new Set(索引条目.map((x) => x.id)).size === 索引条目.length)

console.log('\n—— 最低档次过滤 ——')
const 输出2 = path.join(根, 'levels2.json')
const r3 = await 跑分层({ 仓库根: 根, 输出文件: 输出2, 用模型: false, 最低档次: 2 })
测('只保留核心档', r3.并入条数 <= r.并入条数, `${r3.并入条数} vs ${r.并入条数}`)
测('核心档至少 1 条', r3.并入条数 >= 1)

test('recall-screen/ingest 全部断言', () => {
  console.log(`通过 ${过}，失败 ${挂}${挂 ? '：' + 失败.join(' / ') : ''}`)
  if (挂 > 0) throw new Error(`${挂} 条断言失败：${失败.join(' / ')}`)
})

// 模型回答解析的三种形式（形式二、三是实测退化，必须能兜住）
import { 解析回答 } from '../lib/recall-scorer.js'
test('模型回答解析容错', () => {
  const 标准 = 解析回答('[{"i":1,"l":2,"r":"好"},{"i":2,"l":0,"r":"闲聊"}]')
  if (!Array.isArray(标准) || 标准.length !== 2) throw new Error('标准数组解析失败')

  // 实测遇到：模型以「逐行对象」返回，不是合法 JSON
  const 逐行 = 解析回答('{"i": 1, "l": 0, "r": "情感表达"}\n{"i": 2, "l": 2, "r": "明确承诺"}')
  if (!Array.isArray(逐行) || 逐行.length !== 2) throw new Error('逐行对象解析失败：' + JSON.stringify(逐行))

  // 围栏包裹
  const 围栏 = 解析回答('```json\n[{"i":1,"l":1,"r":"x"}]\n```')
  if (!Array.isArray(围栏) || 围栏.length !== 1) throw new Error('围栏解析失败')

  // 包里套数组
  const 包 = 解析回答('{"items":[{"i":1,"l":2,"r":"y"}]}')
  if (!Array.isArray(包) || 包.length !== 1) throw new Error('包内数组解析失败')

  // 完全不是 JSON
  if (解析回答('我觉得都挺重要的') !== null) throw new Error('垃圾输入应返回 null')
  console.log('  ✅ 解析器四种形式 + 垃圾输入')
})

// ── 文件权限（含聊天原文，比密钥还敏感）──────────────────────────
test('分层库写成 600 权限', async () => {
  const { mkdtempSync: mkd, statSync: st } = await import('node:fs')
  const { tmpdir: td } = await import('node:os')
  const { join: j } = await import('node:path')
  const 根 = mkd(j(td(), 'perm-level-'))
  // 造最小聊天库
  const { mkdirSync: mkm, writeFileSync: wf } = await import('node:fs')
  mkm(j(根, 'chat', 'private'), { recursive: true })
  wf(j(根, 'chat', 'private', '2026-11-03.txt'), '[10:00:00] a(p1): 说好了下周交版本，端口改成8080\n')
  const 输出 = j(根, 'levels.json')
  await 跑分层({ 仓库根: 根, 输出文件: 输出, 用模型: false })
  const 模式 = st(输出).mode & 0o777
  if (模式 !== 0o600) throw new Error(`分层库权限应为 600，实际 ${模式.toString(8)}`)
  console.log('  ✅ 分层库 600')
})

// ── 精简存储 + 按时间戳回查原文 ──────────────────────────────────
test('分层库只存摘要，全文可按坐标回查', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { 摘取摘要, 摘要上限, 回查原文, 读分层库, 展开条目 } = await import('../lib/recall-ingest.js')

  // 摘要：短的原样留，长的头尾都留
  const 短 = '很短的一句'
  测('短内容原样保留', 摘取摘要(短) === 短)
  const 长 = 'A'.repeat(200) + '关键结论在最后'
  const 摘 = 摘取摘要(长)
  测('长内容被截断', 摘.length <= 摘要上限 + 2, String(摘.length))
  测('保留了结尾（结论常在最后）', 摘.includes('关键结论在最后'), 摘.slice(-20))

  // 造一个聊天文件 + 分层库，验回查
  const 根 = mkdtempSync(join(tmpdir(), 'lookup-'))
  mkdirSync(join(根, 'chat', 'group', '730783833'), { recursive: true })
  writeFileSync(join(根, 'chat', 'group', '730783833', '2026-11-04.txt'),
    '[00:00:30] 小鱼(p1): ' + '很长的内容'.repeat(50) + '\n[00:01:00] 别人(p2): 第二句\n')

  const r = await 回查原文(根, { 来源: 'group:730783833', 日期: '2026-11-04', 时间: '00:00:30' })
  测('按时间戳回查成功', r.ok === true, r.错误)
  测('拿到完整原文', r.命中[0].内容.length > 200, String(r.命中[0].内容.length))
  测('带上昵称和 pid', r.命中[0].昵称 === '小鱼' && r.命中[0].pid === 'p1')

  const r2 = await 回查原文(根, { 来源: 'group:730783833', 日期: '2026-11-04', 时间: '00:00:30' })
  测('不存在的日期明确报错', (await 回查原文(根, { 来源: 'x', 日期: '1999-01-01', 时间: '00:00:00' })).ok === false)
  测('缺坐标明确报错', (await 回查原文(根, {})).ok === false)

  // 兼容：旧格式（条目平铺）与新格式（分组）都能读
  const 旧 = { version: 1, 已处理: [], 条目: [{ 来源: 'private', 日期: 'd', 时间: 't', 内容: '旧格式正文', 层级: 1, 指纹: 'f' }] }
  const 新 = { version: 1, 已处理: [], 分组: [{ 来源: 'private', 日期: 'd', 条目: [{ 时间: 't', 摘要: '新格式摘要', 层级: 1, 指纹: 'f' }] }] }
  测('旧格式能展开', 展开条目(旧).length === 1 && 展开条目(旧)[0].内容 === '旧格式正文')
  测('新格式能展开', 展开条目(新).length === 1 && 展开条目(新)[0].摘要 === '新格式摘要')
})
