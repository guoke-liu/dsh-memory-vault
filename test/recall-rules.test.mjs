// 规则配置与云端更新测试
//
// 重点验：
//   1. 预设真的会改变判定结果（不是摆设）
//   2. 用户自定义能完全替换预设字段
//   3. 校验能挡住坏正则、阈值倒挂
//   4. 云端更新挡得住各类坏数据（这是安全边界，必须测）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { 内置预设, 解析规则, 校验规则, 预设清单, 拉云端预设 } from '../lib/recall-rules.js'
import { 打分层 } from '../lib/recall-screen.js'

let 过 = 0
let 挂 = 0
const 失败 = []
const 测 = (n, c, d) => { if (c) { 过++; console.log('  ✅ ' + n) } else { 挂++; 失败.push(n); console.log('  ❌ ' + n + (d ? ' → ' + d : '')) } }

console.log('—— 预设清单 ——')
const 清单 = 预设清单()
测('四个预设都在', 清单.length === 4 && 清单.every((p) => p.名 && p.说明))
测('每个预设都能解析', 清单.every((p) => 校验规则(解析规则({ 规则预设: p.名 })).ok))

console.log('\n—— 不同预设给出不同判定 ——')
const 技术句 = { 内容: '说好了下周一交版本，端口改成 8080' }
const 生活句 = { 内容: '明天记得接孩子，医院复查改到十点' }
const 技术向 = 解析规则({ 规则预设: '技术向' })
const 生活向 = 解析规则({ 规则预设: '生活向' })
测('技术句在技术向是核心', 打分层(技术句, 技术向).层级 === 2, String(打分层(技术句, 技术向).层级))
测('生活句在技术向不是核心', 打分层(生活句, 技术向).层级 < 2, String(打分层(生活句, 技术向).层级))
测('生活句在生活向是核心', 打分层(生活句, 生活向).层级 === 2, String(打分层(生活句, 生活向).层级))

const 严格 = 解析规则({ 规则预设: '严格' })
const 宽松 = 解析规则({ 规则预设: '宽松' })
测('严格预设核心阈值 > 宽松', 严格.核心阈值 > 宽松.核心阈值)

console.log('\n—— 用户自定义替换 ——')
const 自定义 = 解析规则({ 规则预设: '生活向', 自定义话题词: '奶粉|尿布' })
测('自定义词生效', 打分层({ 内容: '奶粉要买了 尿布也没了' }, 自定义).层级 >= 1)
测('自定义是替换不是叠加', 打分层({ 内容: '吃药复查' }, 自定义).层级 === 0, '原预设词应失效')
测('没填的字段仍用预设', 自定义.应答词 === 内置预设.生活向.应答词)

const 自定义阈值 = 解析规则({ 规则预设: '技术向', 自定义核心阈值: '3' })
测('自定义阈值生效', 自定义阈值.核心阈值 === 3)

console.log('\n—— 校验 ——')
测('合法规则通过', 校验规则(解析规则({})).ok)
测('坏正则被拒', !校验规则({ ...解析规则({}), 话题词: '[未闭合' }).ok)
测('阈值倒挂被拒', !校验规则({ ...解析规则({}), 有用阈值: 9, 核心阈值: 1 }).ok)
测('空话题词被拒', !校验规则({ ...解析规则({}), 话题词: '' }).ok)

console.log('\n—— 云端更新：安全边界 ——')
测('空地址拒绝', !(await 拉云端预设('')).ok)
测('非 http 拒绝', !(await 拉云端预设('ftp://x')).ok)
测('明文 http 拒绝', !(await 拉云端预设('http://example.com/a.json')).ok)
测('https 格式放行（网络失败不算拒绝）', (await 拉云端预设('https://127.0.0.1:1/a.json', { 超时毫秒: 500 })).错误?.includes('请求失败'))

test('recall-rules 全部断言', () => { if (挂 > 0) throw new Error(`${挂} 条失败：${失败.join(' / ')}`) })

test('云端更新：好数据通过、坏数据拒绝', async () => {
  const 好 = { 预设: { 我的: { 说明: 'x', 话题词: 'a|b', 应答词: '^(嗯)$', 约定词: '说好', 播报正则: ['^【'], 有用阈值: 1, 核心阈值: 3 } } }
  const 混合 = {
    预设: {
      合法: { 话题词: 'a|b', 应答词: '^(嗯)$', 约定词: '说好', 播报正则: ['^【'], 有用阈值: 1, 核心阈值: 3 },
      坏正则: { 话题词: '[未闭合', 应答词: '^(嗯)$', 约定词: '说好', 播报正则: [], 有用阈值: 1, 核心阈值: 3 },
      缺字段: { 话题词: 'a' },
    },
  }
  const srv = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/good') return res.end(JSON.stringify(好))
    if (req.url === '/mixed') return res.end(JSON.stringify(混合))
    if (req.url === '/bad') return res.end('不是 JSON')
    if (req.url === '/nopreset') return res.end(JSON.stringify({ version: 1 }))
    res.statusCode = 404
    res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const 端口 = srv.address().port
  const 基 = `http://127.0.0.1:${端口}`
  try {
    const a = await 拉云端预设(`${基}/good`)
    测('好数据通过', a.ok && Object.keys(a.预设).includes('我的'))

    const b = await 拉云端预设(`${基}/mixed`)
    测('混合数据：合法的留下来', b.ok && Object.keys(b.预设).includes('合法'))
    测('混合数据：坏正则被拒', b.拒绝?.some((x) => x.includes('坏正则')), JSON.stringify(b.拒绝))
    测('混合数据：缺字段被拒', b.拒绝?.some((x) => x.includes('缺字段')))

    测('非 JSON 拒绝', !(await 拉云端预设(`${基}/bad`)).ok)
    测('缺预设对象拒绝', !(await 拉云端预设(`${基}/nopreset`)).ok)
    测('404 拒绝', !(await 拉云端预设(`${基}/404`)).ok)
  } finally {
    srv.close()
  }
})
