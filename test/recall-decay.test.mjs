// 衰减机制测试：12 层每月降一层、命中回满、满 12 层归档
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  算衰减, 衰减系数表, 天数差, 最大层, 每月天数, 最低系数,
  更新命中, 归档清理, 记命中,
} from '../lib/recall-decay.js'

let 过 = 0
let 挂 = 0
const 失败 = []
const 测 = (n, c, d) => { if (c) { 过++; console.log('  ✅ ' + n) } else { 挂++; 失败.push(n); console.log('  ❌ ' + n + (d ? ' → ' + d : '')) } }

const 现在 = Date.parse('2026-11-03T12:00:00Z')
const 天前 = (n) => new Date(现在 - n * 86400000).toISOString()

console.log('—— 系数表 ——')
const 表 = 衰减系数表()
测(`12 档`, 表.length === 最大层, String(表.length))
测('第 1 层是 1.0', 表[0] === 1)
测('第 12 层是最低系数', 表[11] === 最低系数, String(表[11]))
测('单调递减', 表.every((v, i) => i === 0 || v < 表[i - 1]))
测('都不为 0（还能被搜到）', 表.every((v) => v > 0))

console.log('\n—— 每月降一层 ——')
测('0 天在第 1 层', 算衰减({ lastHit: 天前(0) }, 现在).层级 === 1)
测('29 天仍在第 1 层', 算衰减({ lastHit: 天前(29) }, 现在).层级 === 1)
测('30 天降到第 2 层', 算衰减({ lastHit: 天前(30) }, 现在).层级 === 2, String(算衰减({ lastHit: 天前(30) }, 现在).层级))
测('60 天到第 3 层', 算衰减({ lastHit: 天前(60) }, 现在).层级 === 3)
测('330 天到第 12 层', 算衰减({ lastHit: 天前(330) }, 现在).层级 === 12)
测('330 天还没归档', 算衰减({ lastHit: 天前(330) }, 现在).归档 === false)
测('360 天（12 个月）归档', 算衰减({ lastHit: 天前(360) }, 现在).归档 === true, String(算衰减({ lastHit: 天前(360) }, 现在).归档))

console.log('\n—— 衰减系数随层下降 ——')
const 一 = 算衰减({ lastHit: 天前(0) }, 现在).系数
const 六 = 算衰减({ lastHit: 天前(180) }, 现在).系数
const 十二 = 算衰减({ lastHit: 天前(330) }, 现在).系数
测('第 1 层系数 1.0', 一 === 1)
测('第 7 层系数更低', 六 < 一, `${六} < ${一}`)
测('第 12 层最低', 十二 < 六, `${十二} < ${六}`)
测('第 12 层仍大于 0', 十二 > 0)

console.log('\n—— 参照时间优先级 ——')
测('优先用 lastHit', 算衰减({ lastHit: 天前(0), created: 天前(999) }, 现在).层级 === 1)
测('没有 lastHit 用 created', 算衰减({ created: 天前(31) }, 现在).层级 === 2)
测('日记条目用 at', 算衰减({ at: 天前(31) }, 现在).层级 === 2, String(算衰减({ at: 天前(31) }, 现在).层级))
测('都没有当最老', 算衰减({}, 现在).层级 === 最大层)

console.log('\n—— 命中回满 ——')
const 条目们 = [
  { id: 'a', 指纹: 'fa', lastHit: 天前(200) },
  { id: 'b', 指纹: 'fb', lastHit: 天前(200) },
]
测('命中前在第 7 层（200 天 / 30 = 6 层降级）', 算衰减(条目们[0], 现在).层级 === 7, String(算衰减(条目们[0], 现在).层级))
const r = 更新命中(条目们, ['a'], 现在)
测('只改了命中的那条', r.改了几条 === 1)
测('命中后回到第 1 层', 算衰减(条目们[0], 现在).层级 === 1)
测('没命中的仍在第 7 层', 算衰减(条目们[1], 现在).层级 === 7)

console.log('\n—— 归档 ——')
const 混 = [
  { id: '新', lastHit: 天前(50) },
  { id: '老', lastHit: 天前(400) },
]
const 分 = 归档清理(混, 现在)
测('新条目留活跃', 分.活跃.some((e) => e.id === '新'))
测('老条目进归档', 分.归档.some((e) => e.id === '老'))
测('归档条目带衰减层信息', 分.归档[0].衰减层 === 最大层)

console.log('\n—— 天数差 ——')
测('同一时刻为 0', 天数差(new Date(现在).toISOString(), 现在) === 0)
测('非法时间返回 Infinity', 天数差('乱码', 现在) === Infinity)
测('空值返回 Infinity', 天数差(null, 现在) === Infinity)

test('recall-decay 全部断言', () => { if (挂 > 0) throw new Error(`${挂} 条失败：${失败.join(' / ')}`) })
