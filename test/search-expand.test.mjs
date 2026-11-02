// ============================================================================
// search-expand.test.mjs —— 近义扩展（lib/search-expand.js）单测
// ============================================================================
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { 扩展词表, 扩展查询词 } from '../lib/search-expand.js'

test('扩展词表非空，每组至少 2 个词', () => {
  const 组 = 扩展词表()
  assert.ok(Array.isArray(组) && 组.length > 0, '词表应为非空数组')
  for (const g of 组) {
    assert.ok(Array.isArray(g), '每组应为数组')
    assert.ok(g.length >= 2, '每组至少 2 个词')
    for (const w of g) {
      assert.ok(typeof w === 'string' && w.length > 0, '组内词应为非空字符串')
    }
  }
})

test('扩展查询词([宝宝]) 包含 宝贝 且包含 宝宝', () => {
  const 结果 = 扩展查询词(['宝宝'])
  assert.ok(结果.includes('宝宝'), '原词 宝宝 应保留')
  assert.ok(结果.includes('宝贝'), '应扩展出 宝贝')
})

test('扩展查询词([难过]) 包含 伤心 或 不开心', () => {
  const 结果 = 扩展查询词(['难过'])
  assert.ok(结果.includes('难过'), '原词 难过 应保留')
  assert.ok(
    结果.includes('伤心') || 结果.includes('不开心'),
    '应扩展出 伤心 或 不开心'
  )
})

test('二元组不被扩展：[宝宝,宝不] 中 宝不 不带来新词', () => {
  const 结果 = 扩展查询词(['宝宝', '宝不'])
  // 宝宝 有扩展，所以结果长度 > 1
  assert.ok(结果.length > 1, '宝宝 应扩展，结果长度 > 1')
  // 单独输入 ['宝不'] 应只有自身（宝不在任何同义词组）
  const 只宝不 = 扩展查询词(['宝不'])
  assert.equal(只宝不.length, 1, '宝不 不在同义词组，不应扩展')
  assert.equal(只宝不[0], '宝不')
  // 组合输入中，除宝宝扩展词和宝不本身外，不应有其他词
  const 仅宝宝 = 扩展查询词(['宝宝'])
  const 其他 = 结果.filter((w) => !仅宝宝.includes(w) && w !== '宝不')
  assert.deepEqual(其他, [], '宝不 不应带来新扩展词')
})
