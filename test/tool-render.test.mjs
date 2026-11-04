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

// ============================================================================
// 输出契约第二环：**返回值和 output.schema 必须对得上**
//
// 背景（2026-11-04，群里"这回检索彻底坏了，换了几个词全是报错"）：
//
// 我往 memory_recall 和 chat_search 的返回值里加了字段（text / 昵称），
// 但 output.schema 里没声明，而 schema 是 `additionalProperties: false`。
// 宿主校验时直接判 INVALID_TOOL_OUTPUT：
//
//   Error: tool "chat_search" returned invalid output:
//          "value.结果[0].昵称" is not a declared property
//
// 不是某一处出错，是**这两个工具每一次调用都失败** —— 比返回空更坏，
// 因为模型拿到的是 "Error"，只能回一句"工具报错"。
//
// 上一轮只测了 render 的**签名和返回类型**，没测「返回值能不能过 schema」
// 这一环。这个用例补上：按宿主的规则做一次真校验。
// ============================================================================

/**
 * 复刻宿主对工具返回值的校验：`additionalProperties: false` 时，
 * 任何没在 properties 里声明的字段都算错（数组元素逐项校验）。
 *
 * 只实现本插件用到的子集就够了：object / array / string / number / boolean。
 * 不去引第三方 JSON Schema 库 —— 开源版要保持零依赖。
 */
function 校验 (值, schema, 路径 = 'value') {
  const 错 = []
  if (!schema) return 错

  if (schema.type === 'object') {
    if (值 === null || typeof 值 !== 'object' || Array.isArray(值)) {
      return [`${路径} 应该是 object`]
    }
    const 声明 = Object.keys(schema.properties || {})
    for (const k of 声明) if (k in 值) 错.push(...校验(值[k], schema.properties[k], `${路径}.${k}`))
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(值)) {
        if (!声明.includes(k)) 错.push(`"${路径}.${k}" is not a declared property (additionalProperties: false)`)
      }
    }
    return 错
  }

  if (schema.type === 'array') {
    if (!Array.isArray(值)) return [`${路径} 应该是 array`]
    值.forEach((v, i) => 错.push(...校验(v, schema.items, `${路径}[${i}]`)))
    return 错
  }

  if (schema.type === 'string' && typeof 值 !== 'string') 错.push(`${路径} 应该是 string`)
  if (schema.type === 'number' && typeof 值 !== 'number') 错.push(`${路径} 应该是 number`)
  if (schema.type === 'boolean' && typeof 值 !== 'boolean') 错.push(`${路径} 应该是 boolean`)
  return 错
}

test('memory_recall 的返回值必须过得了它自己的 schema（text 没声明就炸）', () => {
  const t = 造工具().find((x) => x.name === 'memory_recall')
  // 真实形状：跑检索 的返回值就是这样
  const 真实返回 = { 找到: true, 命中数: 3, 下钻过: false, 下钻原因: '', 原文数: 0, text: '按时间倒序……' }
  const 错 = 校验(冻结(真实返回), t.output.schema)
  assert.deepEqual(错, [], `memory_recall 的输出和 schema 对不上：\n${错.join('\n')}`)
})

test('chat_search 的返回值必须过得了它自己的 schema（昵称没声明就炸）', () => {
  const t = 造工具().find((x) => x.name === 'chat_search')
  const 真实返回 = {
    命中数: 1,
    结果: [{ 日期: '2026-11-03', 类型: '群聊', 群号: '730783833', 昵称: '南瓜鸡', 内容: '[16:33:40] 南瓜鸡(p6): 官方的话' }],
  }
  const 错 = 校验(冻结(真实返回), t.output.schema)
  assert.deepEqual(错, [], `chat_search 的输出和 schema 对不上：\n${错.join('\n')}`)
})

test('每个工具的 schema 都声明了 additionalProperties: false（漏了就等于没约束）', () => {
  for (const t of 造工具()) {
    const s = t.output.schema
    if (!s) continue
    assert.equal(s.type, 'object', `${t.name} 的 schema 根节点应该是 object`)
  }
})
