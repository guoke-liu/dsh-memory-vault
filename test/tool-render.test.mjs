/**
 * 工具的输出契约测试 —— 补一个曾经漏掉的真 bug。
 *
 * 背景（2026-11-04 实测）：memory_recall / memory_coverage / memory_import_diary /
 * memory_score_chats 四个工具的 render 写成了 `(v) => ...`，只收一个参数。
 * 但宿主调用的是 `render(args, value)` —— 于是 v 拿到的是**参数对象**，
 * v.text 永远是 undefined，render 返回空字符串。
 *
 * 后果有多严重：工具调用显示"成功"，模型却一个字都读不到。
 * 这正是鱼说"工具又闹脾气了"的那类问题（AGENTS.md §3.6.2），
 * 只不过这次是反向的 —— 不是格式错抛异常，而是**静默返回空**。
 *
 * 为什么之前 201 条测试全绿还有这个 bug：
 * 测试只验 execute() 的返回值，**没有一条验 render() 的输出**。
 * 这个文件补上这一环。
 *
 * 工具里存在两种渲染风格，测试必须分别对待：
 *   · 结构化渲染（前 6 个）：从 value 的各个字段拼中文句子，不读 value.text
 *   · 整段文字（后 4 个）：直接把 value.text 交出去
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { 注册AI工具, 包成文本块 } from '../lib/tools.js'

/** 后 4 个：渲染方式是把 value.text 整段交出去 */
const 整段文字工具 = ['memory_recall', 'memory_coverage', 'memory_import_diary', 'memory_score_chats', 'memory_build_events', 'memory_forget_events', 'memory_impressions']

/**
 * 按宿主的真实调用方式来造工具表。
 *
 * 关键点：宿主的 defineTool 会把 render 原样透传
 * （源码 `render(args, value) { return userRender(args, value) }`），
 * 所以这里也不包装，保持两个参数——这正是能抓出单参数写法的原因。
 */
function 造工具 (配置 = {}) {
  const 注册表 = []
  const defineTool = (t) => t
  const ctx = { tools: { register (t) { 注册表.push(t) } } }
  注册AI工具({
    defineTool,
    ctx,
    rootDir: () => 配置.配置根 || '/tmp/nonexistent-vault',
    diaryRootDir: () => 配置.日记根 || '/tmp/nonexistent-diary',
    配置目录: 配置.配置根 || '/tmp/nonexistent-vault',
    读设置: async () => 配置.设置 || {},
    log: () => {},
  })
  return 注册表
}

/**
 * 复刻宿主「快照 + 冻结」后再交给 render 的做法。
 *
 * 宿主在 createSuccessResult 里先 snapshotToolValue 再 deepFreeze，
 * 传进 render 的是**冻结的副本**，不是 execute 返回的原对象。
 * 如果 render 里偷偷改值，在真宿主上会抛错 —— 这里一并暴露。
 */
function 冻结 (值) {
  return Object.freeze(JSON.parse(JSON.stringify(值)))
}

/** 把 render 结果拍平成模型最终看到的文字 */
function 取文字 (块) {
  return 块.filter((b) => b.type === 'text').map((b) => b.text).join('')
}

test('全部工具都写了 render，且签名是 (args, value)', () => {
  const 工具们 = 造工具()
  assert.equal(工具们.length, 13, '应该有 13 个工具（v1.5.3 加了 build_events / forget_events / impressions）')

  for (const t of 工具们) {
    assert.ok(t.output, `${t.name} 缺 output`)
    assert.equal(typeof t.output.render, 'function', `${t.name} 缺 render`)
    // 宿主传两个参数。箭头函数写 (v) 时 .length 就是 1。
    // 这是本 bug 的**直接判据**：只写一个形参，value 永远拿不到。
    assert.equal(t.output.render.length, 2, `${t.name} 的 render 应该收 (args, value) 两个参数`)
  }
})

test('render 必须返回内容块数组，不是裸字符串', () => {
  const 工具们 = 造工具()
  for (const t of 工具们) {
    const 块 = t.output.render({}, {})
    assert.ok(Array.isArray(块), `${t.name} 的 render 必须返回数组`)
    assert.ok(块.length > 0, `${t.name} 的 render 返回了空数组`)
    for (const b of 块) {
      assert.equal(typeof b, 'object', `${t.name} 的 render 里混进了非对象`)
      assert.equal(typeof b.type, 'string', `${t.name} 的 render 内容块缺 type`)
      if (b.type === 'text') assert.equal(typeof b.text, 'string', `${t.name} 的 text 块缺 text`)
    }
  }
})

test('整段文字类工具：有 text 时必须真的交出去（正是这个 bug 抓的地方）', () => {
  const 工具们 = 造工具()
  const 文字 = '这是一段必须能被模型读到的文字'

  for (const 名 of 整段文字工具) {
    const t = 工具们.find((x) => x.name === 名)
    assert.ok(t, `找不到工具 ${名}`)
    const 块 = t.output.render({ query: '测试' }, 冻结({ text: 文字 }))
    assert.equal(取文字(块), 文字, `${名} 有 text 却渲染成空 —— 典型的 render: (v) => v.text 写错`)
  }
})

test('整段文字类工具：参数里也带 text 时，不能误把参数当结果', () => {
  const 工具们 = 造工具()
  // 关键构造：参数对象里也有 text 字段。
  // 单参数写法 (v) => v.text 会交出"这是参数不是结果"，而不是真正的结果。
  const 参数 = { query: 'x', text: '这是参数不是结果' }
  const 结果 = 冻结({ text: '这才是结果' })

  for (const 名 of 整段文字工具) {
    const t = 工具们.find((x) => x.name === 名)
    assert.equal(取文字(t.output.render(参数, 结果)), '这才是结果', `${名} 把参数当成结果渲染了`)
  }
})

/**
 * 按 output.schema 造一份「字段齐全」的样例值。
 *
 * 为什么不手写固定样本：各工具 schema 不一样（记忆/图片/聊天/人员），
 * 手写容易漏字段，而漏字段会让渲染函数抛 TypeError，
 * 看上去像测试写错，掩盖了真正要验的返空问题。
 * 照 schema 生成就不会漏，以后加字段也自动跟上。
 */
function 按schema造值 (schema, 深度 = 0) {
  if (!schema || typeof schema !== 'object') return undefined
  if (schema.type === 'object') {
    const out = {}
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      const v = 按schema造值(sub, 深度 + 1)
      if (v !== undefined) out[k] = v
    }
    return out
  }
  if (schema.type === 'array') {
    const 项 = 按schema造值(schema.items, 深度 + 1)
    return 项 === undefined ? [] : [项]
  }
  if (schema.type === 'string') return '示例文字'
  if (schema.type === 'number') return 1
  if (schema.type === 'boolean') return true
  return undefined
}

test('结构化类工具：按字段拼出中文句子，模型能读懂', () => {
  const 工具们 = 造工具()
  const 结构化 = 工具们.filter((t) => !整段文字工具.includes(t.name))
  assert.equal(结构化.length, 6, '结构化渲染的工具应该是 6 个')

  for (const t of 结构化) {
    // 照它自己的 schema 造一份字段齐全的样例
    const 样本 = 按schema造值(t.output.schema)
    const 文本 = 取文字(t.output.render({}, 冻结(样本)))
    assert.equal(typeof 文本, 'string', `${t.name} 渲染结果不是字符串`)
    // 字段齐全时不该渲染出空串 —— 那说明有文字没交出去
    assert.ok(文本.length > 0, `${t.name} 对完整数据渲染出了空串`)
  }
})

test('text 为空或缺失时 render 返回空文本块，不抛错', () => {
  const 工具们 = 造工具()
  for (const t of 工具们) {
    for (const 空值 of [{}, { text: '' }, { text: undefined }, { ok: false }]) {
      const 块 = t.output.render({}, 冻结(空值))
      assert.ok(Array.isArray(块), `${t.name} 对空值没返回数组`)
      assert.ok(块.every((b) => typeof b.type === 'string'), `${t.name} 对空值返回了坏内容块`)
    }
  }
})

test('模拟宿主消费：content.some 能正常跑（返回裸字符串会在这里炸）', () => {
  const 工具们 = 造工具()
  for (const t of 工具们) {
    // 用 schema 造完整值：宿主的 content.some 检查只在乎「是不是内容块数组」，
    // 喂残缺数据会先被渲染函数自身的字段缺失挡住，验不到这一层。
    const 样本 = 按schema造值(t.output.schema)
    for (const v of [样本, {}]) {
      const 块 = t.output.render({}, 冻结(v))
      // 宿主在 dsh-tools 里对结果做 result.content.some(...)。
      // 返回裸字符串就会炸 content.some is not a function —— 整次调用判失败。
      assert.doesNotThrow(() => {
        块.some((b) => b.type === 'image')
      }, `${t.name} 的 render 输出过不了宿主的 content.some`)
    }
  }
})

test('包成文本块：null / undefined / 数字都要变成字符串，不能出 null 文本', () => {
  for (const 值 of [null, undefined, 0, 123, false, '']) {
    const 块 = 包成文本块(值)
    assert.equal(块.length, 1)
    assert.equal(块[0].type, 'text')
    assert.equal(typeof 块[0].text, 'string', `包成文本块(${String(值)}) 的 text 不是字符串`)
  }
})
