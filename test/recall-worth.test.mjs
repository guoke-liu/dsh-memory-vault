/**
 * 「交给模型判断值不值得记」的测试。
 *
 * 背景（2026-11-04）：主人要求「交给大模型分辨有没有重点要记的东西，
 * 纯闲聊的话不要记」。规则打不出这个判断 —— 实测大群里
 * 【日记】【模型】有内容，中群里【米饭】【笑话】全是闲聊，
 * 但两者在词频、人数上几乎一样。
 *
 * 这里守住两条底线：
 *   1. 没配模型时必须还能用（开源硬约束）
 *   2. 模型失败时按「值得记」处理 —— 宁可多记，不能因为一次网络抖动丢重点
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  解析判断, 判断提示词, 批量判断, 默认粗筛线,
} from '../lib/recall-worth.js'

/** 假模型服务：按请求体里有没有「闲聊关键词」返回不同判断 */
let 服务
let 端口
let 请求数 = 0
let 强制失败 = false

before(async () => {
  服务 = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      请求数 += 1
      if (强制失败) {
        res.writeHead(500)
        res.end('boom')
        return
      }
      const 闲聊 = /米饭|吃饭|笑话|客气|哈哈|游戏/.test(body)
      const 结果 = 闲聊
        ? { 值得记: false, 理由: '纯闲聊', 重点: '' }
        : { 值得记: true, 理由: '有具体内容', 重点: '摘要' }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(结果) } }] }))
    })
  })
  await new Promise((ok) => 服务.listen(0, '127.0.0.1', ok))
  端口 = 服务.address().port
})

after(() => { try { 服务.close() } catch { /* 已关 */ } })

const 配置 = () => ({ baseURL: `http://127.0.0.1:${端口}/v1`, apiKey: 'x', model: 't' })

// ── 解析容错 ────────────────────────────────────────────────────────

test('解析判断：标准 JSON', () => {
  const r = 解析判断('{"值得记":true,"理由":"有约定","重点":"改端口"}')
  assert.equal(r.解析成功, true)
  assert.equal(r.值得记, true)
  assert.equal(r.重点, '改端口')
})

test('解析判断：代码围栏、前后加话都能认', () => {
  for (const t of [
    '```json\n{"值得记":false,"理由":"闲聊"}\n```',
    '好的：{"值得记":false,"理由":"闲聊"} 希望有用',
  ]) {
    const r = 解析判断(t)
    assert.equal(r.解析成功, true, `该能解析：${t}`)
    assert.equal(r.值得记, false)
  }
})

test('解析判断：解析失败时按「值得记」处理（宁可多记不丢重点）', () => {
  for (const 坏 of ['', '模型胡说八道', '{}', '[]', null, undefined]) {
    const r = 解析判断(坏)
    assert.equal(r.解析成功, false)
    assert.equal(r.值得记, true, `${JSON.stringify(坏)} 解析失败时该按值得记处理`)
  }
})

test('解析判断：键名兼容 worth / keep 等写法', () => {
  assert.equal(解析判断('{"worth":false}').值得记, false)
  assert.equal(解析判断('{"keep":true}').值得记, true)
})

test('判断提示词：明确写了「纯闲聊不要记」', () => {
  const p = 判断提示词()
  assert.match(p, /不值得记/, '要列出什么不值得记')
  assert.match(p, /寒暄|玩笑|梗/, '纯闲聊要明确排除')
  assert.match(p, /JSON/, '要要求返回 JSON')
})

// ── 批量判断 ────────────────────────────────────────────────────────

test('批量判断：没配模型时粗筛后的都保留（功能必须可用）', async () => {
  const 候选 = [
    { 段: { 消息: [{ 内容: '我们决定把端口改到 8080' }] }, 规则分: 0.8 },
    { 段: { 消息: [{ 内容: '米饭真香' }] }, 规则分: 0.5 },
    { 段: { 消息: [{ 内容: '抱' }, { 内容: '乖' }] }, 规则分: 0.1 },
  ]
  const r = await 批量判断(候选, null, { 日志: () => {} })
  assert.equal(r.统计.用了模型, false)
  assert.equal(r.统计.粗筛掉, 1, '0.1 分的该被粗筛掉')
  assert.equal(r.保留.length, 2, '剩下的都保留')
  assert.ok(r.保留.every((x) => x.判断.值得记), '没模型时一律按值得记')
})

test('批量判断：配了模型时，闲聊被丢掉、真事留下', async () => {
  const 候选 = [
    { 段: { 消息: [{ 内容: '我们决定把端口改到 8080' }] }, 规则分: 0.8 },
    { 段: { 消息: [{ 内容: '中午吃什么米饭' }] }, 规则分: 0.6 },
    { 段: { 消息: [{ 内容: '哈哈这个笑话真好笑' }] }, 规则分: 0.5 },
  ]
  const r = await 批量判断(候选, 配置(), { 日志: () => {}, 并发: 2 })
  assert.equal(r.统计.用了模型, true)
  assert.equal(r.统计.送模型, 3)
  assert.equal(r.统计.模型判闲聊, 2, '米饭和笑话该被判闲聊')
  assert.equal(r.保留.length, 1, '只留下端口那条')
  assert.ok(String(r.保留[0].段.消息[0].内容).includes('8080'))
})

test('批量判断：粗筛线以下的根本不送模型（省钱）', async () => {
  const 前 = 请求数
  const 候选 = [
    { 段: { 消息: [{ 内容: '嗯' }] }, 规则分: 0.05 },
    { 段: { 消息: [{ 内容: '好' }] }, 规则分: 0.1 },
    { 段: { 消息: [{ 内容: '决定改端口' }] }, 规则分: 0.9 },
  ]
  const r = await 批量判断(候选, 配置(), { 日志: () => {}, 并发: 1 })
  assert.equal(r.统计.粗筛掉, 2, '两个低分不该送模型')
  assert.equal(r.统计.送模型, 1)
  assert.equal(请求数 - 前, 1, '只该发一次请求')
})

test('批量判断：模型失败时按值得记处理，不丢内容', async () => {
  强制失败 = true
  try {
    const 候选 = [{ 段: { 消息: [{ 内容: '我们决定把端口改到 8080' }] }, 规则分: 0.9 }]
    const r = await 批量判断(候选, 配置(), { 日志: () => {} })
    assert.equal(r.保留.length, 1, '模型失败不能让内容消失')
    assert.equal(r.保留[0].判断.值得记, true)
    assert.equal(r.保留[0].判断.解析成功, false)
  } finally {
    强制失败 = false
  }
})

test('批量判断：空输入安全返回', async () => {
  for (const 入 of [[], null, undefined]) {
    const r = await 批量判断(入, null, { 日志: () => {} })
    assert.deepEqual(r.保留, [])
  }
})

test('默认粗筛线是个低值（低到让模型有机会否决）', () => {
  // 粗筛线定太高的话，模型根本没机会看到中群那些 0.35-0.5 的话题，
  // 等于没有交给模型判断
  assert.ok(默认粗筛线 <= 0.35, `粗筛线 ${默认粗筛线} 太高，会把该让模型判的都挡掉`)
  assert.ok(默认粗筛线 > 0, '总得有个下限，不然纯寒暄也送模型')
})

// ── 防重复花钱（实测踩过的三个坑）────────────────────────────────────
//
// 主人 2026-11-04 要求「避免反复投喂」。事件层最初完全没接账本，
// 每跑一次就把所有话题重判一遍。接的时候又踩了两个坑：
//   1. 账本写进去读不回来（写账本存的是账本本身，读账本期望包一层）
//   2. 判过的直接跳过 → 重跑时事件凭空消失（事件数从 1 变 0）
// 这三个用例守住它们。

test('批量判断：判过的不再送模型，且按上次结论还原去留', async () => {
  const 判过 = new Set()
  const 结论表 = new Map()
  const 候选 = () => [
    { 段: { 来源: 'g', 日期: '2026-11-03', 事件: '真事', 起: '10:00', 消息: [{ 内容: '我们决定把端口改成 8080' }] }, 规则分: 0.9 },
    { 段: { 来源: 'g', 日期: '2026-11-03', 事件: '闲聊', 起: '11:00', 消息: [{ 内容: '哈哈这个笑话真好笑' }] }, 规则分: 0.9 },
  ]
  const 选项 = {
    日志: () => {},
    已判断: (指纹) => 判过.has(指纹),
    取上次结论: (指纹) => 结论表.get(指纹) ?? null,
    每段判完: (指纹, 判定) => { 判过.add(指纹); 结论表.set(指纹, 判定.值得记) },
  }

  const 第一次 = await 批量判断(候选(), 配置(), 选项)
  assert.equal(第一次.统计.送模型, 2, '第一次两条都该送')
  assert.equal(第一次.保留.length, 1, '笑话被丢掉，只剩真事')

  const 前 = 请求数
  const 第二次 = await 批量判断(候选(), 配置(), 选项)
  assert.equal(请求数 - 前, 0, '第二次不该再发请求')
  assert.equal(第二次.统计.已判过, 2)
  assert.equal(第二次.保留.length, 1, '判过的事件不能凭空消失')
  assert.ok(String(第二次.保留[0].段.事件).includes('真事'))
})
