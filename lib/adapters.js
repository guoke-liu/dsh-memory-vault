// 外部记忆格式转换器：让市面上别的记忆插件，能把它们的记忆批量导进本仓库。
//
// 目前支持的格式：
//   claude-mem-export —— thedotmack/claude-mem（Apache-2.0）的导出 JSON，形状大致是
//     { exportedAt, exportedAtEpoch, query, totalObservations, totalSessions,
//       totalSummaries, totalPrompts, observations[], sessions[], summaries[], prompts[] }
//     只确认 observations[].{ title, text, type, memory_session_id, created_at_epoch }
//     和外层 exportedAtEpoch 这几个字段，其余一律宽容：多余字段忽略、缺失字段给默认值，
//     绝不因为字段缺失或脏数据抛错。
//
// 三个出口：
//   识别格式(data)                     → 'claude-mem-export' | null，任何输入都不抛错
//   转换成memo(data, { source })       → [{ source, title, text, tags, time }]
//   导入外部记忆(rootDir, data, 选项)   → 端到端落盘，任何异常都返回 { ok:false, error }
//
// memos.json 的读写是照 ingest.js 的语义自己实现的一份（ingest.js 没有导出那些内部
// 函数，不能 import），两边格式必须互通：{ version:1, nextNo, memos }，键是 String(no)，
// 每条存 { no, source, title, text, tags, time, receivedAt }，去重按 同一 source + 同一 text。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const MEMOS文件 = 'memos.json'
const 无标题默认 = '（无标题）'
const 摘要前缀 = '摘要：'
const 提示前缀 = '提示：'

// ── 宽容的小工具 ──

// 取一个"像话的字符串"：非字符串、纯空白都算缺失返回 null；有限数字转成字符串
function 取字符串(v) {
  if (typeof v === 'string' && v.trim() !== '') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return null
}

// 取毫秒时间戳：数字或纯数字字符串都行，非法返回 null
function 取毫秒(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

// ── 识别 ──

// 判据：是普通对象 + 有 exportedAt 或 exportedAtEpoch + observations 是数组
export function 识别格式(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  if (data.exportedAt == null && data.exportedAtEpoch == null) return null
  if (!Array.isArray(data.observations)) return null
  return 'claude-mem-export'
}

// ── 转换 ──

// 时间回退链：单条 created_at_epoch → exportedAtEpoch → exportedAt(ISO) → Date.now()
function 算回退时间(data) {
  const d = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const 直接 = 取毫秒(d.exportedAtEpoch)
  if (直接 != null) return 直接
  const iso = typeof d.exportedAt === 'string' ? Date.parse(d.exportedAt) : NaN
  return Number.isFinite(iso) ? iso : Date.now()
}

// 单条外部记录 → memo；title 和 text 都缺（或纯脏数据）返回 null 表示跳过这条
function 一条转memo(item, 前缀, 回退时间, source) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null
  const 标题原文 = 取字符串(item.title)
  const 内容原文 = 取字符串(item.text)
  if (!标题原文 && !内容原文) return null
  const tags = []
  const 类型 = 取字符串(item.type)
  if (类型) tags.push(类型)
  const 会话 = 取字符串(item.memory_session_id)
  if (会话) tags.push(`session:${会话}`)
  return {
    source,
    title: 前缀 + (标题原文 || 无标题默认),
    text: 内容原文 || 标题原文, // text 缺失用 title 本身兜底
    tags,
    time: 取毫秒(item.created_at_epoch) ?? 回退时间,
  }
}

/**
 * 转换成memo(data, { source })：外部格式 → 本仓库的 memo 数组。
 *   observations[] → 每条一个 memo
 *   summaries[]    → 每条一个 memo，title 前缀「摘要：」
 *   prompts[]      → 每条一个 memo，title 前缀「提示：」
 *   sessions[]     → 不转换（只是元数据）
 * 转换出的 memo 一律带 source 字段（调用方没传就用 null 占位）。
 */
export function 转换成memo(data, { source } = {}) {
  const out = []
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return out
  const source值 = source === undefined ? null : source
  const 回退时间 = 算回退时间(data)
  for (const 段 of [
    { 清单: data.observations, 前缀: '' },
    { 清单: data.summaries, 前缀: 摘要前缀 },
    { 清单: data.prompts, 前缀: 提示前缀 },
  ]) {
    if (!Array.isArray(段.清单)) continue
    for (const item of 段.清单) {
      const memo = 一条转memo(item, 段.前缀, 回退时间, source值)
      if (memo) out.push(memo)
    }
  }
  return out
}

// ── 落盘：memos.json，与 ingest.js 相同的结构，两边写出的文件必须互通 ──

const 落盘队列 = new Map() // 已解析的 rootDir → Promise（串行防并发互踩，同 ingest.js 的做法）
function 串行(rootDir, fn) {
  const key = resolve(String(rootDir))
  const 前 = 落盘队列.get(key) ?? Promise.resolve()
  const 这次 = 前.then(fn, fn)
  落盘队列.set(key, 这次.catch(() => {}))
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

// 去重键：同一 source + 同一 text 视为同一条；JSON.stringify 归一化 undefined/null
const 去重键 = (source, text) => JSON.stringify([source ?? null, text ?? null])

/**
 * 导入外部记忆(rootDir, data, { source, settings })：识别 → 转换 → 落盘，端到端。
 *   source 缺省用识别出的格式名（settings 目前只是占位，与 ingest 的调用方形状对齐）；
 *   去重：同一 source + 同一 text 视为同一条，跳过；
 *   成功返回 { ok:true, 识别格式, 转换条数, 新增, 跳过 }；
 *   任何异常（识别不了、磁盘写不进…）都不抛给调用方，返回 { ok:false, error }。
 */
export async function 导入外部记忆(rootDir, data, { source, settings } = {}) {
  try {
    if (typeof rootDir !== 'string' || rootDir.trim() === '') {
      return { ok: false, error: 'rootDir 必须是库目录的路径字符串' }
    }
    const 格式名 = 识别格式(data)
    if (!格式名) return { ok: false, error: '无法识别的格式' }
    const source值 = source === undefined ? 格式名 : source
    const 转好的 = 转换成memo(data, { source: source值 })
    return await 串行(rootDir, async () => {
      const d = await 读memos(rootDir)
      const 已有键 = new Set()
      for (const e of Object.values(d.memos)) {
        if (e && typeof e === 'object') 已有键.add(去重键(e.source, e.text))
      }
      const receivedAt = Date.now()
      let 新增 = 0
      let 跳过 = 0
      for (const memo of 转好的) {
        const 键 = 去重键(memo.source, memo.text)
        if (已有键.has(键)) { 跳过 += 1; continue }
        const no = d.nextNo
        d.nextNo = no + 1
        d.memos[String(no)] = { no, ...memo, receivedAt }
        已有键.add(键)
        新增 += 1
      }
      if (新增 > 0) await 写memos(rootDir, d)
      return { ok: true, 识别格式: 格式名, 转换条数: 转好的.length, 新增, 跳过 }
    })
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) }
  }
}
