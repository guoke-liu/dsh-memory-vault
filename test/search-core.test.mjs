import { test } from 'node:test'
import assert from 'node:assert/strict'
import { 切词, 打分 } from '../lib/search-core.js'

test('切词：连续汉字按 2 字滑窗切分（宝宝不开心）', () => {
  const 词 = 切词('宝宝不开心')
  assert.ok(词.includes('宝宝'), '应切出「宝宝」')
  assert.ok(词.includes('宝不'), '应切出「宝不」')
  assert.ok(词.includes('不开'), '应切出「不开」')
  assert.ok(词.includes('开心'), '应切出「开心」')
})

test('打分：命中的查询词按词长加分', () => {
  const 分 = 打分('今天宝宝很难过，一直在哭', ['宝宝', '难过'])
  assert.ok(分 > 0, '分数应大于 0')
  assert.equal(分, 4, '宝宝(+2) + 难过(+2) 应得 4 分')
})
