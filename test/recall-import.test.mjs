// 通用导入测试：形状识别、字段映射、文本日记切分、幂等性
//
// 数据形状照**真实导出格式**构造，不是自己编的：
//   · Day One：text / creationDate / uuid / photos[] —— 见
//     JeffersonQin/dayone2markdown/converter.py 与
//     danseethaler/dayone-to-md/src/index.js（两处字段一致）
//   · 其余为通用 JSON / Markdown
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  识别输入形状, 解析成条目, 转条目, 读文本日记, 条目指纹,
  导入, 内置映射, 取映射,
} from '../lib/recall-import.js'

let 过 = 0
let 挂 = 0
const 失败 = []
const 测 = (n, c, d) => { if (c) { 过++; console.log('  ✅ ' + n) } else { 挂++; 失败.push(n); console.log('  ❌ ' + n + (d ? ' → ' + d : '')) } }

console.log('—— 形状识别 ——')
测('数组', 识别输入形状([{ text: 'a' }]) === 'array')
测('{entries:[]}', 识别输入形状({ entries: [] }) === 'entries')
测('{items:[]}', 识别输入形状({ items: [] }) === 'entries')
测('按日期分组', 识别输入形状({ '2026-11-03': [] }) === 'byDate')
测('JSONL 文本', 识别输入形状('{"a":1}\n{"b":2}') === 'jsonl')
测('Markdown 文本', 识别输入形状('## 2026-11-03\n今天') === 'markdown')
测('空串', 识别输入形状('') === '')
测('无法识别', 识别输入形状(42) === '')

console.log('\n—— Day One 真实字段（GitHub 上的实现都这么拼）——')
const 一日 = { text: '今天的日记内容', creationDate: '2026-01-05T23:59:00Z', uuid: 'ABCD-1234', tags: ['a'] }
const 转后 = 转条目(一日, 取映射('dayone'))
测('text 取到正文', 转后.text === '今天的日记内容')
测('creationDate 取到日期（不是今天）', 转后.日期 === '2026-01-05', 转后.日期)
测('uuid 取到 id', 转后.id === 'ABCD-1234')
测('tags 取到标签', 转后.tags.includes('a'))

console.log('\n—— 常见日期字段都能认 ——')
const 日期用例 = [
  [{ creationDate: '2026-01-05T10:00:00Z' }, '2026-01-05'],
  [{ createdAt: '2026-02-03T00:00:00Z' }, '2026-02-03'],
  [{ date: '2026-03-07' }, '2026-03-07'],
  [{ day: '2026/04/09' }, '2026-04-09'],
  [{ timestamp: '2026-05-11T00:00:00Z' }, '2026-05-11'],
]
for (const [obj, 期望] of 日期用例) {
  const r = 转条目({ text: 'x', ...obj })
  测(`日期 ${Object.keys(obj)[0]}`, r.日期 === 期望, `${r.日期} != ${期望}`)
}

console.log('\n—— 内容字段都能认 ——')
for (const k of ['text', 'content', 'body', 'note', '正文', '内容']) {
  测(`内容字段 ${k}`, 转条目({ [k]: '正文在这里' }).text === '正文在这里')
}

console.log('\n—— 内置映射预设 ——')
测('四个预设都在', ['dayone', 'notion', 'generic', 'obsidian'].every((k) => 内置映射[k]))
测('dayone 映射指向 creationDate', 取映射('dayone').date === 'creationDate')
测('未知名回退空映射', Object.keys(取映射('不存在')).length === 0)

console.log('\n—— 解析成条目 ——')
const 数组输入 = [
  { content: '第一条', date: '2026-11-01' },
  { content: '第二条', date: '2026-11-02' },
  { title: '没有正文', date: '2026-11-03' },
]
const 解 = 解析成条目(数组输入)
测('解析出 2 条（第三条无正文跳过）', 解.条目.length === 2, String(解.条目.length))
测('跳过计数正确', 解.跳过 === 1)

const 分组 = 解析成条目({ '2026-11-05': [{ text: 'a' }], '2026-11-06': ['b'] })
测('按日期分组解析 2 条', 分组.条目.length === 2)
测('分组日期正确', 分组.条目[0].日期 === '2026-11-05')

console.log('\n—— 文本日记切分 ——')
const md = `## 2026-11-01
第一天写了不少东西。

## 2026-11-02
第二天也写了东西。

# 2026-11-03 星期二
第三天。`
const md条目 = 读文本日记(md)
测('切出 3 段', md条目.length === 3, String(md条目.length))
测('第一段日期', md条目[0].日期 === '2026-11-01')
测('第三段带星期也能认', md条目[2].日期 === '2026-11-03')
测('正文不含标题行', !md条目[0].text.includes('## 2026-11-01'))

const 无标题 = 读文本日记('就是一段没有任何日期标题的日记内容')
测('无标题整篇算一条', 无标题.length === 1)

console.log('\n—— 幂等指纹 ——')
测('同内容同指纹', 条目指纹({ 来源: 'a', 日期: '2026-11-01', text: 'x' }) === 条目指纹({ 来源: 'a', 日期: '2026-11-01', text: 'x' }))
测('标题变了指纹不变', 条目指纹({ 来源: 'a', 日期: 'd', text: 'x', title: '1' }) === 条目指纹({ 来源: 'a', 日期: 'd', text: 'x', title: '2' }))
测('正文变了指纹变', 条目指纹({ 来源: 'a', 日期: 'd', text: 'x' }) !== 条目指纹({ 来源: 'a', 日期: 'd', text: 'y' }))

test('导入：真文件、幂等、可被检索读取', async () => {
  const 根 = mkdtempSync(path.join(tmpdir(), 'imp-'))
  const 源 = path.join(根, 'dayone.json')
  const 目标 = path.join(根, 'imported')
  writeFileSync(源, JSON.stringify([
    { text: '第一天', creationDate: '2026-01-05T10:00:00Z', uuid: 'u1' },
    { text: '第二天', creationDate: '2026-01-06T10:00:00Z', uuid: 'u2' },
  ]))

  const r1 = await 导入({ 源文件: 源, 目标目录: 目标, 映射: 取映射('dayone'), 默认来源: 'dayone' })
  测('第一次导入成功', r1.ok, r1.错误)
  测('新增 2 条', r1.新增 === 2, String(r1.新增))

  const r2 = await 导入({ 源文件: 源, 目标目录: 目标, 映射: 取映射('dayone'), 默认来源: 'dayone' })
  测('第二次导入全部跳过（幂等）', r2.新增 === 0 && r2.跳过 === 2, `新增 ${r2.新增} 跳过 ${r2.跳过}`)

  // 落盘结构与检索读的格式一致
  // 目标目录下必须有 entries 这一层：读取侧按 <根>/entries/<来源>/<日期>.json 找，
  // 少了它就会「导入成功但检索读不到」
  const 目录们 = readdirSync(目标)
  测('目标下是 entries 目录', 目录们.includes('entries'), 目录们.join(','))
  const 来源们 = readdirSync(path.join(目标, 'entries'))
  测('entries 下按来源建目录', 来源们.includes('dayone'), 来源们.join(','))
  const 文件们 = readdirSync(path.join(目标, 'entries', 'dayone'))
  测('按日期建文件', 文件们.includes('2026-01-05.json'), 文件们.join(','))
  const v = JSON.parse(readFileSync(path.join(目标, 'entries', 'dayone', '2026-01-05.json'), 'utf8'))
  测('文件里有 entries', Array.isArray(v.entries) && v.entries.length === 1)
  测('条目的日期正确', v.entries[0].日期 === '2026-01-05')
  测('条目带指纹', typeof v.entries[0].指纹 === 'string')

  // Markdown 也能导
  const md源 = path.join(根, '2026-02-01.md')
  writeFileSync(md源, '## 2026-02-01\n第一段内容足够长了吧\n\n## 2026-02-02\n第二段内容也够长')
  const r3 = await 导入({ 源文件: md源, 目标目录: 目标, 默认来源: 'md' })
  测('Markdown 导入成功', r3.ok, r3.错误)
  测('Markdown 解析 2 条', r3.解析条数 === 2, String(r3.解析条数))

  // 字段对不上时给出可操作的错误
  const 怪 = path.join(根, 'weird.json')
  writeFileSync(怪, JSON.stringify([{ 没见过的字段: '内容' }]))
  const r4 = await 导入({ 源文件: 怪, 目标目录: 目标 })
  测('字段对不上时明确报错', !r4.ok)
  测('错误里提示用字段映射', String(r4.错误).includes('字段映射'), r4.错误)
})

// 端到端：导入的数据必须真的能被检索读到。
// 这条是因为踩过一次「导入成功、文件也对、但检索读不到」——
// 原因有两个：① 写入少了 entries 一层；② 读的时候只认 private/group-* 目录名。
// 两边各自看都正常，只有串起来跑才暴露。
test('端到端：导入后 memory_recall 能检索到', async () => {
  const { 注册AI工具 } = await import('../lib/tools.js')
  const 根 = mkdtempSync(path.join(tmpdir(), 'e2e-'))
  const 配置 = path.join(根, 'cfg')
  const 源 = path.join(根, 'dayone.json')
  writeFileSync(源, JSON.stringify([
    { text: '决定用腾讯云轻量，服务器续费到下个月', creationDate: '2026-01-05T10:00:00Z', uuid: 'u1' },
  ]))

  const 注册 = []
  const tools = 注册AI工具({
    defineTool: (o) => o,
    ctx: { tools: { register: (t) => 注册.push(t) } },
    rootDir: () => path.join(根, 'vault'),
    diaryRootDir: () => '',
    配置目录: 配置,
    读设置: async () => ({}),
    log: () => {},
  })
  // ⚠️ 注册AI工具 的返回值是「已注册的名字数组」，不是工具对象数组。
  // 想拿工具对象要看 ctx.tools.register 收到的那个数组（下面 注册）。
  测('注册了导入工具', tools.includes('memory_import_diary'), JSON.stringify(tools))

  const imp = 注册.find((t) => t.name === 'memory_import_diary')
  const r = await imp.execute({ 文件: 源, 格式预设: 'dayone', 来源: 'dayone' })
  测('导入成功', r.ok === true, r.text)
  测('新增 1 条', r.新增 === 1)

  const rec = 注册.find((t) => t.name === 'memory_recall')
  const q = await rec.execute({ query: '腾讯云 服务器', 来源: '*' })
  测('导入后能检索到', q.命中数 >= 1, `命中 ${q.命中数}`)
  测('检索结果里有原文片段', String(q.text).includes('腾讯云'), String(q.text).slice(0, 120))

  // 幂等：再导一次不新增
  const r2 = await imp.execute({ 文件: 源, 格式预设: 'dayone', 来源: 'dayone' })
  测('重复导入不新增', r2.新增 === 0 && r2.跳过 === 1, `新增 ${r2.新增} 跳过 ${r2.跳过}`)
})

// ── 「启用聊天分层」开关必须真的控制检索 ──────────────────────────
// 踩过的同类问题：设置页的「启用群聊」名字和行为对不上（README 坑 2）。
// 这里验同样的坑没在新开关上重犯。
test('开关关着时不把聊天卷进检索', async () => {
  const { 注册AI工具 } = await import('../lib/tools.js')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const 根 = mkdtempSync(path.join(tmpdir(), 'sw-'))
  const 配置 = path.join(根, 'cfg')
  mkdirSync(配置, { recursive: true })
  // 造一个含聊天原文的分层库
  writeFileSync(path.join(配置, 'chat-levels.json'), JSON.stringify({
    version: 1, 已处理: [], 统计: {},
    条目: [{ 来源: 'imported', 日期: '2026-11-03', 时间: '10:00:00', 昵称: 'a', pid: 'p1',
      内容: '分组讨论奶茶配方', 层级: 2, 分: 20, 理由: '', 分层来源: 'rule', 指纹: 'x' }],
  }))
  // 造一条日记
  const 日记根 = path.join(根, 'diary')
  mkdirSync(path.join(日记根, 'entries', 'private'), { recursive: true })
  writeFileSync(path.join(日记根, 'entries', 'private', '2026-11-03.json'), JSON.stringify({
    version: 2, date: '2026-11-03', 来源: 'private',
    entries: [{ id: 'd1', text: '今天的日记', tags: [], at: '2026-11-03T00:00:00Z' }],
  }))

  const 建 = (设置) => {
    const 注册 = []
    注册AI工具({
      defineTool: (o) => o, ctx: { tools: { register: (t) => 注册.push(t) } },
      rootDir: () => path.join(根, 'vault'), diaryRootDir: () => 日记根,
      配置目录: 配置, 读设置: async () => 设置, log: () => {},
    })
    return 注册.find((t) => t.name === 'memory_recall')
  }

  const 关 = await 建({ 启用聊天分层: false }).execute({ query: '奶茶', 来源: '*' })
  测('开关关：搜不到聊天内容', !String(关.text).includes('配方'), String(关.text).slice(0, 80))

  const 开 = await 建({ 启用聊天分层: true }).execute({ query: '奶茶', 来源: '*' })
  测('开关开：能搜到聊天内容', String(开.text).includes('配方'), String(开.text).slice(0, 80))
})
