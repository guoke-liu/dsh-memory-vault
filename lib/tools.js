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
        起: { type: 'string', description: '只看这个日期之后：2026-11-03。配合「止」限定范围，比如「昨天」就传昨天的日期' },
        止: { type: 'string', description: '只看这个日期之前：2026-11-03（含当天）' },
        按时间: { type: 'boolean', description: '按时间倒序返回，不看相关度。问「最后一句是什么」「最近说了什么」时用这个' },
        人: { type: 'string', description: '只看这个人的：填昵称（如「小鱼儿」）。按人检索事件，或配合「按时间」查某人最后一句' },
        只看未解决: { type: 'boolean', description: '按结果检索：只要那些没有明确结论、还没解决的事' },
        只看遗忘层: { type: 'boolean', description: '看「快被忘掉」的事件（满 12 层没人提起）。看到后可以用 memory_forget_events 救回来或彻底删掉' },
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
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
      },
      async execute(args) {
        const { 跑检索 } = await import('./recall-tools.js')
        // 分层库和设置、缓存放在一起（配置目录），跟着这台机器的数据走
        const { join } = await import('node:path')

        // ⚠️ 开关必须在这里生效，不能只在定时器里判断。
        //
        // 踩过的同类问题（README「坑 2」）：设置页的「启用群聊」名字和行为
        // 对不上 —— 关着也照样拉，开着也不会开始拉，因为真正决定行为的
        // 是别的字段。这里不能重犯：用户关掉「启用聊天分层」，就该真的
        // 只搜日记，不该继续把聊天卷进结果里。
        //
        // 读不到设置时按「关」处理，与默认值一致。
        let 设置 = {}
        try {
          if (取设置) 设置 = (await 取设置()) || {}
        } catch { /* 读不到就当没开 */ }
        const 分层开 = 设置.启用聊天分层 === true

        return 跑检索({
          args,
          日记根: typeof diaryRootDir === 'function' ? diaryRootDir() : '',
          仓库根: 根(),
          分层库文件: 分层开 && 配置根 ? join(配置根, 'chat-levels.json') : '',
          导入目录: 配置根 ? join(配置根, 'imported') : '',
          // 事件库：和分层库放同一个目录，跟着这台机器的数据走。
          // 有没有事件层不影响检索 —— 没有就退回原来的分层检索。
          // ⚠️ 事件库路径不能挂在「启用聊天分层」开关上。
          //
          // 事件来源有两种：群聊话题（依赖分层）和日记（不依赖分层）。
          // 挂在分层开关上的话，用户关掉聊天分层，连日记事件也搜不到了 ——
          // 实测踩过：测试里开关默认关着，看遗忘层时报「聊天里也没搜到」，
          // 其实事件库好好的，只是路径被传成了空串。
          // 事件库存在就传，开关只影响「分层」这条来源。
          事件库文件: 配置根 ? join(配置根, 'events.json') : '',
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
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
      },
      async execute(args) {
        const { 跑覆盖率 } = await import('./recall-tools.js')
        const { join } = await import('node:path')
        return 跑覆盖率({
          args,
          日记根: typeof diaryRootDir === 'function' ? diaryRootDir() : '',
          仓库根: 根(),
          导入目录: 配置根 ? join(配置根, 'imported') : '',
          说,
        })
      },
    },
    // ── 导入外部日记 ──────────────────────────────────────────────
    // 让别人把任意格式的日记导进来，memory_recall 才能用上。
    // 字段映射预设照 GitHub 上真实在用的转换器抄的字段名，不是猜的。
    {
      name: 'memory_import_diary',
      description:
        '把外部日记导入成本插件能检索的格式。支持 Day One JSON、通用 JSON、JSONL、' +
        'Markdown/纯文本日记。**导入是幂等的**：同样的内容导两次不会重复。' +
        '只写本插件自己的导入目录，不动任何原始文件。',
      parameters: {
        文件: { type: 'string', required: true, description: '要导入的文件路径' },
        格式预设: { type: 'string', description: 'dayone / notion / generic / obsidian；不填自动探测' },
        字段映射: { type: 'string', description: 'JSON 字符串，例如 {"text":"content","date":"day"}；用于预设覆盖不了的情况' },
        来源: { type: 'string', description: '导入后归到哪个来源，默认 imported' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            形状: { type: 'string' },
            解析条数: { type: 'number' },
            新增: { type: 'number' },
            跳过: { type: 'number' },
          },
          additionalProperties: false,
        },
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
      },
      async execute(args) {
        const { 导入, 取映射, 内置映射 } = await import('./recall-import.js')
        const path = await import('node:path')

        let 映射 = 取映射(args.格式预设)
        if (args.字段映射) {
          try {
            const 自定义 = JSON.parse(String(args.字段映射))
            if (自定义 && typeof 自定义 === 'object') 映射 = { ...映射, ...自定义 }
          } catch (e) {
            return { ok: false, 形状: '', 解析条数: 0, 新增: 0, 跳过: 0, text: `字段映射不是合法 JSON：${e?.message || e}` }
          }
        }

        const r = await 导入({
          源文件: String(args.文件 || ''),
          目标目录: path.join(配置根 || '.', 'imported'),
          映射,
          默认来源: String(args.来源 || 'imported'),
        })
        if (!r.ok) {
          const 提示 = ['可用预设：' + Object.keys(内置映射).join(' / ')]
          if (String(r.错误).includes('字段映射')) {
            提示.push('示例：{"text":"content","date":"created_at","tags":"labels"}')
          }
          return { ok: false, 形状: r.形状 || '', 解析条数: 0, 新增: 0, 跳过: 0, text: `${r.错误}\n${提示.join('\n')}` }
        }
        return {
          ok: true,
          形状: r.形状,
          解析条数: r.解析条数,
          新增: r.新增,
          跳过: r.跳过,
          text: [
            `导入完成（识别为 ${r.形状} 格式）`,
            `解析 ${r.解析条数} 条 → 新增 ${r.新增}，跳过已存在 ${r.跳过}`,
            `来源：${(r.来源们 || []).join(', ')}`,
            `目标目录：${r.目标目录}`,
            '',
            r.新增 > 0
              ? '这些条目现在能被 memory_recall 检索到了。'
              : '没有新增（全部是已导入过的内容）。',
          ].join('\n'),
        }
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
        重新投喂: {
          type: 'string',
          description: '对某天的结果不满意时，让那一天重新送模型：'
            + '2026-11-03（单日）或 2026-11-01..2026-11-03（区间）。'
            + '会先扣掉这些消息在账本里的记录再正常跑 —— 重喂成功的会重新记账，失败的不记。'
            + '只影响当前档位，别的档位不动。',
        },
        只预览: {
          type: 'boolean',
          description: '配合「重新投喂」用：只算要重喂多少条、其中多少条已记过账，不真跑模型、不花钱。'
            + '先预览看清楚再真正重喂，建议养成习惯。',
        },
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
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
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
        // ⚠️ 用户明确要求「重新投喂某天」，但没配模型 —— 必须直接拒绝。
        //
        // 实测踩过（2026-11-04）：只预览时传了 重新投喂 但没配模型，
        // 代码照常跑了规则分层，一声不响地写了一遍库。
        // 用户以为「重喂了某天」，实际什么都没重喂；更糟的是它改动了真实数据，
        // 而用户完全不知道自己点的那个功能没生效。
        //
        // 宁可报错让用户知道要先去配模型，也不能假装成功。
        if (args.重新投喂 && !模型配置) {
          return {
            ok: false,
            消息总数: 0,
            并入条数: 0,
            用时秒: 0,
            打分方式: '脚本',
            text: [
              '重新投喂需要大模型 —— 但当前没有配置模型。',
              '「重新投喂」的含义是「把这一天再送给大模型算一遍」，没有模型就没有可投喂的对象。',
              '内置规则打分是确定性的：同一批聊天每次打出来的分完全一样，重跑没有任何意义。',
              '',
              '要配模型：设置页「模型打分」一栏填接口地址、密钥、模型名。',
              '不想配模型也可以：「并入哪一档」那个设置随时能调，改完直接重跑就能生效。',
            ].join('\n'),
          }
        }
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
          // 投喂档位：决定账本按哪个桶记账。
          // 用户改了档位就该重新喂一遍 —— 不同档位送进模型的内容不一样，
          // 「全量喂过」不能推出「核心档也喂过」。
          投喂档位: 设置.事件提炼档位,
          // 重新投喂：指定日期（单日或区间）。不传就是正常的增量投喂。
          重新投喂: args.重新投喂,
          // 只预览：算账不花钱，给用户看清楚再决定
          只预览: args.只预览 === true,
          只打最近天数: 天数参,
          最多条数: 上限参,
          日志: (m) => 说('[分层] ' + m),
        })
        const 用时秒 = ((Date.now() - 开始时) / 1000).toFixed(1)
        const 打分方式 = 模型配置 ? '模型' : '脚本'
        if (!r.ok) {
          return { ok: false, 消息总数: 0, 并入条数: 0, 用时秒: Number(用时秒), 打分方式, text: `分层失败：${r.错误}` }
        }
        // 只预览：报清楚会重喂多少、其中多少真会花钱，然后停。
        // 不花钱就能看到代价，用户才敢用这个功能。
        if (r.预览) {
          const p = r.重新投喂 || {}
          const 行 = [
            `重新投喂预览：${p.起}${p.起 !== p.止 ? ' ~ ' + p.止 : ''}`,
            `范围内 ${p.日期数} 天、${p.消息数} 条消息`,
            `其中在「${r.模型?.投喂档位 || 设置.事件提炼档位 || 'screened'}」档位下已记过账的 ${p.可扣账} 条`,
            '',
            p.可扣账 > 0
              ? `真正执行时会扣掉这 ${p.可扣账} 条记录，再按当前规则重新送模型 —— 也就是会重花这部分 token。`
              : '这些消息都还没喂过模型，重喂不会额外花钱（第一次本就该喂）。',
            '确认要重喂，去掉「只预览」再调一次即可。',
          ]
          return { ok: true, 消息总数: r.消息总数, 并入条数: 0, 用时秒: Number(用时秒), 打分方式, text: 行.join('\n') }
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
          段.push(`模型打分：处理 ${m.处理数} 条，跳过已投喂 ${m.跳过数} 条（档位 ${m.投喂档位 || 'screened'}），范围外 ${m.范围外 || 0} 条，超出上限 ${m.被截断 || 0} 条，失败 ${m.失败批} 批`)
          // 「跳过」只说明这次没花钱，用户真正想知道的是「总共喂过多少」——
          // 那才是账单的依据。账本统计放在这里，一眼能看到累计。
          const 投喂 = r.统计 && r.统计.投喂
          if (投喂 && 投喂.按档位) {
            const 各档 = ['full', 'screened', 'core']
              .map((d) => `${d} ${投喂.按档位[d] || 0}`)
              .join(' / ')
            段.push(`投喂账本累计：${投喂.合计} 条（${各档}）—— 喂过的不会重复送模型`)
          }
        } else {
          段.push('模型打分：未启用 —— 本次由内置脚本打分（零成本、无需 API）')
        }
        // 重喂说明放在并入数量之前：用户改的是「那一天」，要先看到那天的结果
        if (r.模型 && r.模型.重新投喂) {
          const q = r.模型.重新投喂
          段.push(`重新投喂：${q.起}${q.起 !== q.止 ? ' ~ ' + q.止 : ''}`
            + `（${q.日期数} 天 / ${q.消息数} 条，扣掉 ${q.扣掉} 条旧记账后重跑）`)
        }
        段.push(`并入检索库 ${r.并入条数} 条`)
        // 容量提示：库被裁剪过必须明说，否则用户会以为「我说的话怎么搜不到了」，
        // 然后怀疑检索坏了，而不是知道这是容量上限在起作用。
        if (r.本次淘汰 > 0) {
          段.push(`⚠️ 超出容量上限 ${r.容量上限} 条，本次淘汰 ${r.本次淘汰} 条最不要紧的（优先丢闲聊、久远的）`)
        } else if (Number(r.容量上限) > 0 && r.并入条数 > Number(r.容量上限) * 0.8) {
          段.push(`容量：${r.并入条数} / ${r.容量上限} 条，接近上限了`)
        }
        段.push('')
        段.push('现在 memory_recall 就能搜到这些聊天了。日记仍然排在聊天前面。')

        return { ok: true, 消息总数: r.消息总数, 并入条数: r.并入条数, 用时秒: Number(用时秒), 打分方式, text: 段.join('\n') }
      },
    },

    // ── 事件提炼（把聊天变成「一件事」）──────────────────────────
    //
    // 和分层不同：分层留的是「一条消息」，事件留的是「一件事」。
    // 事件优先用鱼写的日记（质量最好），日记没覆盖的日子才用规则从聊天里切。
    {
      name: 'memory_build_events',
      description:
        '把聊天记录提炼成「事件」：多少条消息组成一件事、怎么引起的、发生了什么、结果是什么。' +
        '优先读日记（鱼自己写的事，质量最好）；日记没覆盖的日子用内置规则从聊天里切，' +
        '**不需要大模型**。' +
        '私聊按时间切段（一件事一件事聊）；群聊按话题聚（群里多个事件交叉，切不干净）。' +
        '只读聊天和日记、只写自己的事件库，不改任何原始数据。',
      parameters: {
        上限: { type: 'number', description: '最多处理多少条聊天，试小批用；不传处理全部' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            事件数: { type: 'number' },
            日记事件: { type: 'number' },
            规则事件: { type: 'number' },
          },
          additionalProperties: false,
        },
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
      },
      async execute(args) {
        const { 跑事件提炼 } = await import('./recall-events-store.js')
        const { join } = await import('node:path')
        let 设置 = {}
        try {
          if (取设置) 设置 = (await 取设置()) || {}
        } catch { /* 读不到就用默认 */ }

        // ⚠️ 顺序写死：必须先分层、再提炼事件。
        //
        // 主人 2026-11-04：「开源的话直接写死不能乱动」。
        //
        // 为什么不给「自动先跑分层」这种便利：分层会用模型打分（要钱），
        // 而提炼事件时用户可能只想更新事件、不想重新分层。
        // 自动帮他跑等于替他花钱。写死顺序 + 明确提示，用户自己决定。
        let 分层库 = null
        try {
          const { readFileSync } = await import('node:fs')
          分层库 = JSON.parse(readFileSync(join(配置根 || '.', 'chat-levels.json'), 'utf8'))
        } catch {
          return {
            ok: false, 事件数: 0, 日记事件: 0, 规则事件: 0,
            text: [
              '顺序错了：还没有分层库，没法提炼事件。',
              '',
              '正确顺序（不能跳步）：',
              '  1. memory_score_chats   把聊天分层并存进分层库',
              '  2. memory_build_events  从分层库提炼事件',
              '',
              '为什么必须先分层：事件是按「来源 + 日期」组织的，而这个分组来自分层库。',
              '没有分层库就不知道有哪些天的聊天可以提炼。',
              '（不会自动帮你跑分层 —— 那可能花模型的钱，该由你决定。）',
            ].join('\n'),
          }
        }
        // 分层库存在但没有任何分组 = 分层跑过但没扫到聊天，也是顺序问题
        if (!Array.isArray(分层库.分组) || 分层库.分组.length === 0) {
          return {
            ok: false, 事件数: 0, 日记事件: 0, 规则事件: 0,
            text: [
              '顺序错了：分层库里没有任何聊天分组。',
              '',
              '先跑 memory_score_chats 把聊天分好层（确认「启用聊天分层」是开着的），',
              '再回来跑这个工具。',
            ].join('\n'),
          }
        }

        // 模型配置：配了就交给模型判断「值不值得记」，没配就纯规则。
        // 这是主人 2026-11-04 的要求：「交给大模型分辨有没有重点要记的东西，
        // 纯闲聊的话不要记」。没配模型时整个判断步骤跳过，行为与之前一致。
        let 模型配置 = null
        try {
          const { 取模型配置 } = await import('./recall-tools.js')
          模型配置 = await 取模型配置(配置根, 设置)
        } catch { /* 取不到就当没配 */ }
        const 用模型 = !!(模型配置 && 模型配置.apiKey && 模型配置.baseURL && 模型配置.model)

        const r = await 跑事件提炼({
          仓库根: 根(),
          日记根: typeof diaryRootDir === 'function' ? diaryRootDir() : '',
          读分层库: async () => 分层库,
          输出文件: join(配置根 || '.', 'events.json'),
          模型配置: 用模型 ? 模型配置 : null,
          日志: (m) => 说('[事件] ' + m),
        })
        if (!r.ok) {
          return { ok: false, 事件数: 0, 日记事件: 0, 规则事件: 0, text: `事件提炼失败：${r.错误}` }
        }

        const 统 = r.统计 || {}
        const 行 = [
          '事件提炼完成',
          `共 ${统.合计} 条事件：日记 ${统.日记} 条、群聊话题 ${(r.事件们 || []).filter((e) => e.提炼方式 === '话题').length} 条、规则提炼 ${统.规则} 条`,
        ]
        if (统.模型判断) {
          const m = 统.模型判断
          行.push(`模型判断：送 ${m.送模型} 段，其中 ${m.模型判闲聊} 段被判为纯闲聊、已丢弃（没有模型时不丢任何段）`)
        } else {
          行.push('模型判断：未配置模型 —— 本次用规则判断，不额外花钱')
        }
        行.push(
          `覆盖 ${统.有日记的天 + 统.用规则的天} 个「来源+日期」：其中 ${统.有日记的天} 天直接用了日记`,
          '',
          '日记优先的理由：日记是鱼自己写的事，比规则从聊天里拼出来的完整得多。',
          '规则只在日记没覆盖的日子兜底。',
          '',
          '现在 memory_recall 能按事件检索了，还能按人（人）、按结果（只看未解决）查。',
        )
        return {
          ok: true,
          事件数: 统.合计 || 0,
          日记事件: 统.日记 || 0,
          规则事件: 统.规则 || 0,
          text: 行.join('\n'),
        }
      },
    },

    // ── 群友印象分 ───────────────────────────────────────────────
    //
    // 主人 2026-11-04：「根据艾特的内容增加一个群友印象分」，
    // 「太好的太坏的都会影响优先级」。
    //
    // 只统计「@ 了鱼」的消息，且只认明确的好话坏话（不认反讽），
    // 好话坏话都往上抬 —— 详见 lib/recall-impression.js 的说明。
    {
      name: 'memory_impressions',
      description:
        '看群里谁对鱼说过明确的好话或坏话（@ 鱼时说的）。' +
        '**只认明确信号**：「宝宝真乖」「谢谢」算好话，「滚」「傻逼」算坏话；' +
        '「大聪明」这种可能是反讽的一律不算。' +
        '好话坏话都计分 —— 这是「跟鱼的互动强度」，不是好感度排名。' +
        '只读不写。',
      parameters: {
        人: { type: 'string', description: '只看某个人的印象（填昵称）；不传看全部' },
        上限: { type: 'number', description: '最多返回几个人，默认 20' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            人数: { type: 'number' },
            艾特总数: { type: 'number' },
          },
          additionalProperties: false,
        },
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
      },
      async execute(args) {
        const { 算印象分 } = await import('./recall-impression.js')
        const { readFileSync, readdirSync, existsSync } = await import('node:fs')
        const { join } = await import('node:path')

        const 上限 = Math.max(1, Math.min(Number(args.上限) || 20, 100))

        // 从分层库读聊天消息（那里有摘要和昵称，不用去翻原始文件）
        let 分层库 = null
        try {
          分层库 = JSON.parse(readFileSync(join(配置根 || '.', 'chat-levels.json'), 'utf8'))
        } catch {
          return { ok: false, 人数: 0, 艾特总数: 0, text: '还没有分层库。先调 memory_score_chats 把聊天分层。' }
        }

        // 分层库只存摘要，@ 可能被截断 —— 所以去原始聊天文件里找。
        // 这是少数需要读原文的场景：判断「有没有 @ 鱼」看摘要不可靠。
        const 仓库根 = 根()
        const 消息们 = []
        const 读一天 = (来源, 日期) => {
          const 目录 = String(来源).startsWith('group:')
            ? join(仓库根, 'chat', 'group', String(来源).slice(6))
            : join(仓库根, 'chat', 'private')
          const f = join(目录, `${日期}.txt`)
          if (!existsSync(f)) return
          const LINE = /^\[(\d{2}:\d{2}:\d{2})\]\s+([^(]+)\((p\d+)\):\s*(.*)$/
          for (const 行 of readFileSync(f, 'utf8').split('\n')) {
            const m = 行.replace(/\r$/, '').match(LINE)
            if (!m) continue
            消息们.push({ 时间: m[1], 昵称: m[2].trim(), pid: m[3], 内容: m[4], 日期, 来源 })
          }
        }
        for (const g of (Array.isArray(分层库.分组) ? 分层库.分组 : [])) {
          if (String(g?.来源 || '').startsWith('group')) 读一天(g.来源, g.日期)
        }

        const r = 算印象分(消息们)
        let 名单 = Object.entries(r.按人)
        if (args.人) 名单 = 名单.filter(([谁]) => 谁.includes(String(args.人)))
        名单.sort((a, b) => b[1].分数 - a[1].分数)
        名单 = 名单.slice(0, 上限)

        const 行 = [
          `群友印象分（扫描 ${消息们.length} 条群聊，其中 ${r.合计.艾特总数} 条 @ 了鱼）`,
          `明确的好话 ${r.合计.好} 条、坏话 ${r.合计.坏} 条；${r.合计.有印象的} 人`,
          '',
          '⚠️ 只认明确信号：「大聪明」这种可能是反讽的一律不算。',
          '好话坏话都计分 —— 衡量的是「跟鱼的互动强度」，不是好感度排名。',
          '',
        ]
        if (名单.length === 0) {
          行.push(args.人 ? `没找到「${args.人}」的明确好坏话。` : '还没有人对鱼说过明确的好话或坏话。')
        } else {
          for (const [谁, 记] of 名单) {
            行.push(`${谁}：${记.分数} 分（好 ${记.好} / 坏 ${记.坏}）`)
            for (const 样 of 记.样例) {
              行.push(`  [${样.倾向}] ${样.原文.slice(0, 50)}`)
            }
          }
        }
        return { ok: true, 人数: 名单.length, 艾特总数: r.合计.艾特总数, text: 行.join('\n') }
      },
    },

    // ── 遗忘层：救回来 / 彻底忘掉 ─────────────────────────────────
    //
    // 主人 2026-11-04：「第12层命名为遗忘层，用户可直接看到遗忘层来选择
    // 要不要彻底遗忘这个事件」。
    //
    // 所以遗忘层不是黑洞，是**看得见、可选择**的一层：
    //   · 用 memory_recall { 只看遗忘层: true } 看有哪些事快被忘了
    //   · 用这个工具救回来（回到第 1 层）或彻底删掉
    {
      name: 'memory_forget_events',
      description:
        '处理遗忘层里的事件（很久没人提起、快被忘掉的）。两种操作二选一：' +
        '「救回」= 让它们回到第 1 层，下次检索能正常看到；' +
        '「彻底遗忘」= 从事件库删掉，以后再也搜不到（不可恢复）。' +
        '填事件名或事件身份都行。先调 memory_recall { 只看遗忘层: true } 看清有哪些再操作。',
      parameters: {
        救回: { type: 'array', description: '要救回的事件名（数组）。给的事件名会被标成「刚被提起」，回到第 1 层' },
        彻底遗忘: { type: 'array', description: '要彻底删掉的事件名（数组）。**不可恢复**，删之前先只传一个确认一下' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            处理了: { type: 'number' },
            动作: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (args, value) => 包成文本块(value && value.text ? value.text : ''),
      },
      async execute(args) {
        const { 彻底遗忘, 救回 } = await import('./recall-events-store.js')
        const { join } = await import('node:path')
        const 文件 = join(配置根 || '.', 'events.json')

        const 要救 = Array.isArray(args.救回) ? args.救回 : []
        const 要忘 = Array.isArray(args.彻底遗忘) ? args.彻底遗忘 : []

        // 两种操作必须选一个，不能同时来 —— 一边救一边删，结果没法向用户交代
        if (要救.length > 0 && 要忘.length > 0) {
          return {
            ok: false, 处理了: 0, 动作: '无',
            text: [
              '一次只能做一种操作：要么「救回」，要么「彻底遗忘」，不能同时。',
              '先想清楚这批事件是要留还是要删，再调一次。',
            ].join('\n'),
          }
        }
        if (要救.length === 0 && 要忘.length === 0) {
          return {
            ok: false, 处理了: 0, 动作: '无',
            text: [
              '要做什么？二选一：',
              '  救回: ["事件名"]      让它们回到第 1 层，以后能正常搜到',
              '  彻底遗忘: ["事件名"]  从事件库删掉，不可恢复',
              '',
              '不知道有哪些：先调 memory_recall { 只看遗忘层: true }。',
            ].join('\n'),
          }
        }

        if (要忘.length > 0) {
          const r = await 彻底遗忘(文件, 要忘)
          if (!r.ok) {
            return { ok: false, 处理了: 0, 动作: '彻底遗忘', text: `没删成：${r.错误}` + (r.没找到.length ? `\n找不到：${r.没找到.join('、')}` : '') }
          }
          const 行 = [`已彻底遗忘 ${r.删了} 条事件，以后搜不到了。`]
          if (r.没找到.length) 行.push(`这些没找到（跳过）：${r.没找到.join('、')}`)
          行.push('', '注意：这只删事件库里的记录，聊天原文还在 chat/ 下。要一起删得你自己处理。')
          return { ok: true, 处理了: r.删了, 动作: '彻底遗忘', text: 行.join('\n') }
        }

        const r = await 救回(文件, 要救)
        if (!r.ok) {
          return { ok: false, 处理了: 0, 动作: '救回', text: `没救成：${r.错误}` + (r.没找到.length ? `\n找不到：${r.没找到.join('、')}` : '') }
        }
        const 行 = [`已救回 ${r.救回} 条事件，它们回到第 1 层，下次检索能正常看到。`]
        if (r.没找到.length) 行.push(`这些没找到（跳过）：${r.没找到.join('、')}`)
        return { ok: true, 处理了: r.救回, 动作: '救回', text: 行.join('\n') }
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
