// 从宿主树里取 defineTool（拿不到就降级成恒等函数）。
// 🔴 绝不因为拿不到就抛异常 —— 那会让整条插件不激活（AGENTS.md §3.6.1）。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/**
 * 列出所有可能藏着宿主 @deepseek-ai 包的目录，按可能性排序。
 *
 * ⚠️ /opt/dshapp/runtime/node_modules 必须排第一 —— 那是**本机** DSH 的实际安装位置，
 *    不是标准的 npm 全局目录。漏掉它会导致本机拿不到 defineTool、只能走降级，
 *    进而在模型侧报 `schema must be a JSON Schema of 'type:"object"', got 'type: null'`。
 *    云端 DSH 在 /usr/lib/node_modules，所以云端一直正常、本机报错 —— 别被这种差异骗过去。
 *
 * @returns {string[]} 候选目录绝对路径（去重、保序）
 */
function 候选根() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  // ⚠️ 本机 DSH 的实际安装位置，必须排第一（文件头注释就是这么写的）。
  //    早先漏了这一条，本机只能探到 /usr/local 和 /usr/lib，探不到就静默降级，
  //    模型侧报 schema must be object, got type null —— 云端因为装在
  //    /usr/lib/node_modules 所以一直正常，这个差异把问题藏了很久。
  push('/opt/dshapp/runtime/node_modules')
  for (const b of ['/usr/local/lib/node_modules', '/usr/lib/node_modules']) {
    push(join(b, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(b, '@deepseek-ai'))
  }
  try {
    const h = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(h, 'profiles'))) push(join(h, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch {}
  return out
}

/**
 * 按某个包的 package.json `exports['.']` 找出入口文件的 file:// URL。
 *
 * @param {string} root  候选根目录（里面应直接有 @deepseek-ai 的子目录）
 * @param {string} name  包名（如 'dsh-tools'）
 * @returns {string|null} 入口的 file:// URL；找不到返回 null（不抛错）
 */
function 入口(root, name) {
  try {
    const dir = join(root, name)
    const pkg = join(dir, 'package.json')
    if (!existsSync(pkg)) return null
    const j = JSON.parse(readFileSync(pkg, 'utf8'))
    const dot = j.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || j.module || j.main)
    if (!rel) return null
    const f = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(f) ? pathToFileURL(f).href : null
  } catch { return null }
}

/**
 * 从宿主树里取 defineTool。拿不到就降级成「自己规范化 schema」的等价实现。
 *
 * 🔴 绝不因为拿不到就抛异常 —— 那会让整条插件不激活（AGENTS.md §3.6.1）。
 *
 * ⚠️ 降级时**不能**恒等返回 `(o) => o`：
 *    `parameters` 会原样透传成属性映射 `{no:{type:'number'}}`，
 *    模型侧收到的 schema 没有 `type:'object'`，直接报 `got "type": null`。
 *    必须走 规范成宿主工具() 把属性映射转成标准 JSON Schema。
 *
 * @returns {Promise<Function>} 永远是函数，可以放心调用
 */
export async function loadDefineTool() {
  for (const root of 候选根()) {
    const url = 入口(root, 'dsh-tools')
    if (!url) continue
    try {
      const m = await import(url)
      if (typeof m.defineTool === 'function') return m.defineTool
    } catch {}
  }
  // 降级：把参数属性映射规范成标准 JSON Schema，再原样交回去。
  // ⚠️ 这里**绝不能** `return (o) => o`：那样 parameters 会原样透传成属性映射
  //    {no:{type:'number'}}，模型侧收到的 schema 没有 type:'object'，
  //    直接报 `schema must be a JSON Schema of 'type:"object"', got "type: null"`。
  return 规范成宿主工具()
}

/**
 * 拿不到宿主 defineTool 时的降级实现。
 *
 * 【要做什么】把插件写的「属性映射」参数 DSL 转成标准 JSON Schema：
 *   { 内容: { type: 'string', required: true, description: '…' }, 标签: {...} }
 *   → { type:'object', properties:{ 内容:{type:'string'},… }, required:['内容'], additionalProperties:false }
 *
 * 【为什么不能恒等】见上面 loadDefineTool 的注释 —— 会直接让模型侧报 type: null。
 *
 * 【还要做什么】把标量类型上的 `required: true` **收进根层 required 数组**。
 *   0.2.0 的宿主不允许在 number/string 这类标量上写 required:true，
 *   原样留着会报 `required is not supported on type "number"`。
 *
 * 【不改什么】render / execute / output.schema 一律原样保留 —— 降级只负责
 *   参数 schema 这一件事，别的都保持插件作者写的样子。
 */
export function 规范成宿主工具() {
  return (spec) => {
    if (!spec || typeof spec !== 'object') return spec
    const 原参数 = spec.parameters
    // 已经是标准 JSON Schema（有 type:'object' + properties）就原样放行
    const 已是标准 = 原参数 && typeof 原参数 === 'object' && 原参数.type === 'object' && 原参数.properties
    if (已是标准) return { ...spec, parameters: 原参数 }
    if (!原参数 || typeof 原参数 !== 'object') return spec

    const properties = {}
    const required = []
    for (const [名, 定义] of Object.entries(原参数)) {
      if (!定义 || typeof 定义 !== 'object') continue
      // 把标量上的 required:true 搬到根层，并从属性定义里删掉
      const { required: 必填, ...其余 } = 定义
      properties[名] = 其余
      if (必填 === true) required.push(名)
    }
    return {
      ...spec,
      parameters: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
    }
  }
}
