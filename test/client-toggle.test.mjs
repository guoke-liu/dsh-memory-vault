// 设置页渲染测试：真的把 Section 跑一遍，验证胶囊开关的实际产出
//
// 【为什么要有这条】
// 静态检查（grep 有没有 #3f8f3f）证明不了页面能用。踩过的教训：
// 单测全绿、配置树干净，工具却一个都没注册。UI 同理 ——
// 语法通过、字符串里有关键色値，都可能是个白屏。
//
// 这里用一个最小的假 React 把组件真实执行一遍：
//   · 记录每个元素被创建时的 props
//   · 断言开关渲染成了 button[role=switch]、开着的是绿色、关着的是红色
//   · 断言状态文字「已开启/已关闭」真的出现
//   · 断言禁用逻辑：总开关关着时，子开关是 disabled
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 源码路径 = path.join(本目录, '..', 'lib', 'client.js')

/** 一个足够跑通设置的假 React。 */
function 造假React () {
  const 状态数组 = []
  let 游标 = 0
  const 创建的节点 = []

  const 切初始值 = (init) => (typeof init === 'function' ? init() : init)

  const R = {
    createElement (tag, props, ...kids) {
      const 节点 = { tag, props: { ...(props || {}) }, kids }
      创建的节点.push(节点)
      return 节点
    },
    useState (init) {
      const i = 游标++
      if (状态数组.length <= i) 状态数组[i] = 切初始值(init)
      const set = (v) => { 状态数组[i] = typeof v === 'function' ? v(状态数组[i]) : v }
      return [状态数组[i], set]
    },
    useEffect () { /* 组件挂载时的副作用不需要真跑 */ },
    useMemo (fn) { return fn() },
    useCallback (fn) { return fn },
    useRef (init) { return { current: init } },
    Fragment: 'Fragment',
  }

  // 每次渲染前重置游标，模拟一次新的渲染过程
  const 重置 = () => { 游标 = 0; 创建的节点.length = 0 }
  return { R, 重置, 创建的节点, 状态数组 }
}

/** 搭一个最小宿主，把 client.js 的 factory 跑起来。 */
function 加载组件 () {
  const 源码 = readFileSync(源码路径, 'utf8')
  const { R, 重置, 创建的节点, 状态数组 } = 造假React()
  let 注册结果 = null

  const 假window = {
    __ModuleLoader__: {
      load (def) { 注册结果 = def },
    },
  }

  // 用 Function 包一层，注入 window 与 require
  const 运行 = new Function('window', 'require', 'module', 'exports', 源码)
  const module = { exports: {} }
  运行(假window, (名) => (名 === 'react' ? R : {}), module, module.exports)

  assert.ok(注册结果, 'client.js 没有调用 window.__ModuleLoader__.load')
  assert.equal(注册结果.id, 'dsh-memory-vault')

  const exports = 注册结果.factory((名) => (名 === 'react' ? R : {}))
  return { exports, R, 重置, 创建的节点, 状态数组 }
}

/** 递归找所有 role=switch 的节点。 */
function 找开关 (节点) {
  const 出 = []
  const 走 = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.props && n.props.role === 'switch') 出.push(n)
    for (const k of n.kids || []) {
      if (Array.isArray(k)) k.forEach(走)
      else 走(k)
    }
  }
  走(节点)
  return 出
}

/**
 * 收集一棵树里的全部文本（含嵌套的 kids 与数组）。
 *
 * 不 join 分隔符：文案是多个字符串片段拼出来的
 * （'开 = ...' + '关 = ...' + '没配模型 API 也能用...'），
 * 中间插空格会把「没配模型 API 也能用」这种句子断开，
 * 导致断言误报「缺少关键句」。
 */
function 全部文本 (n) {
  if (n == null) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (typeof n !== 'object') return ''
  return (n.kids || []).flat(Infinity).map(全部文本).join('')
}

test('设置页：胶囊开关真实渲染', () => {
  const { exports, 重置, 创建的节点, 状态数组 } = 加载组件()
  assert.equal(typeof exports.Section, 'function', 'Section 必须是个组件函数')

  重置()
  const 树 = exports.Section({})
  assert.ok(树, 'Section 返回了空树（会白屏）')

  const 开关们 = 找开关(树)
  // 10 个：启用私聊/启用群聊/记私聊聊天/记群聊聊天/定时拉取/
  // 启用聊天分层/用模型打分/定时分层/自动更新预设/清除密钥
  assert.equal(开关们.length, 10, `应该有 10 个胶囊开关，实际 ${开关们.length}`)

  // 每个开关都必须是 button + role=switch + aria-checked
  for (const s of 开关们) {
    assert.equal(s.tag, 'button', '胶囊开关必须是 button（能键盘操作）')
    assert.ok('aria-checked' in s.props, '缺少 aria-checked，读屏软件读不出状态')
    assert.ok(s.props.id, '缺少 id')
  }

  // 默认全关的：用设置里的默认值判断颜色
  const 全文本 = 全部文本(树)
  assert.ok(全文本.includes('已开启') || 全文本.includes('已关闭'), '没有状态文字')

  // 至少有一个开着的（启用私聊默认 true）和一个关着的（启用聊天分层默认 false）
  const 绿 = 开关们.filter((s) => String(s.props.style?.background || '').includes('3f8f3f'))
  const 红 = 开关们.filter((s) => String(s.props.style?.background || '').includes('a33'))
  assert.ok(绿.length >= 1, '默认开启的开关应该是绿色')
  assert.ok(红.length >= 1, '默认关闭的开关应该是红色')

  // 胶囊形状：borderRadius = 高度/2
  for (const s of 开关们) {
    const h = s.props.style?.height
    const r = s.props.style?.borderRadius
    assert.equal(r, h / 2, `胶囊圆角应为高度的一半（高 ${h}，圆角 ${r}）`)
  }

  // 滑块左/右位置随开关状态变化
  for (const s of 开关们) {
    const 球 = (s.kids || []).find((k) => k && k.tag === 'span')
    assert.ok(球, '开关里应该有滑块 span')
    const left = 球.props.style?.left
    assert.ok(typeof left === 'number', '滑块要有 left 位置')
  }
})

test('设置页：总开关关着时子开关禁用', () => {
  const { exports, 重置 } = 加载组件()
  重置()
  const 树 = exports.Section({})
  const 开关们 = 找开关(树)
  const 按id = Object.fromEntries(开关们.map((s) => [s.props.id, s]))

  assert.ok(按id['mv-sw-tier'], '找不到总开关')
  assert.ok(按id['mv-sw-tier-model'], '找不到模型开关')
  assert.ok(按id['mv-sw-tier-cron'], '找不到定时开关')

  // 默认 启用聊天分层=false → 子开关禁用
  assert.equal(按id['mv-sw-tier'].props['aria-checked'], 'false')
  assert.equal(按id['mv-sw-tier-model'].props.disabled, true, '总开关关着时，模型开关应禁用')
  assert.equal(按id['mv-sw-tier-cron'].props.disabled, true, '总开关关着时，定时开关应禁用')
})

test('设置页：说明文字包含关键信息（不能模糊）', () => {
  const { exports, 重置 } = 加载组件()
  重置()
  const 全文本 = 全部文本(exports.Section({}))

  // 每个新开关都要说清「开了怎样、关着怎样、依赖什么」
  const 必含 = [
    ['启用聊天分层', '关着 = 只搜日记'],
    ['用模型打分', '没配模型 API 也能用'],
    ['定时分层', '只处理新增的聊天'],
    ['并入档次', '核心'],
    ['日记库目录', '只读'],
  ]
  for (const [名, 片段] of 必含) {
    assert.ok(全文本.includes(片段), `「${名}」的说明里缺少关键句：${片段}`)
  }
})
