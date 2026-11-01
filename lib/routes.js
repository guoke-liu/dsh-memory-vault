// 路由注册：把配置读写挂到宿主 webServer 上。
//
// ⚠️ 宿主真实签名（对照 dsh-speak-up/lib/host.js 里跑通的写法）：
//   ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
//   —— 是 kind: 'exact' 而不是 method；而且必须包在 ctx.effect 里，
//      否则插件卸载时路由不会被回收，重载会报 duplicate route。
//   响应要自己写 head + end，不能只 return 对象。
//
// 容错：webServer 缺失 / 没有 register → 直接 return，不抛错。

const PREFIX = '/dsh-memory-vault'

/** 统一回 JSON */
function 回JSON(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

async function 取body(req) {
  try {
    if (req && typeof req.json === 'function') return await req.json()
    if (req && req.body !== undefined) {
      return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body
    }
    // 读流
    const chunks = []
    for await (const c of req) chunks.push(c)
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/**
 * registerRoutes(ctx, { settings, log })
 * 注册：
 *   GET  /dsh-memory-vault/settings  → settings.read()
 *   POST /dsh-memory-vault/settings  → settings.write(body)
 *   GET  /dsh-memory-vault/stats     → 占位
 * @returns {string[]|undefined} 已注册路由
 */
export function registerRoutes(ctx, { settings, log } = {}) {
  const web = ctx && (ctx.webServer || (typeof ctx.get === 'function' ? ctx.get('webServer') : null))
  if (!web || typeof web.register !== 'function') return
  if (!settings || typeof settings.read !== 'function') return

  const 说 = typeof log === 'function' ? log : () => {}
  const 已注册 = []

  // ctx.effect 存在就包起来（卸载时自动回收），不存在就直接注册
  const 挂 = (path, handler) => {
    const 做 = () => web.register({ kind: 'exact', path, handler })
    if (typeof ctx.effect === 'function') ctx.effect(做)
    else 做()
    已注册.push(`${path}`)
  }

  挂(`${PREFIX}/settings`, async (req, res) => {
    try {
      if (req && req.method === 'POST') {
        const partial = await 取body(req)
        const next = await settings.write(partial)
        回JSON(res, next)
        return
      }
      回JSON(res, await settings.read())
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    }
  })

  挂(`${PREFIX}/stats`, async (req, res) => {
    回JSON(res, { ok: true })
  })

  说(`已注册 ${已注册.length} 条路由：${已注册.join(', ')}`)
  return 已注册
}
