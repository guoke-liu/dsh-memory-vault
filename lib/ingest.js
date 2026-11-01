// ============================================================================
// ingest.js —— 开放接入接口（别的记忆插件把记忆存进来）
//
// 【改这个文件前先知道】
//   · 只有一条路由：POST /dsh-memory-vault/ingest，**只写不读**
//   · 绝不要加 DELETE/PUT 或任何查询接口（这是主人的明确边界）
//   · 四道闸缺一不可：512KB 体积 → 白名单(source) → 每分钟 60 次限流 → 字段校验
//   · 白名单默认**空数组 = 拒绝一切外部写入**，别把默认值改成放行
// ============================================================================

// 开放接入接口：同一个 DSH 实例里，别的记忆插件可以把它们的记忆写进本仓库。
//
// 只开一条路由，只写不读：
//   POST /dsh-memory-vault/ingest
//
// 请求体（JSON）：
//   {
//     type:   'memo' | 'chat' | 'text'   必填
//     source: 'some-plugin'              必填，2..64 字符，只允许字母数字 . _ -
//     title:  '标题'                      memo 用，可选，≤200 字符
//     text:   '记忆内容'                  必填，1..10000 字符
//     tags:   ['关键词']                  可选，最多 10 个，每个 ≤32 字符
//     time:   1793510392000              可选，毫秒时间戳，缺省取当前时间
//   }
//   chat 类型额外要求：chatType('private'|'group')，群聊还必须给 groupId。
//
// 三种 type 的落盘：
//   memo → <rootDir>/memos.json（{ version, nextNo, memos }，以 no 为键递增；
//          同一 source + 同一 text 去重，第二次返回 duplicated:true 不重复存）
//   chat → 复用 chatlog.js 的「追加一条」；昵称 '外部:<source>'，pid=<source>，
//          messageId = source:time:文本前20字 作为去重键
//   text → 同上，固定按私聊落盘
//
// 安全边界（缺一不可）：
//   1. 请求体超过 512KB 直接拒（400）
//   2. settings「允许的插件」白名单：默认空数组 = 拒绝一切外部写入；
//      source 不在名单 → 403
//   3. 同一 source 每分钟最多 60 次（内存滑动窗口），超了 → 429
//   4. 所有输入做长度/格式校验，超限 → 400 并指出是哪个字段
//
// 红线：绝不注册 DELETE/PUT 路由，绝不提供任何查询/删除接口。
// （宿主 webServer 的 token 鉴权在更外层，能走到这里的请求都已过宿主那关。）

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { 追加一条 } from './chatlog.js'

const PREFIX = '/dsh-memory-vault'
const INGEST_PATH = `${PREFIX}/ingest`

const BODY上限字节 = 512 * 1024
const TYPE清单 = ['memo', 'chat', 'text']
const SOURCE_RE = /^[A-Za-z0-9._-]+$/
const SOURCE最短 = 2
const SOURCE最长 = 64
const TITLE上限 = 200
const TEXT上限 = 10000
const TAG个数上限 = 10
const TAG长度上限 = 32
const GROUPID上限 = 64
const 限流窗口ms = 60_000
const 限流每分钟 = 60

const MEMOS文件 = 'memos.json'

// ── 限流：同一 source 每分钟 60 次（滑动窗口；纯内存态，重启即清零）──
const 限流表 = new Map() // source → 毫秒时间戳数组

function 本分钟超限(source, now = Date.now()) {
  const 窗内 = (限流表.get(source) ?? []).filter((t) => now - t < 限流窗口ms)
  if (窗内.length >= 限流每分钟) {
    限流表.set(source, 窗内)
    return true
  }
  窗内.push(now)
  限流表.set(source, 窗内)
  // 顺手清掉整个窗口都过期的 source，防内存无限涨
  if (限流表.size > 1024) {
    for (const [k, v] of 限流表) {
      if (v.every((t) => now - t >= 限流窗口ms)) 限流表.delete(k)
    }
  }
  return false
}

// ── 白名单：settings.read() 里「允许的插件」；顺手兼容逗号分隔字符串 ──
function 读白名单(cfg) {
  let raw = cfg ? cfg['允许的插件'] : null
  if (typeof raw === 'string') raw = raw.split(',')
  if (!Array.isArray(raw)) return []
  return raw.filter((x) => typeof x === 'string').map((x) => x.trim()).filter((x) => x !== '')
}

// ── 读请求体（带 512KB 上限；兼容宿主 json()/body/原始流三种形态）──
// 返回 { body } | { tooLarge: true } | { badJson: true }
async function 取body(req) {
  let raw = null
  if (req && typeof req.json === 'function') {
    // 宿主已给解析好的 body：拿不到原始字节，按再序列化的长度兜底量一次
    let parsed
    try { parsed = await req.json() } catch { return { badJson: true } }
    try { raw = JSON.stringify(parsed ?? {}) } catch { return { badJson: true } }
  } else if (req && req.body !== undefined) {
    raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
  } else if (req) {
    // 原始流：边读边量，一超上限立刻停，不再往下收
    const chunks = []
    let total = 0
    try {
      for await (const c of req) {
        total += Buffer.isBuffer(c) ? c.length : Buffer.byteLength(String(c))
        if (total > BODY上限字节) return { tooLarge: true }
        chunks.push(c)
      }
    } catch { return { badJson: true } }
    raw = Buffer.concat(chunks).toString('utf8')
  } else {
    return { body: {} }
  }
  const text = String(raw)
  if (Buffer.byteLength(text, 'utf8') > BODY上限字节) return { tooLarge: true }
  const t = text.trim()
  if (t === '') return { body: {} }
  try { return { body: JSON.parse(t) } } catch { return { badJson: true } }
}

// ── 校验：先 type/source（白名单和限流都要用到 source），再其余字段 ──

function 校验type和source(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: '请求体必须是 JSON 对象' }
  }
  if (typeof body.type !== 'string' || !TYPE清单.includes(body.type)) {
    return { error: `type 必填，必须是 ${TYPE清单.join(' | ')} 之一` }
  }
  const source = body.source
  if (typeof source !== 'string' || source.length < SOURCE最短 || source.length > SOURCE最长) {
    return { error: `source 必填，必须是 ${SOURCE最短}..${SOURCE最长} 个字符的字符串` }
  }
  if (!SOURCE_RE.test(source)) {
    return { error: 'source 只允许字母、数字和 . _ -' }
  }
  return { value: { type: body.type, source } }
}

function 校验其余字段(body, type) {
  const out = {}

  const text = body.text
  if (typeof text !== 'string' || text.length < 1) return { error: 'text 必填（1..10000 字符的字符串）' }
  if (text.length > TEXT上限) return { error: `text 超过 ${TEXT上限} 字符上限（当前 ${text.length} 个）` }
  if (text.trim() === '') return { error: 'text 不能是纯空白' }
  out.text = text

  if (body.title === undefined || body.title === null || body.title === '') {
    out.title = ''
  } else if (typeof body.title !== 'string') {
    return { error: 'title 必须是字符串' }
  } else if (body.title.length > TITLE上限) {
    return { error: `title 超过 ${TITLE上限} 字符上限（当前 ${body.title.length} 个）` }
  } else {
    out.title = body.title
  }

  if (body.tags === undefined || body.tags === null) {
    out.tags = []
  } else if (!Array.isArray(body.tags)) {
    return { error: 'tags 必须是字符串数组' }
  } else {
    if (body.tags.some((t) => typeof t !== 'string')) return { error: 'tags 里只能放字符串' }
    const tags = body.tags.map((t) => t.trim()).filter((t) => t !== '')
    if (tags.length > TAG个数上限) return { error: `tags 最多 ${TAG个数上限} 个（当前 ${tags.length} 个）` }
    for (let i = 0; i < tags.length; i++) {
      if (tags[i].length > TAG长度上限) return { error: `tags[${i}] 超过 ${TAG长度上限} 字符上限` }
    }
    out.tags = tags
  }

  if (body.time === undefined || body.time === null || body.time === '') {
    out.time = Date.now()
  } else {
    const n = Number(body.time)
    if (!Number.isFinite(n) || n < 0) return { error: 'time 必须是毫秒时间戳（数字）' }
    out.time = Math.round(n)
  }

  out.chatType = null
  out.groupId = null
  if (type === 'chat') {
    if (body.chatType !== 'private' && body.chatType !== 'group') {
      return { error: "chat 类型必须给 chatType: 'private' | 'group'" }
    }
    out.chatType = body.chatType
    if (body.chatType === 'group') {
      const g = typeof body.groupId === 'string' ? body.groupId.trim() : ''
      if (g === '') return { error: '群聊必须给 groupId' }
      if (g === '.' || g === '..' || /[\\/\x00-\x1f]/.test(g)) return { error: 'groupId 含非法字符' }
      if (g.length > GROUPID上限) return { error: `groupId 超过 ${GROUPID上限} 字符上限` }
      out.groupId = g
    }
  }
  return { value: out }
}

// ── memo 落盘：memos.json，串行队列防并发互踩（同 chatlog.js 的做法）──

const memo队列 = new Map()
function memo串行(rootDir, fn) {
  const key = resolve(String(rootDir))
  const 前 = memo队列.get(key) ?? Promise.resolve()
  const 这次 = 前.then(fn, fn)
  memo队列.set(key, 这次.catch(() => {}))
  return 这次
}

// 读 memos.json：损坏/缺失自愈成空表；nextNo 至少大于已有最大 no，避免重号
async function 读memos(rootDir) {
  let d = null
  try { d = JSON.parse(await readFile(join(rootDir, MEMOS文件), 'utf8')) } catch {}
  if (!d || typeof d !== 'object' || Array.isArray(d)) d = {}
  const memos = d.memos && typeof d.memos === 'object' && !Array.isArray(d.memos) ? d.memos : {}
  let nextNo = Number.isInteger(d.nextNo) && d.nextNo >= 1 ? d.nextNo : 1
  for (const k of Object.keys(memos)) {
    const n = Number(memos[k] && memos[k].no != null ? memos[k].no : k)
    if (Number.isInteger(n) && n >= nextNo) nextNo = n + 1
  }
  return { version: 1, nextNo, memos }
}

async function 写memos(rootDir, d) {
  await mkdir(rootDir, { recursive: true })
  const 最终 = join(rootDir, MEMOS文件)
  const 临时 = `${最终}.tmp-${process.pid}-${Date.now()}`
  await writeFile(临时, JSON.stringify(d, null, 1), 'utf8')
  await rename(临时, 最终)
}

async function 存memo(rootDir, 输入, source, receivedAt) {
  return memo串行(rootDir, async () => {
    const d = await 读memos(rootDir)
    // 去重：同一 source + 同一 text 视为同一条
    for (const e of Object.values(d.memos)) {
      if (e && typeof e === 'object' && e.source === source && e.text === 输入.text) {
        return { no: e.no, duplicated: true }
      }
    }
    const no = d.nextNo
    d.nextNo = no + 1
    d.memos[String(no)] = {
      no,
      source,
      title: 输入.title,
      text: 输入.text,
      tags: 输入.tags,
      time: 输入.time,
      receivedAt,
    }
    await 写memos(rootDir, d)
    return { no, duplicated: false }
  })
}

// ── chat / text 落盘：复用 chatlog.js 的「追加一条」──

async function 存聊天(rootDir, { type, source, 输入 }) {
  const messageId = `${source}:${输入.time}:${输入.text.slice(0, 20)}`
  const r = await 追加一条(rootDir, {
    chatType: type === 'chat' ? 输入.chatType : 'private', // text 固定按私聊
    groupId: type === 'chat' ? 输入.groupId : undefined,
    timeMs: 输入.time,
    nickname: `外部:${source}`,
    pid: source,
    messageId,
    text: 输入.text,
  })
  if (r && r.error) return { error: r.error }
  return { duplicated: !!(r && r.duplicated) }
}

/**
 * registerIngestRoutes(ctx, { settings, log, rootDir })
 * 注册一条路由：POST /dsh-memory-vault/ingest（只写不读）。
 * rootDir 可以是字符串，也可以是返回字符串的函数（每次请求现取）。
 * @returns {string[]|undefined} 已注册路由；webServer/settings 缺失时返回 undefined
 */
export function registerIngestRoutes(ctx, { settings, log, rootDir } = {}) {
  const web = ctx && (ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null))
  if (!web || typeof web.register !== 'function') return
  if (!settings || typeof settings.read !== 'function') return
  const 说 = typeof log === 'function' ? log : () => {}
  const 取根 = typeof rootDir === 'function' ? rootDir : () => rootDir

  const handler = async (req, res) => {
    const 回 = (status, obj) => {
      try {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(obj))
      } catch {}
    }
    let source = ''
    try {
      // 只接受 POST（方法不是 POST 的在这里挡掉，405）
      if (req && req.method && req.method !== 'POST') {
        return 回(405, { ok: false, error: '本接口只接受 POST' })
      }
      const 根 = 取根()
      if (!根 || typeof 根 !== 'string') {
        return 回(500, { ok: false, error: '库目录未配置，无法写入' })
      }

      // 1) 请求体上限 512KB
      const r1 = await 取body(req)
      if (r1.tooLarge) {
        return 回(400, { ok: false, error: `请求体超过 ${Math.round(BODY上限字节 / 1024)}KB 上限` })
      }
      if (r1.badJson) {
        return 回(400, { ok: false, error: '请求体不是合法 JSON' })
      }

      // 2) 先验 type/source（白名单和限流都要用 source）
      const v1 = 校验type和source(r1.body)
      if (v1.error) return 回(400, { ok: false, error: v1.error })
      source = v1.value.source

      // 3) 白名单：默认空数组 = 拒绝一切外部写入
      let cfg = {}
      try { cfg = (await settings.read()) || {} } catch { cfg = {} }
      if (!读白名单(cfg).includes(source)) {
        return 回(403, { ok: false, error: `source「${source}」不在「允许的插件」白名单里，拒绝写入` })
      }

      // 4) 限流：同一 source 每分钟最多 60 次
      if (本分钟超限(source)) {
        return 回(429, { ok: false, error: '请求太频繁：同一 source 每分钟最多 60 次', retryAfter: 60 })
      }

      // 5) 其余字段校验
      const v2 = 校验其余字段(r1.body, v1.value.type)
      if (v2.error) return 回(400, { ok: false, error: v2.error })
      const 输入 = v2.value
      const receivedAt = Date.now()

      // 6) 分型落盘
      if (v1.value.type === 'memo') {
        const r = await 存memo(根, 输入, source, receivedAt)
        return 回(200, { ok: true, type: 'memo', no: r.no, duplicated: r.duplicated })
      }
      const r = await 存聊天(根, { type: v1.value.type, source, 输入 })
      if (r.error) return 回(500, { ok: false, error: `落盘失败: ${r.error}` })
      return 回(200, { ok: true, type: v1.value.type, duplicated: r.duplicated })
    } catch (e) {
      回(500, { ok: false, error: `内部错误: ${e && e.message ? e.message : e}` })
    }
  }

  // 宿主真实签名：kind:'exact' + 包在 ctx.effect 里（卸载时自动回收路由）
  const 挂 = () => web.register({ kind: 'exact', path: INGEST_PATH, handler })
  if (typeof ctx.effect === 'function') ctx.effect(挂)
  else 挂()
  说(`已注册开放接入路由：POST ${INGEST_PATH}（只写不读，白名单 + 每分钟 60 次限流）`)
  return [INGEST_PATH]
}
