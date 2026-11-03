// ============================================================================
// tools.js —— AI 工具层（模型能调的那 6 个工具）
//
// 【改这个文件前先知道】—— 这几条都是踩过坑的，改回去会直接让鱼收不到结果
//   1. parameters 用属性映射 { key:{type,required,description} }，
//      不是 { type:'object', properties:{...} }
//   2. required:true 只能写在**属性上**；标量类型内部不能写 required（0.2.0 拒）
//   3. output.render **必须返回内容块数组**，用 包成文本块() 包一层；
//      返回裸字符串 → 宿主 content.some 崩 → 整次调用失败（AGENTS.md §3.6.2）
//   4. 每个工具都必须有 output.schema 和 render，缺一个就注册不上
//
// 【加新工具时】照着 memory_recent 抄一份，改 name/description/parameters/
//   output/execute，然后在 test/tools.test.mjs 里把工具数量断言 +1
// ============================================================================

// AI 工具层：把档案库变成模型能直接调用的检索接口。
//
// 设计思路（主人 2026-11-01）：「做成 AI 也能索引调用的形式」
//
// 模型不该自己读 index.json —— 它看不懂 64 位 sha256，也不会算引用次数。
// 所以给三个工具：
//   memory_search    按关键词找图（用文字描述检索，返回编号+描述）
//   memory_get       按编号取详情（原图路径、谁发的、什么时候、被引用几次）
//   memory_recent    最近收到的几张（不需要关键词，按时间倒序）
//
// 关键词检索是「分词 + 打分」，不依赖向量库（开源给没 GPU 的人用）。

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { 搜索记录, 列出已有日期 } from './chatlog.js'
import { 切词, 打分 } from './search-core.js'
import { 扩展查询词 } from './search-expand.js'
export { 切词, 打分 }

/**
 * ⚠️ 宿主要求 output.render 返回**内容块数组**（[{type:'text', text}]），不是裸字符串。
 *    返回字符串会让宿主在 result.content.some(...) 处炸：
 *    「content.some is not a function」——这个错会让整次工具调用失败（鱼就收不到结果）。
 */
/**
 * 把一段文字包成宿主认的「内容块数组」。**所有工具 render 都必须走这个。**
 *
 * @param {string} 文本 要显示给模型看的文字
 * @returns {{type:'text', text:string}[]}
 *
 * 🔴 为什么必须包：宿主在 dsh-tools 里对工具结果做 `result.content.some(...)`
 *    （判断有没有图片块）。render 直接返回字符串 → 抛 `content.some is not a function`
 *    → 整次工具调用被判失败 → **模型一个字都拿不到**。
 *    这个 bug 在鱼身上真实发生过（她说「工具又闹脾气了」），详见 AGENTS.md §3.6.2。
 */
export function 包成文本块(文本) {
  const t = String(文本 ?? '')
  return [{ type: 'text', text: t }]
}

/** 读文字描述库；不存在返回空 */
async function 读描述库(rootDir) {
  try {
    const d = JSON.parse(await readFile(join(rootDir, 'descriptions.json'), 'utf8'))
    if (d && typeof d === 'object' && d.images && typeof d.images === 'object') return d
  } catch {}
  return { version: 1, nextNo: 1, images: {} }
}

/** 读人物表（编号→昵称） */
async function 读人表(rootDir) {
  try {
    const d = JSON.parse(await readFile(join(rootDir, 'people.json'), 'utf8'))
    if (d && d.people && typeof d.people === 'object') return d.people
  } catch {}
  return {}
}

/**
 * 搜索。
 * @returns {Promise<Array<{no, text, score, imageSha, refCount, lastSeen}>>}
 */
/**
 * 按关键词搜图片描述（不是搜图片本身 —— 图片没法用文字搜）。
 *
 * @param {string} rootDir
 * @param {string} query  用户的一句话
 * @param {object} [opts]
 * @param {number} [opts.limit] 最多几条，默认 10，最大 50
 * @returns {Promise<Array<{no, text, score, imageSha, refCount, lastSeen}>>}
 *   已按相关度排序；score 越高越相关
 */
export async function 搜索(rootDir, query, { limit = 10 } = {}) {
  const 库 = await 读描述库(rootDir)
  // 2026-11-02：查询侧做近义扩展（难过→不开心/伤心/难受…），提高中文召回。
  // 原词全部保留，扩展词只加不减，原来能命中的仍然能命中。
  const 查询词 = 扩展查询词(切词(query))
  if (!查询词.length) return []
  const 结果 = []
  for (const e of Object.values(库.images)) {
    const 分 = 打分(e.text, 查询词)
    if (分 <= 0) continue
    结果.push({
      no: e.no,
      text: e.text,
      score: 分,
      imageSha: e.imageSha || null,
      refCount: Array.isArray(e.refs) ? e.refs.length : 0,
      lastSeen: e.lastSeen || 0,
      // ⭐ 2026-11-02：把引用记录带出来，检索层才能按群过滤（修「串群」）
      refs: Array.isArray(e.refs) ? e.refs : [],
    })
  }
  结果.sort((a, b) => b.score - a.score || b.lastSeen - a.lastSeen)
  return 结果.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))
}

/**
 * 搜聊天记录。返回命中行，按日期从新到旧。
 * @param {object} opts { chatType, groupId, limit }
 */
/**
 * 搜聊天记录。底层是 chatlog.搜索记录，这里是给工具层用的包装。
 *
 * @param {object} opts
 * @param {'private'|'group'} [opts.chatType] 不传=私聊群聊都搜
 * @param {string} [opts.groupId]  只看某个群
 * @param {string} [opts.person]   只看某个人（pid 'p1' 或 QQ 号都行）
 * @param {number} [opts.limit]    默认 20，最大 100
 * @returns {Promise<{命中数:number, 结果:Array<{日期,类型,群号,内容}>}>}
 */
export async function 搜聊天(rootDir, query, { chatType, groupId, person, limit = 20 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { 命中数: 0, 结果: [] }
  const rows = await 搜索记录(rootDir, q, {
    chatType: chatType || undefined,
    groupId: groupId || undefined,
    person: person || undefined,
    limit: Math.max(1, Math.min(Number(limit) || 20, 100)),
  })
  return {
    命中数: rows.length,
    结果: rows.map((r) => ({
      日期: r.date,
      类型: r.chatType === 'group' ? '群聊' : '私聊',
      群号: r.groupId || '',
      内容: r.line,
    })),
  }
}

/** 有哪些日期的聊天记录 */
export async function 聊天日期(rootDir, { chatType, groupId } = {}) {
  return 列出已有日期(rootDir, { chatType: chatType || undefined, groupId: groupId || undefined })
}

/** 按编号取详情 */
/**
 * 按编号取一张图的完整信息（含谁发的、昵称、引用次数）。
 * @param {string} rootDir
 * @param {number|string} no 图片编号
 * @returns {Promise<object|null>} 找不到返回 null
 */
export async function 取详情(rootDir, no) {
  const 库 = await 读描述库(rootDir)
  const e = Object.values(库.images).find((x) => x.no === Number(no))
  if (!e) return null
  const 人 = await 读人表(rootDir)
  const 首 = (e.refs && e.refs[0]) || {}
  const 谁 = 首.pid ? 人[首.pid] : null
  return {
    no: e.no,
    text: e.text,
    imageSha: e.imageSha || null,
    原图有没有: !!e.imageSha,  // text 模式下没有原图
    谁发的: 谁 ? { 编号: 首.pid, 昵称: 谁.nickname || '', 曾用名: 谁.曾用名 || [] } : null,
    什么时候: 首.time || e.firstSeen || null,
    被引用次数: Array.isArray(e.refs) ? e.refs.length : 0,
  }
}

/** 最近 N 张（按时间倒序） */
/**
 * 最近收到的图（按 lastSeen 倒序，不看编号）。
 * @returns {Promise<Array<{no, text, imageSha, lastSeen}>>}
 */
export async function 最近(rootDir, { limit = 10 } = {}) {
  const 库 = await 读描述库(rootDir)
  const all = Object.values(库.images)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))
  return all.map((e) => ({
    no: e.no,
    text: e.text,
    imageSha: e.imageSha || null,
    lastSeen: e.lastSeen || 0,
    // ⭐ 2026-11-02：带出 refs，工具层才能按群过滤（修串群）
    refs: Array.isArray(e.refs) ? e.refs : [],
  }))
}

/**
 * 把工具注册到宿主。
 * @param {(o:object)=>{}} defineTool  宿主提供的 defineTool
 * @param {object} ctx                 cordis ctx
 * @param {object} opts
 * @param {()=>string} opts.rootDir    库目录（惰性取，配置可能变）
 * @param {(m:string)=>void} [opts.log]
 */
/**
 * 把 6 个工具注册进宿主。**这是插件对模型暴露能力的唯一入口。**
 *
 * @param {object} opts
 * @param {Function} opts.defineTool  宿主的 defineTool（拿不到时传降级版，见 hostdep.mjs）
 * @param {object}   opts.ctx         cordis ctx（要能拿到 ctx.tools.register）
 * @param {()=>string} opts.rootDir   库目录，**惰性取**（配置可能中途变）
 * @param {(m:string)=>void} [opts.log]
 * @returns {string[]} 注册成功的工具名列表（失败的不会出现在里面）
 *
 * 每个工具的定义要点（踩过的坑，别改回去）：
 *   - parameters 用**属性映射**：{ key: { type:'string', required:true } }
 *     ❌ 不是 { type:'object', properties:{...} }
 *   - required 只能写在**属性上**（true），不能写在标量类型里（0.2.0 会拒）
 *   - output.render **必须返回数组**（用 包成文本块 包一层）
 *   - output.schema 根层要 type:'object'，属性上不要写 required
 */
/**
 * ⭐ 2026-11-02：从会话 ID 反查它属于哪个群。
 *
 * 为什么要这个：模型在群里搜图时不一定记得传 groupId，漏传就会串群
 * （实测她在 A 群搜到了 B 群的图）。与其在 prompt 里反复叮嘱，不如插件自己认。
 *
 * 数据来源：qq-bridge 的配置里有 会话 → 群号 的映射（绑定数组）。
 * 读不到就当没有（不报错），此时行为退回「不按群限制」。
 */
async function 会话对应的群(sessionId) {
  if (!sessionId) return null
  try {
    const fs = await import('node:fs/promises')
    const os = await import('node:os')
    const path = await import('node:path')
    const 家 = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const 配置路径 = path.join(家, 'qq-bridge-config.json')
    const 原文 = await fs.readFile(配置路径, 'utf8')
    const 配置 = JSON.parse(原文)
    const 绑定 = Array.isArray(配置?.绑定) ? 配置.绑定 : []
    const 命 = 绑定.find((b) => b && String(b.会话) === String(sessionId))
    if (!命) return null
    if (String(命.类型) !== '群') return null
    const 号 = String(命.号码 || '').trim()
    return 号 || null
  } catch {
    return null
  }
}

export function 注册AI工具({ defineTool, ctx, rootDir, diaryRootDir, 配置目录, 读设置, log }) {
  const 说 = typeof log === 'function' ? log : () => {}
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    说('ctx.tools 不可用，AI 工具未注册')
    return []
  }
  if (typeof defineTool !== 'function') {
    说('defineTool 不可用，AI 工具未注册')
    return []
  }
  const 根 = () => rootDir()
  // 配置目录：设置、缓存、分层库都放这儿。
  // 传入一般都有值（index.js 传的是 ~/.dsh/memory-vault），
  // 但测试里常常不传 —— 所以给个空串兜底，让依赖它的功能自然降级，
  // 而不是在工具执行时抛 ReferenceError（语法检查抓不到那种错）。
  const 配置根 = typeof 配置目录 === 'string' ? 配置目录 : ''
  // 读设置：settings.read() 的引用。不传就当作「没有设置」（全用默认），
  // 但传了不存在的方法时必须真的读到 —— 否则用户改了设置不生效，
  // 而且一点错都不报，这种静默失效最难查。
  const 取设置 = typeof 读设置 === 'function' ? 读设置 : null
  const 已注册 = []

  const 工具们 = [
    {
      name: 'memory_search',
      description:
        '在记忆仓库里按关键词搜图。库里的每张图都有一句文字描述（谁发的、什么时候、图里是什么），' +
        '这个工具就是搜那些描述。搜到了会给编号，用 memory_get 拿详情。' +
        '适合：用户问「上次那张猫的图」「我发过的那张服务器截图」。',
      parameters: {
        query: { type: 'string', required: true, description: '要搜的关键词，可以是好几个字，比如「橘猫」「云服务器截图」' },
        limit: { type: 'number', description: '最多返回几条，默认 10，最大 50' },
        groupId: {
          type: 'string',
          description: '【重要】只看某个群里发的图。你在群里回答时**必须传当前群号**，'
                       + '否则会搜到别的群的图，答非所问。私聊时不用传。',
        },
      },
      output: {
        // 宿主需要 render：返回内容块数组，不是裸字符串
        render: (args, value) => {
          if (!value) return 包成文本块('')
          const 行 = []
          if (typeof value.命中数 === 'number') 行.push(`命中 ${value.命中数} 张`)
          if (typeof value.条数 === 'number') 行.push(`共 ${value.条数} 张`)
          if (value.找到 === false) return 包成文本块('没找到这张图')
          if (typeof value.编号 === 'number') {
            行.push(`#${value.编号} ${value.描述 || ''}`)
            if (value.谁发的) 行.push(`  谁发的：${value.谁发的}`)
            if (value.什么时候) 行.push(`  什么时候：${value.什么时候}`)
            if (typeof value.被引用次数 === 'number') 行.push(`  被引用 ${value.被引用次数} 次`)
            行.push(`  有原图：${value.有原图 ? '是' : '否'}`)
            return 包成文本块(行.join('\n'))
          }
          if (Array.isArray(value.结果)) {
            for (const it of value.结果) 行.push(`#${it.编号} ${it.描述 || ''}`)
          }
          return 包成文本块(行.join('\n'))
        },
        schema: {
          type: 'object',
          properties: {
            命中数: { type: 'number', required: true },
            结果: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  编号: { type: 'number', required: true },
                  描述: { type: 'string', required: true },
                  相关度: { type: 'number', required: true },
                  有原图: { type: 'boolean', required: true },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      async execute({ query, limit, groupId }, exec) {
        // ⭐ 2026-11-02：模型没传 groupId 时，插件自己从会话反查当前群 ——
        //   不依赖 prompt 叮嘱，群里搜图就不会串到别的群。
        if (!groupId) {
          try {
            const 会话 = exec?.agent?.session?.id
            const 自动群 = await 会话对应的群(会话)
            if (自动群) {
              groupId = 自动群
              说(`memory_search 自动识别当前群 ${自动群}（会话 ${String(会话).slice(0, 16)}…）`)
            }
          } catch {}
        }
        const r = await 搜索(根(), query, { limit: Math.max(1, Math.min(Number(limit) || 10, 50)) })
        // ⭐ 2026-11-02：按群过滤。老数据没有 groupId，那种**保留**（宁可多给也别漏）。
        let 选中 = r
        let 过滤掉了 = 0
        if (groupId) {
          const g = String(groupId)
          选中 = r.filter((x) => {
            const refs = x.refs || []
            if (!refs.length) return true
            // 只要有一条引用来自这个群就算，或者有引用完全没记群号（老数据）
            const hitThis = refs.some((ref) => ref && ref.groupId != null && String(ref.groupId) === g)
            const legacy = refs.some((ref) => ref && ref.groupId == null)
            return hitThis || legacy
          })
          过滤掉了 = r.length - 选中.length
        }
        const 选中2 = 选中.slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)))
        说(`memory_search "${query}"${groupId ? ' 群' + groupId : ''} → ${选中2.length} 条`
          + (过滤掉了 ? `（滤掉别群 ${过滤掉了} 条）` : ''))
        return {
          命中数: 选中2.length,
          结果: 选中2.map((x) => ({ 编号: x.no, 描述: x.text, 相关度: x.score, 有原图: !!x.imageSha })),
        }
      },
    },
    {
      name: 'memory_get',
      description:
        '按编号拿一张图的完整信息：描述、谁发的、什么时候发的、有没有原图、被引用过几次。' +
        '编号来自 memory_search 或 memory_recent 的结果。',
      parameters: {
        no: { type: 'number', required: true, description: '图片编号，比如 7' },
      },
      output: {
        // 宿主需要 render：返回内容块数组，不是裸字符串
        render: (args, value) => {
          if (!value) return 包成文本块('')
          const 行 = []
          if (typeof value.命中数 === 'number') 行.push(`命中 ${value.命中数} 张`)
          if (typeof value.条数 === 'number') 行.push(`共 ${value.条数} 张`)
          if (value.找到 === false) return 包成文本块('没找到这张图')
          if (typeof value.编号 === 'number') {
            行.push(`#${value.编号} ${value.描述 || ''}`)
            if (value.谁发的) 行.push(`  谁发的：${value.谁发的}`)
            if (value.什么时候) 行.push(`  什么时候：${value.什么时候}`)
            if (typeof value.被引用次数 === 'number') 行.push(`  被引用 ${value.被引用次数} 次`)
            行.push(`  有原图：${value.有原图 ? '是' : '否'}`)
            return 包成文本块(行.join('\n'))
          }
          if (Array.isArray(value.结果)) {
            for (const it of value.结果) 行.push(`#${it.编号} ${it.描述 || ''}`)
          }
          return 包成文本块(行.join('\n'))
        },
        schema: {
          type: 'object',
          properties: {
            找到: { type: 'boolean', required: true },
            编号: { type: 'number' },
            描述: { type: 'string' },
            有原图: { type: 'boolean' },
            谁发的: { type: 'string' },
            什么时候: { type: 'string' },
            被引用次数: { type: 'number' },
          },
          additionalProperties: false,
        },
      },
      async execute({ no }) {
        const d = await 取详情(根(), no)
        if (!d) return { 找到: false }
        return {
          找到: true,
          编号: d.no,
          描述: d.text,
          有原图: d.原图有没有,
          谁发的: d.谁发的 ? `${d.谁发的.编号}（${d.谁发的.昵称}）` : '',
          什么时候: d.什么时候 ? new Date(d.什么时候).toISOString() : '',
          被引用次数: d.被引用次数,
        }
      },
    },
    {
      name: 'memory_recent',
      description: '列出记忆仓库里最近收到的图片，按时间倒序。不需要关键词，适合「最近发了什么图」这种问题。',
      parameters: {
        limit: { type: 'number', description: '最多几条，默认 10' },
      },
      output: {
        // 宿主需要 render：返回内容块数组，不是裸字符串
        render: (args, value) => {
          if (!value) return 包成文本块('')
          const 行 = []
          if (typeof value.命中数 === 'number') 行.push(`命中 ${value.命中数} 张`)
          if (typeof value.条数 === 'number') 行.push(`共 ${value.条数} 张`)
          if (value.找到 === false) return 包成文本块('没找到这张图')
          if (typeof value.编号 === 'number') {
            行.push(`#${value.编号} ${value.描述 || ''}`)
            if (value.谁发的) 行.push(`  谁发的：${value.谁发的}`)
            if (value.什么时候) 行.push(`  什么时候：${value.什么时候}`)
            if (typeof value.被引用次数 === 'number') 行.push(`  被引用 ${value.被引用次数} 次`)
            行.push(`  有原图：${value.有原图 ? '是' : '否'}`)
            return 包成文本块(行.join('\n'))
          }
          if (Array.isArray(value.结果)) {
            for (const it of value.结果) 行.push(`#${it.编号} ${it.描述 || ''}`)
          }
          return 包成文本块(行.join('\n'))
        },
        schema: {
          type: 'object',
          properties: {
            条数: { type: 'number', required: true },
            结果: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  编号: { type: 'number', required: true },
                  描述: { type: 'string', required: true },
                  有原图: { type: 'boolean', required: true },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      async execute({ limit }, exec) {
        const 上限 = Math.max(1, Math.min(Number(limit) || 10, 50))
        // 多取一些，过滤后再截断 —— 否则滤掉别群的以后可能不够数
        const r = await 最近(根(), { limit: Math.min(50, 上限 * 3) })
        // ⭐ 2026-11-02：插件自己认出当前群，只看本群的图（不依赖 prompt 叮嘱）。
        //   实测她在主群用 memory_recent 拿到了唐门群的图，就是因为这里没有群的概念。
        let 群号 = null
        try {
          群号 = await 会话对应的群(exec?.agent?.session?.id)
        } catch {}
        let 选中 = r
        if (群号) {
          const g = String(群号)
          选中 = r.filter((x) => {
            const refs = x.refs || []
            if (!refs.length) return true        // 老数据没 refs，保留
            const hitThis = refs.some((ref) => ref && ref.groupId != null && String(ref.groupId) === g)
            const legacy = refs.some((ref) => ref && ref.groupId == null)
            return hitThis || legacy
          })
          说(`memory_recent 只列群 ${群号} 的图（滤掉别群 ${r.length - 选中.length} 张）`)
        }
        const 选中2 = 选中.slice(0, 上限)
        return {
          条数: 选中2.length,
          结果: 选中2.map((x) => ({ 编号: x.no, 描述: x.text, 有原图: !!x.imageSha })),
        }
      },
    },
    {
      name: 'chat_search',
      description:
        '在聊天记录里搜关键词。聊天记录按天存成纯文本，私聊和群聊分开。' +
        '适合：用户问「我什么时候说过XX」「群里谁提过YY」。' +
        '命中会给日期、是私聊还是群聊、以及那一整行原文。' +
        '可以按人过滤（person），每个 QQ 号分开算。',
      parameters: {
        query: { type: 'string', required: true, description: '要搜的关键词，比如「天气」「大肥鱼」' },
        chatType: { type: 'string', description: '限定类型：private 只搜私聊，group 只搜群聊。不填就都搜' },
        groupId: { type: 'string', description: '限定某个群号，只对群聊有意义' },
        person: { type: 'string', description: '只搜某个人的发言。填编号（如 p1）或 QQ 号。同一个人有多个号时各自独立' },
        limit: { type: 'number', description: '最多返回几条，默认 20，最大 100' },
      },
      output: {
        render: (args, value) => {
          if (!value || !value.命中数) return 包成文本块('没搜到')
          const 行 = [`命中 ${value.命中数} 条`]
          for (const it of value.结果) {
            行.push(`[${it.日期}] ${it.类型}${it.群号 ? '(' + it.群号 + ')' : ''} ${it.内容}`)
          }
          return 包成文本块(行.join('\n'))
        },
        schema: {
          type: 'object',
          properties: {
            命中数: { type: 'number' },
            结果: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  日期: { type: 'string' },
                  类型: { type: 'string' },
                  群号: { type: 'string' },
                  内容: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      async execute({ query, chatType, groupId, person, limit }) {
        const r = await 搜聊天(根(), query, { chatType, groupId, person, limit })
        说(`chat_search "${query}" → ${r.命中数} 条`)
        return r
      },
    },
    {
      name: 'person_list',
      description:
        '列出记忆里记录过的所有人（每个 QQ 号单独一条，同一个人的多个号不会合并）。' +
        '返回编号、QQ 号、昵称。想知道「有哪些人」或某个编号对应谁时用。',
      parameters: {},
      output: {
        render: (args, value) => {
          if (!value || !value.人数) return 包成文本块('还没有记录任何人')
          const 行 = [`共 ${value.人数} 个号`]
          for (const it of value.列表) 行.push(`${it.编号} ${it.昵称 || '(无名)'} QQ=${it.QQ号}`)
          return 包成文本块(行.join('\n'))
        },
        schema: {
          type: 'object',
          properties: {
            人数: { type: 'number' },
            列表: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  编号: { type: 'string' },
                  QQ号: { type: 'string' },
                  昵称: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
      async execute() {
        const { 列出人 } = await import('./people.js')
        const all = await 列出人(根())
        return {
          人数: all.length,
          列表: all.map((p) => ({ 编号: p.pid, QQ号: String(p.qq ?? ''), 昵称: String(p.nickname ?? '') })),
        }
      },
    },
    {
      name: 'import_memories',
      description:
        '把别的记忆插件导出的记忆文件导入本仓库。支持 claude-mem 的导出 JSON 格式' +
        '（含 exportedAt 和 observations 字段）。同一个来源的同一条内容不会重复导入。',
      parameters: {
        path: { type: 'string', required: true, description: '导出文件的绝对路径' },
        source: { type: 'string', description: '来源标记，比如 claude-mem。默认用文件名' },
      },
      output: {
        render: (args, value) => {
          if (!value || value.ok === false) return 包成文本块('导入失败：' + ((value && value.error) || '未知原因'))
          return 包成文本块(`导入完成：识别为 ${value.识别格式}，共 ${value.转换条数} 条，新增 ${value.新增}，跳过 ${value.跳过}`)
        },
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            识别格式: { type: 'string' },
            转换条数: { type: 'number' },
            新增: { type: 'number' },
            跳过: { type: 'number' },
            error: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      async execute({ path, source }) {
        const fs = await import('node:fs/promises')
        const a = await import('./adapters.js')
        const p = String(path || '').trim()
        if (!p) return { ok: false, error: 'path 不能为空' }
        let data
        try {
          data = JSON.parse(await fs.readFile(p, 'utf8'))
        } catch (e) {
          return { ok: false, error: '读不了这个文件：' + (e?.message || e) }
        }
        const src = String(source || '').trim() || (p.split('/').pop() || 'unknown').replace(/\.json$/i, '')
        const r = await a.导入外部记忆(根(), data, { source: src })
        if (r && r.ok) 说(`导入 ${src}：新增 ${r.新增}，跳过 ${r.跳过}`)
        return r
      },
    },
    // ── 记忆检索（2026-11-03 并入）──────────────────────────────────
    // 与 memory_search 的分工：
    //   memory_search —— 搜图片描述，纯关键词；
    //   memory_recall —— 跨来源检索日记重点（四因子打分），置信度低时
    //                    自动下钻到本插件的聊天原文。日记库没配就自动
    //                    退回只搜聊天。
    // 为什么放在本插件里而不是独立插件：它读的数据一半来自记忆仓库
    // 自己，独立装一个只为读同一个库，等于把一份数据挂到两个插件上。
    {
      name: 'memory_recall',
      description:
        '检索记忆里的重点：先查日记索引（关键词 + 语义向量 + 时间衰减 + 重要度四路打分），' +
        '置信度不够时自动下钻到本记忆仓库，把当时的原始聊天捞出来。' +
        '适合「我以前怎么说的」「这事当时怎么定的」「关于 X 我记过什么」这类翻旧账的问题。' +
        '日记条目本身是筛过的重点，所以它是主入口；群聊里的话未必是本人说的，' +
        '所以来源默认只搜私聊，要搜全部必须显式传 "*"。',
      parameters: {
        query: { type: 'string', description: '要问什么，自然语言即可，会自动切词' },
        来源: { type: 'string', description: 'private（默认）/ 群号 / group:<群号> / "*"（全部来源）' },
        limit: { type: 'number', description: '最多返回几条，默认 8，最大 30' },
        深度: { type: 'string', description: 'auto（默认，按置信度自动决定是否下钻）/ off（只查索引库，快）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            找到: { type: 'boolean' },
            命中数: { type: 'number' },
            下钻过: { type: 'boolean', description: '是否去记忆仓库捞了原文' },
            下钻原因: { type: 'string' },
            原文数: { type: 'number', description: '下钻拿到的原始聊天条数' },
          },
          additionalProperties: false,
        },
        render: (v) => 包成文本块(v && v.text ? v.text : ''),
      },
      async execute(args) {
        const { 跑检索 } = await import('./recall-tools.js')
        // 分层库和设置、缓存放在一起（配置目录），跟着这台机器的数据走
        const { join } = await import('node:path')
        return 跑检索({
          args,
          日记根: typeof diaryRootDir === 'function' ? diaryRootDir() : '',
          仓库根: 根(),
          分层库文件: 配置根 ? join(配置根, 'chat-levels.json') : '',
          说,
        })
      },
    },
    // ── 记忆覆盖率检查 ──────────────────────────────────────────────
    // 拿本插件的原始聊天和日记库对账，找出「聊得多但从没记过」的话题。
    // 只读不写。
    {
      name: 'memory_coverage',
      description:
        '记忆覆盖率检查：找出「聊天里反复讨论、但日记里从没记过」的话题。' +
        '用来发现漏记 —— 问「最近有什么该记没记的」「记忆全不全」时用它。' +
        '只读不写。判定经过四层过滤：最长匹配切词挡碎片、通用词频门槛挡虚词、' +
        '至少多人说过（挡口癖）、最后用日记全文对照。没配日记库时不可用。',
      parameters: {
        来源: { type: 'string', description: '只检查某个来源（private / 群号）；不传检查全部' },
        最少消息: { type: 'number', description: '至少被多少条消息提到；不传按数据量自动定' },
        上限: { type: 'number', description: '最多返回多少个话题，默认 20，最大 100' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            聊天行数: { type: 'number' },
            日记条数: { type: 'number' },
            漏记数: { type: 'number' },
          },
          additionalProperties: false,
        },
        render: (v) => 包成文本块(v && v.text ? v.text : ''),
      },
      async execute(args) {
        const { 跑覆盖率 } = await import('./recall-tools.js')
        return 跑覆盖率({
          args,
          日记根: typeof diaryRootDir === 'function' ? diaryRootDir() : '',
          仓库根: 根(),
          说,
        })
      },
    },
    // ── 聊天分层（把聊天并入检索库）──────────────────────────────
    // 手动触发版：定时器默认关，这是主要入口。
    // 用规则筛选（零依赖）打底，配了模型才额外用模型打分。
    {
      name: 'memory_score_chats',
      description:
        '把记忆仓库里的聊天记录分层后并入检索库，让 memory_recall 能搜到聊天原文。' +
        '**没有配置大模型时，默认由内置脚本（规则）打分，不需要任何 API、零成本**；' +
        '配了模型可以改用模型打分，准确度更高。' +
        '分三层：核心（约定/决定/具体配置）、有用（讨论过程）、闲聊（应答玩笑）。' +
        '只读聊天、只写分层结果文件，不改任何原始聊天。增量：处理过的不会重复处理。',
      parameters: {
        用模型: { type: 'boolean', description: '是否用大模型打分；不传用设置里的开关。没配模型会自动退回脚本打分' },
        最低档次: { type: 'number', description: '并入哪一档以上：0=全部 1=有用起 2=只核心；不传用设置值' },
        上限: { type: 'number', description: '本次最多处理多少条（试小批用）；不传用设置里的单次上限' },
        只打最近天数: { type: 'number', description: '只打最近 N 天内的消息；不传用设置值，0=不限' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            消息总数: { type: 'number' },
            并入条数: { type: 'number' },
            用时秒: { type: 'number' },
            打分方式: { type: 'string', description: '脚本 或 模型' },
          },
          additionalProperties: false,
        },
        render: (v) => 包成文本块(v && v.text ? v.text : ''),
      },
      async execute(args) {
        const { 跑分层 } = await import('./recall-ingest.js')
        const { 取模型配置 } = await import('./recall-tools.js')
        const path = await import('node:path')
        const 开始时 = Date.now()

        // 读设置：工具参数优先，没传的回落到设置
        let 设置 = {}
        try {
          if (取设置) 设置 = (await 取设置()) || {}
        } catch { /* 读不到设置就全用默认 */ }

        const 要模型 = args.用模型 === true ? true : (args.用模型 === false ? false : 设置.用模型打分 === true)
        const 模型配置 = 要模型 ? await 取模型配置(配置根, 设置) : null
        if (要模型 && !模型配置) 说('要模型但没配好模型，本次自动退回脚本打分')

        const 档次参 = Number.isFinite(Number(args.最低档次)) ? Number(args.最低档次) : Number(设置.分层最低档次)
        const 用档次 = Number.isFinite(档次参) ? 档次参 : 0
        const 上限参 = Number.isFinite(Number(args.上限)) ? Number(args.上限) : (Number(设置.单次最多条数) || 0)
        const 天数参 = Number.isFinite(Number(args.只打最近天数))
          ? Number(args.只打最近天数)
          : (Number(设置.只打最近天数) || 0)

        const r = await 跑分层({
          仓库根: 根(),
          输出文件: path.join(配置根 || '.', 'chat-levels.json'),
          用模型: !!模型配置,
          模型配置,
          最低档次: 用档次,
          规则配置: 设置,
          只打最近天数: 天数参,
          最多条数: 上限参,
          日志: (m) => 说('[分层] ' + m),
        })
        const 用时秒 = ((Date.now() - 开始时) / 1000).toFixed(1)
        const 打分方式 = 模型配置 ? '模型' : '脚本'
        if (!r.ok) {
          return { ok: false, 消息总数: 0, 并入条数: 0, 用时秒: Number(用时秒), 打分方式, text: `分层失败：${r.错误}` }
        }
        const 统计 = r.统计 || {}
        const 段 = [
          `聊天分层完成（用时 ${用时秒} 秒，打分方式：${打分方式}）`,
          `扫到 ${r.消息总数} 条消息`,
          `规则分布：核心 ${r.规则分布.核心} / 有用 ${r.规则分布.有用} / 闲聊 ${r.规则分布.闲聊} / 播报 ${r.规则分布.播报}`,
          `使用规则预设：${统计.规则预设 || 设置.规则预设 || '技术向'}（有用阈值 ${统计.有用阈值} / 核心阈值 ${统计.核心阈值}）`,
        ]
        if (模型配置) {
          const m = r.模型 || {}
          段.push(`模型打分：处理 ${m.处理数} 条，跳过已处理 ${m.跳过数} 条，范围外 ${m.范围外 || 0} 条，超出上限 ${m.被截断 || 0} 条，失败 ${m.失败批} 批`)
        } else {
          段.push('模型打分：未启用 —— 本次由内置脚本打分（零成本、无需 API）')
        }
        段.push(`并入检索库 ${r.并入条数} 条`)
        段.push('')
        段.push('现在 memory_recall 就能搜到这些聊天了。日记仍然排在聊天前面。')

        return { ok: true, 消息总数: r.消息总数, 并入条数: r.并入条数, 用时秒: Number(用时秒), 打分方式, text: 段.join('\n') }
      },
    },
  ]

  for (const t of 工具们) {
    try {
      ctx.tools.register(defineTool(t))
      已注册.push(t.name)
      说('AI 工具已注册 ' + t.name)
    } catch (e) {
      说(`AI 工具注册失败 ${t.name}: ${e?.message || e}`)
    }
  }
  return 已注册
}
