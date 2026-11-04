// 路由注册：把配置读写挂到宿主 webServer 上。
//
// ⚠️ 宿主真实签名（对照 dsh-speak-up/lib/host.js 里跑通的写法）：
//   ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))
//   —— 是 kind: 'exact' 而不是 method；而且必须包在 ctx.effect 里，
//      否则插件卸载时路由不会被回收，重载会报 duplicate route。
//   响应要自己写 head + end，不能只 return 对象。
//
// 容错：webServer 缺失 / 没有 register → 直接 return，不抛错。

import { 脱敏配置 } from './settings.js'
import { readFileSync } from 'node:fs'
import { join as 拼路径 } from 'node:path'

const PREFIX = '/dsh-memory-vault'

/** 统一回 JSON */
function 回JSON(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(obj))
}

/**
 * 读「最近一次模型打分的 token 用量」。
 *
 * 数据源：分层库 chat-levels.json 的 统计.模型.用量（recall-ingest 落盘时写的）。
 * 读不到 / 老版本没有这个字段 → 返回 null，前端据此显示「还没有记录」。
 *
 * ⚠️ 不要在这里做任何写操作，也不要缓存：分层库每隔一会儿就重写一次，
 *    缓存会让面板上的数字停在旧值，用户以为分层没跑。
 */
function 读用量 () {
  try {
    if (!配置目录) return null
    const 库 = JSON.parse(readFileSync(拼路径(配置目录, 'chat-levels.json'), 'utf8'))
    const u = 库 && 库.统计 && 库.统计.模型 && 库.统计.模型.用量
    if (!u || typeof u !== 'object') return null
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    return { prompt: n(u.prompt), completion: n(u.completion), total: n(u.total) }
  } catch {
    return null
  }
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
 *   GET  /dsh-memory-vault/feed      → 投喂账本统计（哪些聊天真的喂过模型）
 *   GET  /dsh-memory-vault/stats     → 占位
 * @returns {string[]|undefined} 已注册路由
 */
export function registerRoutes(ctx, { settings, log, collector, 采集器盒子, 群号们, 配置目录 } = {}) {
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

  // ── 投喂账本（只读）──────────────────────────────────────────────
  //
  // 设置页要显示「有多少聊天真的喂过大模型」，让用户对账单心里有数。
  // 只读：账本只由分层流程在模型成功返回后写，接口不提供写入能力 ——
  // 一个能改账本的接口等于给「重复烧额度」开了个后门。
  挂(`${PREFIX}/feed`, async (req, res) => {
    try {
      const 回 = (code, obj) => {
        res.statusCode = code
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify(obj))
      }
      if (!配置目录) return 回(200, { ok: false, 错误: '没有配置目录，读不到投喂账本' })
      const { join } = await import('node:path')
      const { readFile } = await import('node:fs/promises')
      const { 读账本, 账本统计 } = await import('./recall-fed.js')
      // 和分层库同一个文件 —— 账本跟分层库同生同死，这里也照同一份读
      const 文件 = join(配置目录, 'chat-levels.json')
      let 库 = null
      try {
        库 = JSON.parse(await readFile(文件, 'utf8'))
      } catch {
        // 分层库还不存在 = 还没跑过分层，账本自然是空的
        return 回(200, { ok: true, 账本: 账本统计(null), 生成时间: '' })
      }
      return 回(200, {
        ok: true,
        账本: 账本统计(读账本(库)),
        生成时间: 库.生成时间 || '',
        投喂档位: 库.统计?.模型?.投喂档位 || '',
      })
    } catch (e) {
      说('读投喂账本失败: ' + (e?.message || e))
      try {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ ok: false, 错误: String(e?.message || e) }))
      } catch { /* 响应已经发出去就忽略 */ }
    }
  })

  挂(`${PREFIX}/settings`, async (req, res) => {
    try {
      if (req && req.method === 'POST') {
        const partial = await 取body(req)
        // ⚠️ 密钥的三态语义（不处理会静默把真 key 冲掉）：
        //   '' 或 '***' → 用户没改，保留磁盘上的真值（从 partial 里摘掉）
        //   其它值       → 用户填了新 key，正常写入
        // 前端拿到的是脱敏值 ***，如果它原样提交回来当新 key 存，
        // 下次调用就会带着字面上的三个星号去请求 —— 配置看起来正常，
        // 但每次都 401，而且谁也想不到是这里坏的。踩过的同类坑。
        if (partial && typeof partial === 'object') {
          // 先看显式清除标记：置真则写空串，并把标记复位（一次性指令）
          if (partial['清除模型密钥'] === true) {
            partial['模型密钥'] = ''
            partial['清除模型密钥'] = false
          } else if ('模型密钥' in partial) {
            const k = String(partial['模型密钥'] ?? '')
            if (k === '' || k === '***') delete partial['模型密钥']
            delete partial['清除模型密钥']
          }
        }
        const next = await settings.write(partial)
        回JSON(res, 脱敏配置(next))
        return
      }
      const 当前 = await settings.read()
      // 顺带把「模型打分的真实用量」带回去，供设置页「?」面板显示花费。
      //
      // 【为什么挂在这里，不新开一条路由】用量和设置是同一个页面的同一份数据，
      //   多一条路由就多一个要鉴权、要测、要维护的端面；而且前端本来就要
      //   拉 /settings，合在一起少一次往返。
      // 【为什么读不到就当 null，不当 0】0 会被前端显示成「用了 0 token」，
      //   看起来像「跑过了但没花钱」；null 才会显示「还没有记录」。
      //   这两件事对用户的含义完全不同，不能合并。
      回JSON(res, { ...脱敏配置(当前), 用量: 读用量() })
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    }
  })

  挂(`${PREFIX}/stats`, async (req, res) => {
    回JSON(res, { ok: true })
  })

  // ⭐ 2026-11-02：手动扫描 —— 设置页点一下，立刻把私聊 + 所有配置的群扫一轮，
  //   不用等下一轮定时拉取（默认 60 秒）。
  挂(`${PREFIX}/scan`, async (req, res) => {
    try {
      // 盒子优先（早注册 + 晚塞值），其次用直接传进来的
      const 采集器 = (采集器盒子 && 采集器盒子.collector) || collector
      if (!采集器 || typeof 采集器.sync !== 'function') {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: '采集器还没准备好' }))
        return
      }
      const 出 = { ok: true, 私聊: null, 群们: {} }
      try { 出.私聊 = await 采集器.sync() } catch (e) { 出.私聊 = { error: String(e?.message || e) } }
      const 群s = Array.isArray(群号们) ? 群号们 : (群号们 ? String(群号们).split(',').map((x) => x.trim()).filter(Boolean) : [])
      for (const g of 群s) {
        try { 出.群们[g] = await 采集器.syncGroup(g) } catch (e) { 出.群们[g] = { error: String(e?.message || e) } }
      }
      说('手动扫描完成：' + JSON.stringify({ 私聊: 出.私聊, 群们: 出.群们 }))
      回JSON(res, 出)
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
    }
  })

  说(`已注册 ${已注册.length} 条路由：${已注册.join(', ')}`)
  return 已注册
}
