// ============================================================================
// index.js —— 插件入口（宿主启动时调 apply）
//
// 【改这个文件前先知道】
//   · inject 是对象映射不是数组！值写 null = 可选服务（拿不到也不停 pending）
//   · 这个文件里**任何一步失败都不能抛异常**，统一 try/catch + 记日志。
//     抛出去会让整条插件不激活，症状是「配置树里明明有它，就是没反应」
//   · 外部描述器（视觉模型）从 cfg.描述器路径 动态 import，
//     **插件本体不带任何视觉模型**（开源包要保持纯净）
// ============================================================================

// dsh-memory-vault —— 宿主半边入口。
//
// 三档存图模式 + 设置页 UI + OneBot 收图，开源给所有人用。
//
// 🔴 安全红线（AGENTS.md §3.6.1）：任何依赖拿不到都降级，绝不抛异常让整条插件不激活。
//    没有 webServer 也照常工作（只少设置页路由），没有 OneBot 配置也只是不收图。

import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createSettings } from './settings.js'
import { registerRoutes } from './routes.js'
import { createSelfUpdate } from './selfupdate.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerIngestRoutes } from './ingest.js'
import { createCollector } from './collector.js'
import { createOneBot } from './onebot.js'
import { createDescriber } from './describer.js'
import { 注册AI工具 } from './tools.js'
import { 造引用提示 } from './quotehint.js'
import { 造回忆引导 } from './recallhint.js'

export const name = 'dsh-memory-vault'
// ⚠️ cordis 的 inject 是「服务名 → 拦截配置」的对象映射，不是数组。
//    值为 null 表示「可选」：拿不到该服务也不会让插件停在 pending 状态
//    （源码 lib/index.js 里 `if (isNullable(config)) continue` 就是跳过它）。
//    之前写成空数组 inject=[] ，导致 ctx.get('webServer') 直接报
//    "cannot get property without inject"，设置页路由和 AI 工具全挂。
// ⚠️ agents 必须写进 inject。
//    代码里用 ctx.get('agents') 拿服务，但紧接着的 `|| ctx?.agents` 是**属性访问**，
//    cordis 对未注入的服务属性访问会抛 "cannot get property agents without inject"。
//    现在没炸只是因为 ctx.get 返回了真值把后半段短路掉了 —— 一旦 agents 不可用
//    （别的 profile、宿主升级），这行就抛，被外层 catch 吞掉，引用图/回忆引导
//    整块静默失效，只在 diag.log 留一行。
//    写进 inject 之后，这个服务不存在时 cordis 会等它，而不是让半边插件假死。
export const inject = { webServer: null, tools: null, timer: null, systemPrompt: null, agents: null }

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')

function 日志(root, 行) {
  try {
    mkdirSync(root, { recursive: true })
    const p = join(root, 'diag.log')
    const line = `${new Date().toISOString()}  ${行}\n`
    try {
      if (existsSync(p) && readFileSync(p).length > 512 * 1024) writeFileSync(p, '')
    } catch {}
    writeFileSync(p, line, { flag: 'a' })
  } catch {}
}

/**
 * 插件入口。宿主启动时调一次。
 *
 * 干四件事（任何一件失败都只记日志，不让整条插件挂掉）：
 *   1. 建设置层（settings.js）—— 配置存 ~/.dsh/memory-vault/config.json
 *   2. 注册 HTTP 路由 —— 设置页读写 + 开放接入 ingest
 *   3. 注册 6 个 AI 工具 —— 模型能搜图、搜聊天、列人、导外部记忆
 *   4. 起采集器和定时器 —— 自动拉私聊/群聊；并挂「引用图提示」
 *
 * 🔴 inject 说明（别改回去）：
 *    cordis 的 inject 是「服务名 → 拦截配置」的对象映射，不是数组。
 *    值写 null = 可选：拿不到该服务插件照常跑，不会停在 pending。
 *    曾经写成 `export const inject = []`，结果 ctx.get('webServer') 直接报
 *    「cannot get property without inject」，设置页和工具全挂。
 */
export async function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const 配置目录 = join(DSH_HOME, 'memory-vault')
  const 配置路径 = join(配置目录, 'config.json')

  let settings
  try {
    settings = createSettings({ configPath: 配置路径 })
  } catch (e) {
    日志(配置目录, '设置层初始化失败: ' + (e?.message || e))
    return
  }

  // ⭐ 2026-11-02：用「盒子」把 collector 传给路由。
  //   路由必须在这里注册（早于 collector 创建），而 web.register 对同路径不覆盖，
  //   所以不能在后面补注册 —— 只能传一个可变盒子，handler 调用时再取。
  //   ⚠️ 盒子必须声明在 try 之外：下面 collector 建好后的赋值在另一个 try 块里，
  //      声明在 try 内会导致那个赋值抛 ReferenceError（被 catch 吞掉，盒子永远 null）。
  const 采集器盒子 = { collector: null }

  // ── 路由（设置页读写用；没有 webServer 就跳过，不算错误）──
  try {
    const r = registerRoutes(ctx, {
      settings, log: (m) => 日志(配置目录, m), 采集器盒子, 群号们: cfg.群号,
    })
    if (!r) 日志(配置目录, '没有 webServer，设置页路由跳过（存档功能不受影响）')
    // ⭐ 2026-11-02：新版本推送 —— 注册 /dsh-memory-vault/update
    //   仓库地址从 package.json 的 repository 读；只查不装。
    try {
      const 包根 = join(dirname(fileURLToPath(import.meta.url)), '..')
      createSelfUpdate({ packageRoot: 包根, diag: (m) => 日志(配置目录, m) })
        .register(ctx, '/dsh-memory-vault')
    } catch (e) {
      日志(配置目录, '查更新路由注册失败: ' + (e?.message || e))
    }
  } catch (e) {
    日志(配置目录, '路由注册失败: ' + (e?.message || e))
  }

  // ── 开放接入接口：让别的记忆插件把记忆写进来（只写不读，白名单 + 限流）──
  try {
    const r = registerIngestRoutes(ctx, {
      settings,
      log: (m) => 日志(配置目录, m),
      rootDir: () => cfg.库目录 || 配置目录,
    })
    if (!r) 日志(配置目录, '没有 webServer，开放接入路由跳过（存档功能不受影响）')
  } catch (e) {
    日志(配置目录, '开放接入路由注册失败: ' + (e?.message || e))
  }

  // ── AI 工具（模型直接调用：memory_search / memory_get / memory_recent）──
  try {
    const toolsSvc = ctx?.tools || (typeof ctx?.get === 'function' ? ctx.get('tools') : null)
    if (toolsSvc) {
      // defineTool 从宿主树取；拿不到就降级成恒等函数（结构已按宿主 DSL 写对）
      const { loadDefineTool } = await import('./hostdep.mjs')
      const defineTool = await loadDefineTool()
      注册AI工具({
        defineTool,
        ctx,
        rootDir: () => cfg.库目录 || 配置目录,
        log: (m) => 日志(配置目录, m),
      })
    } else {
      日志(配置目录, '没有 tools 服务，AI 工具未注册（存档不受影响）')
    }
  } catch (e) {
    日志(配置目录, 'AI 工具层失败: ' + (e?.message || e))
  }

  // ── OneBot 收图（配置齐全才启动；缺配置只记一句）──
  try {
    // ⚠️ 是 ONEBOT_GROUPS，不是 ONEOT_GROUPS（少了 B）。
    //    拼错时走环境变量这条路永远读不到群号，而且不报错 —— 群聊采集静默失效。
    //    为兼容已经按错拼法部署的环境，两个都认，但正确拼法优先。
    const 群号配置 = cfg.群号 || process.env.ONEBOT_GROUPS || process.env.ONEOT_GROUPS || ''
    if (群号配置 && !cfg.群号) cfg.群号 = 群号配置
    const onebotUrl = cfg.onebotUrl || process.env.ONEBOT_URL || ''
    const ownerQq = cfg.ownerQq || process.env.ONEBOT_OWNER_QQ || ''
    if (!onebotUrl || !ownerQq) {
      日志(配置目录, '未配置 OneBot（onebotUrl/ownerQq），收图功能不启动')
    } else {
      // token 来源优先级：插件配置 → 环境变量 → 复用 qq-bridge 的配置（不复制明文）
      let token = cfg.onebotToken || process.env.ONEBOT_TOKEN || ''
      if (!token) {
        try {
          const 桥配置 = JSON.parse(readFileSync(join(DSH_HOME, 'qq-bridge-config.json'), 'utf8'))
          if (桥配置 && typeof 桥配置['令牌'] === 'string') token = 桥配置['令牌']
        } catch {}
      }
      const client = createOneBot({ baseUrl: onebotUrl, token })
      // 通用能力：允许从配置文件指定一个外部「描述器模块」。
      // 任何用户都可以写自己的视觉模型接在这里（模块导出 造看图器() 即可）。
      // 本插件不带任何视觉模型 —— 保持开源包纯净。
      let 外部描述器 = null
      try {
        const 路径 = cfg.描述器路径 || ''
        if (路径) {
          const m = await import(路径)
          if (typeof m.造看图器 === 'function') {
            外部描述器 = m.造看图器()
            日志(配置目录, '已加载外部描述器: ' + 路径)
          } else {
            日志(配置目录, '外部描述器缺少 造看图器()，忽略: ' + 路径)
          }
        }
      } catch (e) {
        日志(配置目录, '加载外部描述器失败: ' + (e?.message || e))
      }
      const collector = createCollector({
        onebot: client,
        rootDir: cfg.库目录 || 配置目录,
        userId: String(ownerQq),
        log: (m) => 日志(配置目录, m),
        settings,
        describer: 外部描述器 ? createDescriber({ 自定义描述器: 外部描述器 }) : undefined,
      })

      // ⭐ 2026-11-02：collector 建好，塞进盒子 —— /scan 路由立刻可用
      采集器盒子.collector = collector
      // ⭐ 2026-11-02：首次安装自动回填历史聊天记录。
      //   主人原话：「第一次安装本插件自动搜索聊天记录补全」
      //   只跑一次：跑完写标记文件，之后重启不再重复（否则每次都把老消息重扫一遍）。
      //   在后台跑，不阻塞插件启动；失败就记日志，不影响正常收消息。
      try {
        const fsb = await import('node:fs/promises')
        const 标记 = 配置目录 + '/.backfill-done.json'
        let 已回填 = false
        try { await fsb.access(标记); 已回填 = true } catch {}
        if (!已回填 && collector && typeof collector.回填历史 === 'function') {
          setTimeout(async () => {
            try {
              const 群们 = Array.isArray(cfg.群号) ? cfg.群号 : (cfg.群号 ? String(cfg.群号).split(',').map((x) => x.trim()).filter(Boolean) : [])
              const 上限 = Number(cfg.回填条数) || 500
              日志(配置目录, `首次安装：开始回填历史（上限 ${上限} 条/会话）`)
              let 总 = 0
              const r0 = await collector.回填历史({ 上限, 说: (m) => 日志(配置目录, '[回填私聊] ' + m) })
              总 += r0.条数
              for (const g of 群们) {
                const r = await collector.回填历史({ 群号: g, 上限, 说: (m) => 日志(配置目录, '[回填] ' + m) })
                总 += r.条数
              }
              await fsb.writeFile(标记, JSON.stringify({ 时间: new Date().toISOString(), 条数: 总 }), 'utf8')
              日志(配置目录, `首次回填完成：共 ${总} 条（不再重复）`)
            } catch (e) {
              日志(配置目录, '首次回填失败: ' + (e?.message || e))
            }
          }, 8000)   // 等插件完全起来再跑
        }
      } catch (e) {
        日志(配置目录, '首次回填检查失败: ' + (e?.message || e))
      }

      // 定时拉取：受设置页的「定时拉取」开关控制，关掉就完全不跑。
      // 每轮都重新读一次设置，改了开关下一轮立刻生效（不用重启）。
      const timer = (typeof ctx?.get === 'function' ? ctx.get('timer') : null) || ctx?.timer
      if (timer && typeof timer.setInterval === 'function') {
        const 基础秒 = Math.max(10, Number(cfg.轮询秒) || 60)
        let 停止 = null
        const 跑一轮 = async () => {
          let 配置 = {}
          try { 配置 = await settings.read() } catch {}
          if (配置 && 配置.定时拉取 === false) return   // 开关关了，这一轮不做
          try {
            await collector.sync()
            // 群聊：只有「记群聊聊天」开着才拉
            if (配置 && 配置.记群聊聊天 !== false) {
              const 群们 = Array.isArray(cfg.群号) ? cfg.群号 : (cfg.群号 ? String(cfg.群号).split(',').map((x) => x.trim()).filter(Boolean) : [])
              for (const g of 群们) {
                try { await collector.syncGroup(g) } catch (e) { 日志(配置目录, `群 ${g} 拉取失败: ${e?.message || e}`) }
              }
            }
          } catch (e) {
            日志(配置目录, '定时拉取失败: ' + (e?.message || e))
          }
        }
        // 间隔也每轮重读：用一个短心跳，到点才真正拉，这样改间隔不用重启
        const 心跳秒 = 10
        let 累计 = 0
        let 上次间隔 = 基础秒
        停止 = timer.setInterval(async () => {
          let 配置 = {}
          try { 配置 = await settings.read() } catch {}
          上次间隔 = 配置 && 配置.拉取间隔秒 >= 10 ? Number(配置.拉取间隔秒) : 基础秒
          累计 += 心跳秒
          if (累计 < 上次间隔) return
          累计 = 0
          await 跑一轮()
        }, 心跳秒 * 1000)
        日志(配置目录, `定时拉取已就绪（基础间隔 ${基础秒} 秒，受设置页开关控制）`)
        if (typeof ctx.effect === 'function' && 停止) ctx.effect(() => () => { try { 停止() } catch {} })
      } else {
        日志(配置目录, '没有 timer 服务，收图需手动调用 collector.sync()')
      }
      ctx.__imgArchiveCollector = collector

      // ── 引用图提示：让「鱼」这一轮看得到别人引用的图 ──
      // QQ 桥对引用消息只写一句「[引用了一条消息]」，被引用的图传不进来。
      // 但 OneBot 侧能反查：群消息里的 reply 段 → get_msg 取回原消息 → 有图就描述。
      // 这里 30 秒刷一次，攒进内存；再用宿主 systemPrompt.context() 追加到
      // 对话末尾。**必须用 context，不能用 section** —— section 会改系统提示词，
      // 让整段 prompt 缓存失效（实测贵 20 倍）；context 只追加、内容不变就不重发。
      try {
        const 群们 = Array.isArray(cfg.群号) ? cfg.群号 : (cfg.群号 ? String(cfg.群号).split(',').map((x) => x.trim()).filter(Boolean) : [])
        if (群们.length === 0) {
          日志(配置目录, '没配群号，引用图提示不启动')
        } else {
          const 提示们 = 群们.map((g) => 造引用提示({ onebot: client, 群号: g, 日志: (m) => 日志(配置目录, '[引用图] ' + m), 描述器: 外部描述器 ? createDescriber({ 自定义描述器: 外部描述器 }) : undefined }))
          const 文本 = () => 提示们.map((q) => q.当前文本()).filter(Boolean).join('\n')
          ctx.__quoteHints = 提示们

          // 每 30 秒刷一次（失败静默；timer 拿不到就只剩启动时那一次）
          const 引图timer = (typeof ctx?.get === 'function' ? ctx.get('timer') : null) || ctx?.timer
          const 每30秒 = (fn) => {
            if (引图timer && typeof 引图timer.setInterval === 'function') {
              const d = 引图timer.setInterval(fn, 30 * 1000)
              if (typeof ctx.effect === 'function') ctx.effect(() => () => { try { d() } catch {} })
              return true
            }
            return false
          }
          if (每30秒(() => { for (const q of 提示们) { try { q.刷新() } catch {} } })) {
            日志(配置目录, `引用图提示已就绪（${群们.length} 个群，每 30 秒刷新）`)
          } else {
            日志(配置目录, '没有 timer 服务，引用图提示只在启动时刷新一次')
          }

          // context() 是**会话级**的：要挂在每个活着的 agent 自己的 ctx 上，
          // 所以这里按 fish-memory 的做法，定期扫 agents.list() 逐个挂上
          // （agent 实例会被宿主换掉，换了就卸旧的重挂）。
          // 回忆引导：库里真有东西才注入（空库还引导它去搜，等于让它空转）
          // ⚠️ 真因：宿主 resolveContext() 是**同步**取 text 的（entry.text(context)），
          //    renderContextSections 再 filter(s => s.text.length > 0)。
          //    如果 text 是 async 函数，返回的是 Promise → .length 是 undefined →
          //    `undefined > 0` 为 false → 这段被**静默丢弃**，一个报错都没有。
          //    recallhint 从 v1.2.0 起就没生效，原因就是这个。
          // 修法：text 必须同步返回字符串 —— 用缓存，后台异步刷新。
          let 回忆缓存 = ''
          const 原始回忆 = 造回忆引导({
            有记忆: async () => {
              try {
                const fs = await import('node:fs/promises')
                const 根 = 配置目录
                // 图片索引有内容，或者今天/任何一天有聊天记录，就算「有记忆」
                const 读到 = async (p) => { try { return await fs.readFile(p, 'utf8') } catch { return '' } }
                const idx = await 读到(根 + '/index.json')
                if (idx && /"no"\s*:\s*\d/.test(idx)) return true
                const 描述 = await 读到(根 + '/descriptions.json')
                if (描述 && /"no"\s*:\s*\d/.test(描述)) return true
                // 聊天记录：扫 chat/private 下有没有非空文件
                try {
                  const fsd = await import('node:fs')
                  const dir = 根 + '/chat/private'
                  const names = fsd.readdirSync(dir)
                  for (const n of names) {
                    const st = fsd.statSync(dir + '/' + n)
                    if (st.size > 0) return true
                  }
                } catch {}
                return false
              } catch { return false }
            },
          })
          // 同步提供器：只读缓存，绝不返回 Promise
          const 回忆文本 = () => 回忆缓存
          const 刷新回忆缓存 = async () => {
            try { 回忆缓存 = (await 原始回忆()) || '' } catch { 回忆缓存 = '' }
          }
          await 刷新回忆缓存()
          const sp = typeof ctx?.get === 'function' ? ctx.get('systemPrompt') : null
          // 只用 ctx.get：ctx?.agents 的属性访问对未注入服务会抛，见文件头 inject 的说明
          const agentsSvc = typeof ctx?.get === 'function' ? ctx.get('agents') : null
          if (!sp || !agentsSvc || typeof agentsSvc.list !== 'function') {
            // 退而求其次：数据照刷，结果记进日志
            日志(配置目录, '拿不到 systemPrompt/agents 服务，引用图数据只进日志（每 30 秒记一条）')
            每30秒(() => {
              const t = 文本()
              if (t) 日志(配置目录, '[引用图降级] ' + t.replace(/\n/g, ' ⏎ '))
            })
          } else {
            const 已挂 = new Map()   // agent -> { agent, off }（off 是 effect disposer）
            let 上次agent数 = -1
            const 挂一轮 = () => {
              try {
                const 全部agent = agentsSvc.list() || []
                if (全部agent.length !== 上次agent数) {
                  上次agent数 = 全部agent.length
                  日志(配置目录, '[回忆引导] 扫到 ' + 全部agent.length + ' 个 agent')
                }
                for (const agent of 全部agent) {
                  const sid = agent?.id ?? agent?.session?.id
                  if (!sid) continue
                  const ctx2 = agent?.ctx
                  if (!ctx2 || !ctx2.systemPrompt || typeof ctx2.systemPrompt.context !== 'function') continue
                  const 旧 = 已挂.get(agent)
                  if (旧 && 旧.agent === agent) continue
                  if (旧) { try { 旧.off() } catch {} ; 已挂.delete(agent) }
                  try {
                    // 宿主 effect 的 disposer：能拿到函数就直接调，拿不到就空操作
                    const off1 = ctx2.systemPrompt.context({
                      name: 'memory-vault-quote',
                      order: 910,
                      interpolate: false,
                      // ⭐ 必须 required：宿主每轮先用 assemble() 建快照，再用
                      // refreshContext() 刷新；refreshContext 只遍历快照里**已有**的
                      // 名字，非 required 的新注册不会被补进去。插件是隔 30 秒才挂上
                      // 的（agent 比插件晚创建），赶不上那次 assemble —— 不带 required
                      // 就永远进不了模型上下文（fish-memory 能进是因为它挂得早）。
                      required: true,
                      text: 文本,
                    })
                    // 主动回忆引导：告诉模型什么时候该自己调工具去翻记忆。
                    // 排在引用图后面（911），两段都是 context，不改系统提示词。
                    let off2 = null
                    try {
                      off2 = ctx2.systemPrompt.context({
                        name: 'memory-vault-recall',
                        order: 911,
                        interpolate: false,
                        required: true,   // 同上，见 memory-vault-quote 处的说明
                        text: 回忆文本,
                      })
                    } catch (e) {
                      日志(配置目录, '[回忆引导] 挂 ' + sid + ' 失败: ' + (e?.message || e))
                    }
                    日志(配置目录, '[回忆引导] 已挂 ' + sid + '（recall=' + (typeof off2) + '）')
                    已挂.set(agent, {
                      agent,
                      off: () => {
                        try { if (typeof off1 === 'function') off1() } catch {}
                        try { if (typeof off2 === 'function') off2() } catch {}
                      },
                    })
                  } catch (e) { 日志(配置目录, '[引用图] 挂 ' + sid + ' 失败: ' + (e?.message || e)) }
                }
              } catch (e) { 日志(配置目录, '[引用图] 扫 agents 失败: ' + (e?.message || e)) }
            }
            挂一轮()
            每30秒(() => { try { 挂一轮() } catch {} })
            if (typeof ctx.effect === 'function') ctx.effect(() => () => {
              for (const v of 已挂.values()) { try { v.off() } catch {} }
              已挂.clear()
            })
          }
        }
      } catch (e) {
        日志(配置目录, '引用图提示初始化失败: ' + (e?.message || e))
      }
    }
  } catch (e) {
    日志(配置目录, '收图层初始化失败: ' + (e?.message || e))
  }

  日志(配置目录, `插件启动 配置=${配置路径}`)
}
