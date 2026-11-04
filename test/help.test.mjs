/**
 * 「?」帮助面板的测试 —— 守四件最容易悄悄坏掉的事。
 *
 * 为什么专门给「说明文档」写测试：
 *   这类东西坏了不会报错。文案丢了 → 面板上一片空白；价格写错了 →
 *   用户按错的数字做决定。全靠人眼发现，而人眼恰恰最靠不住。
 *
 * 守的四条：
 *   1. 文案不能变空 / 不能丢掉必须讲清楚的几件事（花钱、省钱的机制、踩过的坑）
 *   2. 算钱公式对得上官方单价（用实测 token 数反算，不看代码看结果）
 *   3. 峰谷判断按官方的 UTC 时段（边界值单独测）
 *   4. **client.js 里的内联文案和 lib/help.js 必须一致**
 *      —— 这是本文件最重要的一条。两边是手工同步的，漏改一边表现是
 *      「设置页说的和插件实际做的不一样」，没人会发现。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { 帮助内容, 帮助为文本, 算钱, 是峰时, 价格表, 默认汇率 } from '../lib/help.js'

const 此处 = path.dirname(fileURLToPath(import.meta.url))

test('帮助内容不为空，且每节都有标题', () => {
  assert.ok(Array.isArray(帮助内容) && 帮助内容.length >= 5, '帮助内容至少要 5 节，太少了等于没写')
  for (const 节 of 帮助内容) {
    assert.ok(节.标题 && String(节.标题).trim(), '每一节都必须有标题')
    const 有内容 = (节.段落 || []).length > 0 || (节.条目 || []).length > 0
    assert.ok(有内容, `「${节.标题}」是空节：既没有段落也没有条目`)
  }
})

test('必须讲清楚的几件事，一件都不能少', () => {
  const 全文 = 帮助为文本()
  // 这几条是用户最关心、也最容易在改文案时被删掉的信息。
  // 用关键词而不是整句匹配：允许改写，但不允许整件事消失。
  const 必须有 = [
    ['花钱的地方', ['token', '花']],
    ['省钱机制', ['喂过', '不会再送']],
    ['规则 vs 模型的区别', ['规则', '模型']],
    ['限制说明', ['估算', '账单']],
  ]
  for (const [叫法, 词们] of 必须有) {
    for (const 词 of 词们) {
      assert.ok(全文.includes(词), `帮助内容里应该讲清「${叫法}」，但找不到关键词「${词}」`)
    }
  }
})

test('算钱公式对得上实测用量（deepseek-flash 高峰价）', () => {
  const 价 = 价格表['deepseek-flash']
  // 实测：一次 20 条的批量 = 输入 675、输出 346 token
  const 峰 = 算钱({ prompt: 675, completion: 346 }, 价, { 峰时: true })
  const 期望峰 = (675 * 0.3 + 346 * 1.2) / 1e6
  assert.ok(Math.abs(峰 - 期望峰) < 1e-12, `高峰价算错了：${峰} 应为 ${期望峰}`)

  // 谷价正好是峰价的一半（官方写明 off-peak = peak / 2）
  const 谷 = 算钱({ prompt: 675, completion: 346 }, 价, { 峰时: false })
  assert.ok(Math.abs(谷 * 2 - 峰) < 1e-12, `谷价应正好是峰价的一半，实际峰 ${峰} 谷 ${谷}`)
})

test('算钱：空值 / 缺字段 / 垃圾输入都返回 0，不能是 NaN', () => {
  // NaN 会一路传到界面上显示成「¥NaN」，比不显示更糟。
  assert.equal(算钱(null, null), 0)
  assert.equal(算钱(undefined, undefined), 0)
  assert.equal(算钱({}, {}), 0)
  assert.equal(算钱({ prompt: 'abc', completion: null }, 价格表['deepseek-flash']), 0)
})

test('算钱：缓存命中部分单独计价，且不会算成负数', () => {
  const 价 = 价格表['deepseek-flash']
  // 命中 500 条输入：应比全按未命中便宜
  const 全未命中 = 算钱({ prompt: 1000, completion: 0 }, 价, { 峰时: true })
  const 有命中 = 算钱({ prompt: 1000, completion: 0, 命中: 500 }, 价, { 峰时: true })
  assert.ok(有命中 < 全未命中, '命中缓存应该更便宜')

  // 命中数大于输入数是脏数据：夹住，不能算成负钱
  const 脏 = 算钱({ prompt: 100, completion: 0, 命中: 99999 }, 价, { 峰时: true })
  assert.ok(脏 >= 0, `命中数超过输入数时不能算出负数，实际 ${脏}`)
})

test('峰谷判断：按官方 UTC 时段，边界值逐个测', () => {
  // 2026-11-04 是周三
  const 周三 = (h) => new Date(`2026-11-04T${String(h).padStart(2, '0')}:00:00Z`)
  assert.equal(是峰时(周三(0)), false, '00:00 不是高峰')
  assert.equal(是峰时(周三(1)), true, '01:00 是高峰起点')
  assert.equal(是峰时(周三(3)), true, '03:00 在 01-04 区间内')
  assert.equal(是峰时(周三(4)), false, '04:00 是区间右端，不含')
  assert.equal(是峰时(周三(5)), false, '05:00 在空隙里')
  assert.equal(是峰时(周三(6)), true, '06:00 是第二段起点')
  assert.equal(是峰时(周三(9)), true, '09:00 在区间内')
  assert.equal(是峰时(周三(10)), false, '10:00 是区间右端，不含')

  // 周末全天不加价
  const 周六 = new Date('2026-11-07T09:00:00Z')
  const 周日 = new Date('2026-11-08T02:00:00Z')
  assert.equal(是峰时(周六), false, '周六不算高峰')
  assert.equal(是峰时(周日), false, '周日不算高峰')
})

test('价格表里 deepseek 的档位齐全，且峰价 > 谷价', () => {
  for (const [名, 价] of Object.entries(价格表)) {
    for (const 键 of ['入峰', '入谷', '出峰', '出谷', '命中峰', '命中谷']) {
      assert.ok(Number.isFinite(价[键]), `${名} 的 ${键} 不是数字`)
    }
    assert.ok(价.入峰 > 价.入谷, `${名}：高峰输入价应该高于低谷`)
    assert.ok(价.出峰 > 价.出谷, `${名}：高峰输出价应该高于低谷`)
    assert.ok(价.命中峰 < 价.入峰, `${名}：缓存命中应该比未命中便宜`)
  }
})

test('汇率是个正数（估算金额要靠它折算成人话）', () => {
  assert.ok(Number.isFinite(默认汇率) && 默认汇率 > 0 && 默认汇率 < 20)
})

// ─────────────────────────────────────────────────────────────────────────────
// 最重要的一条：client.js 里的内联副本必须和 lib/help.js 一致
//
// client.js 是浏览器端入口，只能内联（写 import 会白屏，见文件里的注释）。
// 内联 = 两份数据，就一定会有一天只改了一边。这条测试把那一天的代价
// 从「用户被说明误导」降成「CI 红」。
// ─────────────────────────────────────────────────────────────────────────────
test('client.js 内联的帮助内容与 lib/help.js 完全一致', () => {
  const 源码 = readFileSync(path.join(此处, '..', 'lib', 'client.js'), 'utf8')

  // 从源码里抠出 const 帮助内容 = [...]; 那段，再当 JS 求值。
  // 用正则定位而不是 eval 整个文件：client.js 有 window.__ModuleLoader__，
  // 在 node 里根本跑不起来。
  const m = 源码.match(/const 帮助内容 = (\[[\s\S]*?\n  \]);/)
  assert.ok(m, 'client.js 里找不到内联的 `const 帮助内容 = [...]` —— 是不是被删了或改了写法？')

  let 内联
  内联 = JSON.parse(m[1])   // 内联块是 JSON.stringify 出来的，直接按 JSON 解析
  assert.deepEqual(
    内联,
    帮助内容,
    'client.js 的内联文案和 lib/help.js 不一致了 —— 改了说明要两边一起改',
  )
})
