// ingest.js + settings「允许的插件」的测试：
// 路由注册形态（只一条 POST，绝无 DELETE/PUT）、白名单、限流、字段校验、三种 type 落盘。
//
// 写法对齐 settings.test.mjs：假 webServer 抓路由 → 直接调 handler；
// 假 res 用 { writeHead, end } 收响应；settings 用真的 createSettings + 临时目录。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSettings } from '../lib/settings.js'
import { registerIngestRoutes } from '../lib/ingest.js'
import { 日期键 } from '../lib/chatlog.js'

// ── 公共小工具 ──

const temps = []
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'ingest-test-'))
  temps.push(d)
  return d
}
async function tempConfigPath() {
  return join(await tempDir(), 'settings.json')
}
after(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

async function 建settings(白名单) {
  const s = createSettings({ configPath: await tempConfigPath() })
  if (白名单 !== undefined) await s.write({ '允许的插件': 白名单 })
  return s
}

function 造ctx() {
  const regs = []
  // 真实签名：register({ kind:'exact', path, handler })，且包在 ctx.effect 里
  return { ctx: { webServer: { register: (r) => regs.push(r) }, effect: (fn) => fn() }, regs }
}

function 造res() {
  const out = {}
  return {
    writeHead: (c) => { out.status = c },
    end: (b) => { out.body = b },
    get: () => out,
  }
}

function 造req(body) {
  return { method: 'POST', json: async () => body }
}

async function 调(handler, body) {
  const res = 造res()
  await handler(造req(body), res)
  const o = res.get()
  return { status: o.status, json: JSON.parse(o.body) }
}

async function 调原始(handler, req) {
  const res = 造res()
  await handler(req, res)
  const o = res.get()
  return { status: o.status, json: JSON.parse(o.body) }
}

async function 拿handler(regs, path = '/dsh-memory-vault/ingest') {
  const r = regs.find((x) => x.path === path)
  if (!r) throw new Error(`没找到路由 ${path}，实际注册了：${regs.map((x) => x.path).join(', ')}`)
  return r.handler
}

// ── settings：允许的插件 ──

test('settings: 允许的插件 默认 []；字符串数组与逗号分隔字符串都能写；垃圾项被过滤', async () => {
  const s = createSettings({ configPath: await tempConfigPath() })
  assert.deepEqual((await s.read())['允许的插件'], [], '默认必须是空数组（= 全拒）')

  // 数组：过滤非字符串项，trim 后丢空串
  await s.write({ '允许的插件': ['  a-plugin ', 'b', 123, null, '', 'c'] })
  assert.deepEqual((await s.read())['允许的插件'], ['a-plugin', 'b', 'c'])

  // 逗号分隔字符串 → 拆成数组
  await s.write({ '允许的插件': 'x-plugin, y-plugin ,,z' })
  assert.deepEqual((await s.read())['允许的插件'], ['x-plugin', 'y-plugin', 'z'])

  // 既不是数组也不是字符串 → 忽略该字段，保留当前值
  await s.write({ '允许的插件': { nope: 1 } })
  assert.deepEqual((await s.read())['允许的插件'], ['x-plugin', 'y-plugin', 'z'])
})

test('settings: 允许的插件 sanitize —— 文件里是字符串回退 []，数组里的非字符串被过滤', async () => {
  const p = await tempConfigPath()
  await writeFile(p, JSON.stringify({ version: 1, '允许的插件': 'a,b' }), 'utf8')
  assert.deepEqual((await createSettings({ configPath: p }).read())['允许的插件'], [])

  const p2 = await tempConfigPath()
  await writeFile(p2, JSON.stringify({ version: 1, '允许的插件': [' ok ', 7, 'k', ''] }), 'utf8')
  assert.deepEqual((await createSettings({ configPath: p2 }).read())['允许的插件'], ['ok', 'k'])
})

// ── 注册形态 ──

test('ingest: 只注册一条 exact 路由（/ingest），绝无 DELETE/PUT，也不带 method 字段', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['any'])
  const r = registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })

  assert.deepEqual(r, ['/dsh-memory-vault/ingest'])
  assert.equal(regs.length, 1, '只允许注册一条路由')
  const reg = regs[0]
  assert.equal(reg.path, '/dsh-memory-vault/ingest')
  assert.equal(reg.kind, 'exact', '必须用 kind:exact（宿主真实签名）')
  assert.equal(typeof reg.handler, 'function')
  assert.ok(!('method' in reg), '不得带 method 字段——注册集合里就不该有方法语义')
  assert.deepEqual(Object.keys(reg).sort(), ['handler', 'kind', 'path'])
  for (const x of regs) {
    assert.ok(!/delete|put/i.test(x.path), '路由路径不得含 delete/put 字样')
  }
})

test('ingest: webServer / settings 缺失时容错不抛错，且不注册任何路由', () => {
  const s = createSettings({ configPath: '/tmp/ingest-test-unused.json' })
  const { ctx, regs } = 造ctx()
  assert.equal(registerIngestRoutes(undefined, { settings: s }), undefined)
  assert.equal(registerIngestRoutes(null, { settings: s }), undefined)
  assert.equal(registerIngestRoutes({}, { settings: s }), undefined)
  assert.equal(registerIngestRoutes({ webServer: { register: 'nope' } }, { settings: s }), undefined)
  assert.equal(registerIngestRoutes({ webServer: { register: () => {} } }, {}), undefined, '缺 settings 不注册')
  assert.equal(regs.length, 0)
})

test('ingest: 非 POST 方法 → 405', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['some-plugin'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)
  const r = await 调原始(handler, { method: 'GET' })
  assert.equal(r.status, 405)
  assert.equal(r.json.ok, false)
})

// ── 白名单 ──

test('ingest: 白名单为空（默认）→ 任何 source 都 403，且不落任何盘', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings() // 不写白名单 = 默认 []
  const root = await tempDir()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: root })
  const handler = await 拿handler(regs)

  for (const source of ['some-plugin', 'anyone', 'ab']) {
    const r = await 调(handler, { type: 'memo', source, text: '想写进去的内容' })
    assert.equal(r.status, 403, `source=${source} 应 403`)
    assert.equal(r.json.ok, false)
    assert.ok(r.json.error.includes('白名单'), `错误信息应提到白名单，实际：${r.json.error}`)
  }
  // 盘上不该出现 memos.json / chat 目录
  assert.deepEqual(await readdir(root), [], '403 不得写任何文件')
})

test('ingest: source 在白名单 → memo 存进去，返回 no，memos.json 结构正确', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['memo-plugin'])
  const root = await tempDir()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: root })
  const handler = await 拿handler(regs)

  const r = await 调(handler, {
    type: 'memo', source: 'memo-plugin',
    title: '标题', text: '第一条记忆', tags: ['测试'], time: 1793510392000,
  })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, type: 'memo', no: 1, duplicated: false })

  const d = JSON.parse(await readFile(join(root, 'memos.json'), 'utf8'))
  assert.equal(d.version, 1)
  assert.equal(d.nextNo, 2)
  const e = d.memos['1']
  assert.equal(e.no, 1)
  assert.equal(e.source, 'memo-plugin')
  assert.equal(e.title, '标题')
  assert.equal(e.text, '第一条记忆')
  assert.deepEqual(e.tags, ['测试'])
  assert.equal(e.time, 1793510392000)
  assert.equal(typeof e.receivedAt, 'number')

  // 第二条不同 text → no 递增
  const r2 = await 调(handler, { type: 'memo', source: 'memo-plugin', text: '第二条记忆' })
  assert.equal(r2.json.no, 2)
  assert.equal(r2.json.duplicated, false)
})

test('ingest: 同一 source + 同 text 第二次 → duplicated:true，memos.json 里只有一条', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['dup-plugin'])
  const root = await tempDir()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: root })
  const handler = await 拿handler(regs)

  const body = { type: 'memo', source: 'dup-plugin', text: '重复的内容', time: 1793510392000 }
  const first = await 调(handler, body)
  assert.equal(first.json.duplicated, false)
  const second = await 调(handler, body)
  assert.equal(second.status, 200)
  assert.equal(second.json.ok, true)
  assert.equal(second.json.duplicated, true)
  assert.equal(second.json.no, first.json.no, '重复时返回已有那条的 no')

  // 别的 source 存同样文本不算重复（去重键是 source+text）
  await s.write({ '允许的插件': ['dup-plugin', 'other-plugin'] })
  const third = await 调(handler, { type: 'memo', source: 'other-plugin', text: '重复的内容', time: 1793510392000 })
  assert.equal(third.json.duplicated, false)

  const d = JSON.parse(await readFile(join(root, 'memos.json'), 'utf8'))
  assert.equal(Object.keys(d.memos).length, 2, '盘上只能有两条：dup 一条 + other 一条')
})

// ── 字段校验 ──

test('ingest: text 超长 → 400 且错误信息指出 text 字段；title/tags 超限同样指出字段', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['long-plugin'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  let r = await 调(handler, { type: 'memo', source: 'long-plugin', text: 'x'.repeat(10001) })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.ok(r.json.error.includes('text'), `错误信息应指出 text，实际：${r.json.error}`)

  r = await 调(handler, { type: 'memo', source: 'long-plugin', text: '好', title: '长'.repeat(201) })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('title'), `错误信息应指出 title，实际：${r.json.error}`)

  r = await 调(handler, { type: 'memo', source: 'long-plugin', text: '好', tags: Array.from({ length: 11 }, (_, i) => `标签${i}`) })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('tags'), `错误信息应指出 tags，实际：${r.json.error}`)

  // 边界：恰好 10000 字符应该能存
  r = await 调(handler, { type: 'memo', source: 'long-plugin', text: 'y'.repeat(10000) })
  assert.equal(r.status, 200)
  assert.equal(r.json.duplicated, false)
})

test('ingest: 缺 type 或缺 source → 400', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['m-plugin'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  let r = await 调(handler, { source: 'm-plugin', text: '内容' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('type'), `缺 type 的错误信息应提到 type，实际：${r.json.error}`)

  r = await 调(handler, { type: 'memo', text: '内容' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('source'), `缺 source 的错误信息应提到 source，实际：${r.json.error}`)

  r = await 调(handler, { type: ' nonsense ', source: 'm-plugin', text: '内容' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('type'), `非法 type 的错误信息应提到 type，实际：${r.json.error}`)

  r = await 调(handler, { type: 'memo', source: 'm-plugin' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('text'), `缺 text 的错误信息应提到 text，实际：${r.json.error}`)
})

test('ingest: source 含非法字符 / 长度越界 → 400', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  for (const bad of ['bad source', 'bad@src', '插件', 'a', 'x'.repeat(65), 'a/b', 'a;b']) {
    const r = await 调(handler, { type: 'memo', source: bad, text: '内容' })
    assert.equal(r.status, 400, `source=${JSON.stringify(bad)} 应 400`)
    assert.ok(r.json.error.includes('source'), `错误信息应提到 source，实际：${r.json.error}`)
  }
  // 合法边界：2 字符与 64 字符——格式过了，但白名单空 → 403（而不是 400）
  assert.equal((await 调(handler, { type: 'memo', source: 'ab', text: 'x' })).status, 403)
  assert.equal((await 调(handler, { type: 'memo', source: 'a'.repeat(64), text: 'x' })).status, 403)
})

// ── 请求体大小 ──

test('ingest: body 超 512KB → 400（原始流与宿主 json() 两条路径都拦）', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings() // 白名单故意为空：大小检查必须发生在白名单之前
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  // a) 原始流路径：一个大 Buffer
  const big = JSON.stringify({ type: 'memo', source: 'size-plugin', text: 'x'.repeat(600 * 1024) })
  const stream = (async function* () { yield Buffer.from(big) })()
  let r = await 调原始(handler, stream)
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('512KB'), `错误信息应提到 512KB，实际：${r.json.error}`)

  // b) 宿主已解析好的 json() 路径
  r = await 调(handler, { type: 'memo', source: 'size-plugin', text: 'x'.repeat(600 * 1024) })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('512KB'))

  // c) 边界：恰好 512KB 不拒（走到白名单那步 → 403）
  const prefix = '{"type":"memo","source":"edge-plugin","text":"'
  const suffix = '"}'
  const pad = 'x'.repeat(512 * 1024 - Buffer.byteLength(prefix) - Buffer.byteLength(suffix))
  const body = JSON.parse(prefix + pad + suffix)
  r = await 调(handler, body)
  assert.equal(r.status, 403, '恰好 512KB 不该被大小检查拒')
})

test('ingest: body 不是合法 JSON → 400；空 body → 400 缺 type', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['m2'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  const r = await 调原始(handler, (async function* () { yield Buffer.from('{ 坏 JSON') })())
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('JSON'))

  const r2 = await 调原始(handler, { method: 'POST', json: async () => { throw new Error('坏') } })
  assert.equal(r2.status, 400)
})

// ── chat / text 落盘 ──

test('ingest: chat 缺 chatType → 400；群聊缺/坏 groupId → 400', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['chat-plugin'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  let r = await 调(handler, { type: 'chat', source: 'chat-plugin', text: '你好' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('chatType'), `错误信息应提到 chatType，实际：${r.json.error}`)

  r = await 调(handler, { type: 'chat', source: 'chat-plugin', chatType: 'group', text: '你好' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('groupId'), `错误信息应提到 groupId，实际：${r.json.error}`)

  r = await 调(handler, { type: 'chat', source: 'chat-plugin', chatType: 'group', groupId: '..', text: '你好' })
  assert.equal(r.status, 400)
  assert.ok(r.json.error.includes('groupId'), `路径穿越 groupId 应被拒，实际：${r.json.error}`)
})

test('ingest: chat 私聊走 chatlog 落盘（外部昵称 + pid=source），同键第二次去重', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['chat-plugin'])
  const root = await tempDir()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: root })
  const handler = await 拿handler(regs)

  const time = Date.UTC(2026, 10, 1, 4, 0, 0) // 北京时间 2026-11-01 12:00
  const body = { type: 'chat', source: 'chat-plugin', chatType: 'private', text: '私聊记忆内容', time }
  const r = await 调(handler, body)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, type: 'chat', duplicated: false })

  const date = 日期键(time)
  const file = join(root, 'chat', 'private', `${date}.txt`)
  const line = await readFile(file, 'utf8')
  assert.ok(line.includes('外部:chat-plugin(chat-plugin): 私聊记忆内容'), `实际内容：${line}`)
  assert.equal(line.trim().split('\n').length, 1, '只应有一行')

  const r2 = await 调(handler, body)
  assert.equal(r2.json.duplicated, true)
  const line2 = await readFile(file, 'utf8')
  assert.equal(line2.trim().split('\n').length, 1, '去重后文件仍只有一行')

  // .seen.json 里应有去重键 source:time:前20字
  const seen = JSON.parse(await readFile(join(root, 'chat', '.seen.json'), 'utf8'))
  assert.ok(seen[`chat-plugin:${time}:私聊记忆内容`], '去重键应是 source:time:文本前20字')
})

test('ingest: chat 群聊落到群目录', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['chat-plugin'])
  const root = await tempDir()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: root })
  const handler = await 拿handler(regs)

  const time = Date.UTC(2026, 10, 1, 4, 30, 0)
  const r = await 调(handler, { type: 'chat', source: 'chat-plugin', chatType: 'group', groupId: '987654', text: '群聊记忆', time })
  assert.equal(r.status, 200)
  assert.equal(r.json.duplicated, false)

  const line = await readFile(join(root, 'chat', 'group', '987654', `${日期键(time)}.txt`), 'utf8')
  assert.ok(line.includes('外部:chat-plugin(chat-plugin): 群聊记忆'), `实际内容：${line}`)
})

test('ingest: text 类型固定按私聊落盘，同键第二次去重', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['text-plugin'])
  const root = await tempDir()
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: root })
  const handler = await 拿handler(regs)

  const time = Date.UTC(2026, 10, 1, 5, 0, 0)
  const body = { type: 'text', source: 'text-plugin', text: '文本记忆', time }
  const r = await 调(handler, body)
  assert.equal(r.status, 200)
  assert.deepEqual(r.json, { ok: true, type: 'text', duplicated: false })

  const file = join(root, 'chat', 'private', `${日期键(time)}.txt`)
  const line = await readFile(file, 'utf8')
  assert.ok(line.includes('外部:text-plugin(text-plugin): 文本记忆'), `实际内容：${line}`)

  const r2 = await 调(handler, body)
  assert.equal(r2.json.duplicated, true)
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 1)
})

// ── 限流 ──

test('ingest: 同一 source 每分钟超 60 次 → 第 61 次 429', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['flood-plugin'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: await tempDir() })
  const handler = await 拿handler(regs)

  const body = { type: 'memo', source: 'flood-plugin', text: '限流测试', time: 1793510392000 }
  for (let i = 0; i < 60; i++) {
    const r = await 调(handler, body)
    assert.equal(r.status, 200, `第 ${i + 1} 次应在限额内通过，实际 ${r.status}：${r.json.error}`)
  }
  const over = await 调(handler, body)
  assert.equal(over.status, 429)
  assert.equal(over.json.ok, false)
  assert.ok(over.json.error.includes('60'), `错误信息应说明每分钟 60 次上限，实际：${over.json.error}`)

  // 别的 source 不受牵连（限流按 source 分桶）
  await s.write({ '允许的插件': ['flood-plugin', 'calm-plugin'] })
  const calm = await 调(handler, { type: 'memo', source: 'calm-plugin', text: '不受牵连' })
  assert.equal(calm.status, 200)
})

// ── 其它容错 ──

test('ingest: rootDir 缺失 → 500 且不抛异常', async () => {
  const { ctx, regs } = 造ctx()
  const s = await 建settings(['m3'])
  registerIngestRoutes(ctx, { settings: s, log: () => {}, rootDir: undefined })
  const handler = await 拿handler(regs)
  const r = await 调(handler, { type: 'memo', source: 'm3', text: '内容' })
  assert.equal(r.status, 500)
  assert.equal(r.json.ok, false)
})
