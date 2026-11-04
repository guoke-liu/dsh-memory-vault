// ============================================================================
// people.js —— 人物表（QQ 号 ↔ 短编号）
//
// 【改这个文件前先知道】
//   · 一个 QQ 号一个编号（p1/p2…），**同一个人有多个号也不合并**（主人明确要求）
//   · 图片 refs 里只写 pid，不写长 QQ 号 —— QQ 号只在 people.json 出现一次
//   · 空昵称兜底成 `QQ<号码>`；**空昵称不触发改名**
//     （否则空→兜底名会来回抖，把曾用名刷爆，实测 p2 堆过 43 条）
//   · 曾用名：同一昵称只记一次 + 上限 10 条
// ============================================================================

// 人物对照表：QQ 号 + 昵称 → 编号。
//
// 需求（2026-11-01 主人原话）：「QQ号和名称也做成编号直接代替只存一份」
// 也就是说：图片的每次引用里不再写长串 QQ 号，只写一个短编号 p1 / p2；
// 谁是谁，查 people.json 这一份对照表就行。

import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'

const 文件名 = 'people.json'

function 空表() {
  // nextNo 分配新编号；byQq 用 QQ 号反查；people 存编号→资料
  return { version: 1, nextNo: 1, byQq: {}, people: {} }
}

async function 读(rootDir) {
  try {
    const raw = await readFile(join(rootDir, 文件名), 'utf8')
    const d = JSON.parse(raw)
    if (!d || typeof d !== 'object' || !d.people || typeof d.people !== 'object') return 空表()
    if (typeof d.nextNo !== 'number' || d.nextNo < 1) d.nextNo = 1
    if (!d.byQq || typeof d.byQq !== 'object') d.byQq = {}
    return d
  } catch {
    return 空表()
  }
}

async function 写(rootDir, 表) {
  await mkdir(rootDir, { recursive: true })
  const 最终 = join(rootDir, 文件名)
  const 临时 = 最终 + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(临时, JSON.stringify(表, null, 1))
  // 人物表里有昵称和 QQ 号，属于隐私数据 —— 先收权限再改名
  try { await chmod(临时, 0o600) } catch { /* 某些文件系统不支持 */ }
  await rename(临时, 最终)
}

/**
 * 昵称兜底：空昵称/纯空白时，用 QQ 号生成一个稳定的显示名。
 * 例如 QQ 10000000 → 「QQ10000000」。
 * 这样界面上不会出现一片空白，也仍然一眼能看出是谁。
 */
export function 兜底昵称(userId, nickname) {
  const 名 = String(nickname ?? '').trim()
  if (名) return 名
  const qq = String(userId ?? '').trim()
  return qq ? `QQ${qq}` : '未知'
}

/**
 * 拿到某个 QQ 号对应的编号，没有就新建一个。
 * 昵称每次调用都会顺手更新（人可能改名）。
 * @returns {Promise<{pid:string, user:object, created:boolean}>}
 */
export function 记住人(rootDir, { userId, nickname }) {
  return 串行(rootDir, async () => {
    const qq = String(userId ?? '').trim()
    if (!qq) throw new Error('记住人: 缺 userId')
    const 表 = await 读(rootDir)
    let pid = 表.byQq[qq]
    let created = false
    if (!pid) {
      pid = 'p' + 表.nextNo
      表.nextNo += 1
      表.byQq[qq] = pid
      表.people[pid] = {
        qq,
        nickname: 兜底昵称(qq, nickname),
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        refs: 0,
      }
      created = true
    } else {
      const rec = 表.people[pid]
      if (rec) {
        // 注意：这里只用「真实的非空昵称」判断改名。
        // 空昵称进来不能触发改名（否则空→兜底名会来回抖，把曾用名刷爆）。
        const 新名 = String(nickname ?? '').trim()
        if (新名 && 新名 !== rec.nickname) {
          // 保留历史昵称，改名不是坏事，但要留痕。
          // ⚠️ 有人会在两个昵称之间来回切（鱼 ↔ 大肥鱼），每次切都记一条会无限膨胀。
          //    所以：① 同一昵称只记一次；② 上限 10 条，超了丢最老的。
          const 史 = (rec.曾用名 ||= [])
          if (!史.includes(rec.nickname)) {
            史.push(rec.nickname)
            if (史.length > 10) 史.splice(0, 史.length - 10)
          }
          rec.nickname = 新名
        }
        rec.lastSeen = Date.now()
      }
    }
    await 写(rootDir, 表)
    return { pid, user: 表.people[pid], created }
  })
}

/** 记账：这个人总共发过多少张图（引用数 +1 时调用） */
export function 记一次引用(rootDir, pid) {
  return 串行(rootDir, async () => {
    const 表 = await 读(rootDir)
    const rec = 表.people[pid]
    if (rec) {
      rec.refs = (rec.refs || 0) + 1
      rec.lastSeen = Date.now()
      await 写(rootDir, 表)
    }
    return rec || null
  })
}

/** 按编号查人 */
export async function 查人(rootDir, pid) {
  const 表 = await 读(rootDir)
  return 表.people[pid] || null
}

/** 列全部人 */
export async function 列出人(rootDir) {
  const 表 = await 读(rootDir)
  return Object.entries(表.people)
    .map(([pid, v]) => ({ pid, ...v }))
    .sort((a, b) => a.pid.localeCompare(b.pid, undefined, { numeric: true }))
}

// 与 archive.js 一样：同库串行，避免并发写坏 people.json
const 队列 = new Map()
function 串行(rootDir, fn) {
  const 前 = 队列.get(rootDir) ?? Promise.resolve()
  const 这次 = 前.then(fn, fn)
  队列.set(rootDir, 这次.catch(() => {}))
  return 这次
}
