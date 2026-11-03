#!/usr/bin/env node
// ============================================================================
// screen-chats.mjs —— 聊天分层筛选的独立命令行工具
//
// 【这个模块负责什么】
//   不依赖 DSH、不依赖插件加载、不需要任何模型 API：
//   直接扫记忆仓库的 chat 目录，用规则给每条消息分档，把结果写成 JSON。
//
//   用途有两个：
//     1. 开源用户没有模型时，这就是完整可用的筛选路径；
//     2. 想在装插件之前先看看「我的聊天会被分成什么样」，可以单独跑它。
//
// 【为什么做成独立脚本而不是只留模块】
//   · 能单独用 `node lib/screen-chats.mjs` 跑，不需要 DSH 环境；
//   · 结果是纯 JSON，别的程序也能消费（不绑死在这个插件里）；
//   · 随 git 更新 —— 规则改了，脚本跟着发版，用户 pull 一下就有新规则。
//
// 【用法】
//   node lib/screen-chats.mjs --chat <聊天库目录> [--out <输出.json>] [--min-level 1]
//   node lib/screen-chats.mjs --help
// ============================================================================

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { 打分层, 分层, 层级名, 是机器人播报 } from './recall-screen.js'

/** 从 `[HH:MM:SS] 昵称(pid): 内容` 里取字段。抽不出就返回 null。 */
function 解析行 (行, 日期) {
  const m = String(行 || '').match(/^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s+(.+?)\(([^)]*)\):\s?([\s\S]*)$/)
  if (!m) return null
  return { 日期, 时间: m[1], 昵称: m[2], pid: m[3], 内容: m[4] }
}

/** 递归收集 chat 目录下所有 .txt，并解析出消息。 */
function 读聊天库 (聊天根) {
  const 消息 = []
  const 文件们 = []
  const 走 = (dir) => {
    let names
    try { names = readdirSync(dir) } catch { return }
    for (const n of names.sort()) {
      const p = path.join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { 走(p); continue }
      if (!n.endsWith('.txt')) continue
      const m = n.match(/^(\d{4}-\d{2}-\d{2})\.txt$/)
      const 日期 = m ? m[1] : ''
      let 文本
      try { 文本 = readFileSync(p, 'utf8') } catch { continue }
      文件们.push(p)
      for (const ln of 文本.split('\n')) {
        const r = 解析行(ln, 日期)
        if (r) 消息.push(r)
      }
    }
  }
  走(聊天根)
  return { 消息, 文件们 }
}

function 用法 () {
  return [
    '聊天分层筛选（规则版，零依赖、不需要模型）',
    '',
    '用法：',
    '  node lib/screen-chats.mjs --chat <聊天库目录> [选项]',
    '',
    '选项：',
    '  --chat <dir>      记忆仓库的根目录（里面应有 chat/）或 chat/ 本身。必填',
    '  --out <file>      结果写到哪，默认 screen-result.json',
    '  --min-level <n>   只输出 >= n 档的消息（0=闲聊 1=有用 2=核心），默认 0',
    '  --quiet           不打印逐条摘要',
    '  --help            显示这段帮助',
    '',
    '说明：',
    '  这是**默认路径**。模型打分是可选增强，没配 API 也能用这一套。',
    '  规则随 git 更新，pull 一下就是新规则。',
  ].join('\n')
}

function 取参数 (argv) {
  const out = { 聊天: '', 输出: 'screen-result.json', 最少层级: 0, 安静: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') { console.log(用法()); process.exit(0) }
    if (a === '--chat') { out.聊天 = argv[++i] || ''; continue }
    if (a === '--out') { out.输出 = argv[++i] || 'screen-result.json'; continue }
    if (a === '--min-level') { out.最少层级 = Number(argv[++i]) || 0; continue }
    if (a === '--quiet') { out.安静 = true; continue }
  }
  return out
}

const 参 = 取参数(process.argv.slice(2))
if (!参.聊天) {
  console.error('缺少 --chat 参数。\n')
  console.error(用法())
  process.exit(2)
}

// 允许传仓库根目录（自动补 chat/），也允许直接传 chat/
let 聊天根 = 参.聊天
try {
  const 下 = readdirSync(聊天根)
  if (下.includes('chat')) 聊天根 = path.join(聊天根, 'chat')
} catch (e) {
  console.error(`读不了这个目录：${参.聊天}\n${e?.message || e}`)
  process.exit(2)
}

const { 消息, 文件们 } = 读聊天库(聊天根)
if (消息.length === 0) {
  console.error(`在 ${聊天根} 下没找到任何聊天记录（期望 chat/<private|group>/YYYY-MM-DD.txt）`)
  process.exit(1)
}

const 结果 = []
const 分布 = { 核心: 0, 有用: 0, 闲聊: 0, 播报: 0 }
for (const m of 消息) {
  const 播报 = 是机器人播报(m.内容)
  const r = 打分层(m)
  if (播报) 分布.播报 += 1
  else if (r.层级 === 分层.核心) 分布.核心 += 1
  else if (r.层级 === 分层.有用) 分布.有用 += 1
  else 分布.闲聊 += 1
  if (r.层级 < 参.最少层级) continue
  结果.push({ ...m, 层级: r.层级, 层级名: 层级名[r.层级], 分: r.分, 特征: r.特征, 播报 })
}

writeFileSync(参.输出, JSON.stringify({
  version: 1,
  生成时间: new Date().toISOString(),
  聊天根,
  文件数: 文件们.length,
  消息总数: 消息.length,
  分布,
  输出条数: 结果.length,
  结果,
}, null, 2))

if (!参.安静) {
  console.log(`聊天根：${聊天根}`)
  console.log(`文件 ${文件们.length} 个，消息 ${消息.length} 条`)
  console.log(`分布：核心 ${分布.核心} / 有用 ${分布.有用} / 闲聊 ${分布.闲聊} / 播报 ${分布.播报}`)
  console.log(`输出 ${结果.length} 条 → ${参.输出}`)
  const 例 = 结果.filter((x) => x.层级 === 分层.核心).slice(0, 3)
  if (例.length) {
    console.log('\n核心档示例：')
    for (const e of 例) console.log(`  [${e.分}] ${e.内容.slice(0, 60)}`)
  }
}
