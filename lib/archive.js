// ============================================================================
// archive.js —— 图片存储层
//
// 【改这个文件前先知道】
//   · 所有图片写入都走 archiveImage()，别的地方不要直接碰 objects/ 和 index.json
//   · refs 数组长度 = 引用次数。**没有单独的 count 字段**（避免两个数对不上）
//   · index.json 必须原子写（临时文件+rename）。直接 writeFile 断电会留半截
//   · 并发保护靠「按 rootDir 串行队列」，同一库的写操作排队执行
//
// 【数据长什么样】（详见文件末尾 getStats）
//   index.json = { version, nextNo, images: { <sha256>: { no, sha256, ext, bytes,
//                  firstSeen, lastSeen, refs:[{messageId,pid,time}], quotedBy:[...] } } }
//   objects/<sha256>.<ext> —— 原图字节，一个内容一份
// ============================================================================

// 记忆仓库存储层：原图本体保留（不转码），重复内容只存一份，按编号管理。
//
// 目录布局：
//   <rootDir>/
//   ├── index.json           主索引（原子写：临时文件 + rename）
//   └── objects/<sha256>.<ext>   原图字节，按 sha256 命名
//
// 引用计数 = 条目 refs 数组长度，不另存 count 字段。

import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename, readFile, stat, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const ARCHIVE_VERSION = 1;

// 已知图片头魔数 → 扩展名。顺序无关，各签名互斥。
const SIGNATURES = [
  { ext: 'png',  sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg',  sig: [0xff, 0xd8, 0xff] },
  { ext: 'gif',  sig: [0x47, 0x49, 0x46, 0x38] }, // 'GIF8'
  { ext: 'webp', sig: [0x52, 0x49, 0x46, 0x46] }, // 'RIFF'（再校验偏移 8-11 为 'WEBP'）
];

function detectExt(bytes) {
  for (const { ext, sig } of SIGNATURES) {
    if (bytes.length < sig.length) continue;
    let ok = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) { ok = false; break; }
    }
    if (!ok) continue;
    if (ext === 'webp') {
      // RIFF 不是专属 WebP，须再确认 'WEBP' 标记
      if (bytes.length >= 12 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'webp';
      }
      continue;
    }
    return ext;
  }
  return 'img';
}

function ensureDir(dir) {
  // 700：库目录里是原图和索引，都是隐私数据。
  // recursive 对已存在的目录不改权限，所以老库要另外 chmod（见 main 里的迁移）。
  return mkdir(dir, { recursive: true, mode: 0o700 });
}

// ── 并发保护 ──
// archiveImage 是「读索引 → 改内存 → 写回索引」，多个调用并发时后写的会覆盖先写的，
// 导致丢图。这里按 rootDir 排一条串行队列，同一库的写操作排队执行。
const 队列 = new Map();
function 串行(rootDir, fn) {
  const 前 = 队列.get(rootDir) ?? Promise.resolve();
  const 这次 = 前.then(fn, fn);
  // 无论成败都让后续接着排，错误由调用方自己 catch
  队列.set(rootDir, 这次.catch(() => {}));
  return 这次;
}

function emptyIndex() {
  return { version: ARCHIVE_VERSION, nextNo: 1, images: {} };
}

// 读 index.json；不存在或损坏一律视为空库（自愈），不抛异常。
async function loadIndex(rootDir) {
  const indexPath = join(rootDir, 'index.json');
  let raw;
  try {
    raw = await readFile(indexPath, 'utf8');
  } catch {
    return emptyIndex();
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !data.images || typeof data.images !== 'object') {
      return emptyIndex();
    }
    // 容错：缺字段时补齐
    if (typeof data.nextNo !== 'number' || !Number.isInteger(data.nextNo) || data.nextNo < 1) {
      data.nextNo = 1;
    }
    for (const entry of Object.values(data.images)) {
      if (!Array.isArray(entry.refs)) entry.refs = [];
    }
    return data;
  } catch {
    return emptyIndex();
  }
}

// 原子写 index.json：先写临时文件，再 rename。
//
// 权限 600：index.json 里有图片描述（含中文正文）、时间、QQ 号数字串，
// 属于隐私数据，不该对同机其他用户可读。实测原来落成 644。
async function saveIndex(rootDir, index) {
  await ensureDir(rootDir);
  const finalPath = join(rootDir, 'index.json');
  const tmpPath = join(rootDir, `index.json.tmp-${process.pid}-${Date.now()}`);
  await writeFile(tmpPath, JSON.stringify(index, null, 2));
  // 先收权限再改名：避免出现「文件已可见但权限还没收」的瞬间
  try { await chmod(tmpPath, 0o600); } catch { /* 某些文件系统不支持 */ }
  await rename(tmpPath, finalPath);
}

/**
 * 初始化库目录（幂等，可重复调用）。
 * 建 objects/ 子目录 + 写一份空的 index.json（已存在则不动内容）。
 *
 * @param {string} rootDir 库根目录
 * @returns {Promise<{rootDir:string}>}
 */
export async function initArchive(rootDir) {
  await ensureDir(join(rootDir, 'objects'));
  const index = await loadIndex(rootDir);
  await saveIndex(rootDir, index);
  return { rootDir };
}

/**
 * 归档一张图。**这是整个图片库的唯一写入口。**
 *
 * 流程：
 *   1. 算 sha256 → 库里已有这张图就只追加 refs（引用 +1），不重复存文件
 *   2. 没有就分配编号（index.nextNo 递增）、原图字节原样写进 objects/
 *   3. 原子写 index.json（临时文件 + rename，断电不会留半截）
 *
 * @param {string} rootDir       库根目录
 * @param {Buffer} bytes         原图字节（**原样存，不转码、不缩放**）
 * @param {object} [meta]        元信息
 * @param {string} [meta.messageId] QQ 消息 id —— 用来防止同一条消息重复计数
 * @param {string} [meta.pid]       发图人的短编号（p1/p2…），**优先用这个，不要写长 QQ 号**
 * @param {string} [meta.userId]    主人在 QQ 号（只在没有 pid 时兜底）
 * @param {number} [meta.time]      毫秒时间戳
 * @returns {Promise<{no:number, sha256:string, deduped:boolean,
 *                    alreadyRefed:boolean, refCount:number, file:string}>}
 *
 * ⚠️ alreadyRefed=true 表示「这条消息早就记过了」，本次没有增加引用。
 *    调用方据此决定要不要给这个人 refs+1（否则会虚增）。
 */
export async function archiveImage(rootDir, bytes, meta = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError('bytes 必须是 Buffer');
  }
  return 串行(rootDir, () => archiveImageInner(rootDir, bytes, meta));
}

async function archiveImageInner(rootDir, bytes, meta = {}) {
  if (!Buffer.isBuffer(bytes)) {
    throw new TypeError('bytes 必须是 Buffer');
  }
  if (bytes.length === 0) {
    throw new Error('archiveImage: 拒绝空 Buffer');
  }

  const index = await loadIndex(rootDir);
  const objectsDir = join(rootDir, 'objects');
  await ensureDir(objectsDir);

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const ext = detectExt(bytes);
  const filePath = join(objectsDir, `${sha256}.${ext}`);

  const now = Date.now();
  // ⭐ 2026-11-01：refs 里不再写长串 QQ 号，改用 people.json 里的短编号 p1/p2。
  //    没给 pid 时才退回写 userId（向前兼容，不影响已有数据）。
  const ref = {
    messageId: meta.messageId,
    pid: meta.pid,
    userId: meta.pid ? undefined : meta.userId,
    time: meta.time ?? now,
    // ⭐ 2026-11-02：来源群号 / 会话类型 —— 不记就会「串群」（在 A 群搜到 B 群的图）
    groupId: meta.groupId,
    chatType: meta.chatType,
  };
  // 只保留有值的元信息，避免 undefined 进 refs
  for (const k of Object.keys(ref)) {
    if (ref[k] === undefined) delete ref[k];
  }

  const entry = index.images[sha256];
  // 同一个 messageId 只算一次引用 —— 去重必须落在存储层，
  // 不能只靠进程内的已见集合（进程重启就没了，会重复计数）。
  const 已记过 = !!entry && !!ref.messageId &&
    entry.refs.some((r) => r && r.messageId === ref.messageId);
  let deduped;
  if (entry) {
    deduped = true;
    if (!已记过) {
      entry.lastSeen = now;
      entry.refs.push(ref);
    } else if (ref.groupId != null) {
      // ⭐ 2026-11-02：同一条消息重复扫到时，refs 不重复 push（防虚增引用数），
      //   但如果那条老引用还没记群号，把群号补上 —— 否则补丁生效前入库的图永远没有群号，
      //   检索时就会「串群」。
      const 老 = entry.refs.find((r) => r && r.messageId === ref.messageId);
      if (老 && 老.groupId == null) {
        老.groupId = ref.groupId;
        if (老.chatType == null && ref.chatType != null) 老.chatType = ref.chatType;
      }
    }
  } else {
    deduped = false;
    const no = index.nextNo;
    index.nextNo = no + 1;
    index.images[sha256] = {
      no,
      sha256,
      ext,
      bytes: bytes.length,
      mime: meta.mime,
      firstSeen: now,
      lastSeen: now,
      refs: [ref],
    };
    // 原图字节原样落盘。同样是隐私数据，写的时候就收权限。
    await ensureDir(dirname(filePath));
    await writeFile(filePath, bytes);
    try { await chmod(filePath, 0o600); } catch { /* 某些文件系统不支持 */ }
  }

  await saveIndex(rootDir, index);

  const finalEntry = index.images[sha256];
  return {
    no: finalEntry.no,
    sha256,
    deduped,
    alreadyRefed: 已记过,   // true = 这条消息早就记过，本次没有增加引用
    refCount: finalEntry.refs.length,
    file: filePath,
  };
}

async function entryFromNo(rootDir, no) {
  const index = await loadIndex(rootDir);
  if (!Number.isInteger(no)) return null;
  for (const entry of Object.values(index.images)) {
    if (entry.no === no) return entry;
  }
  return null;
}

/**
 * 按编号查一张图。
 * @param {string} rootDir
 * @param {number} no  图片编号（从 1 开始）
 * @returns {Promise<object|null>} 条目对象；找不到返回 null
 */
export async function findByNo(rootDir, no) {
  return entryFromNo(rootDir, no);
}

/**
 * 按 sha256 前缀查一张图（至少 8 位）。
 * @param {string} rootDir
 * @param {string} shaPrefix  sha256 的前几位
 * @returns {Promise<object|null>}
 * @throws {Error} 前缀少于 8 位时抛错（太短会匹配到多张，宁可不猜）
 */
export async function findBySha(rootDir, shaPrefix) {
  if (typeof shaPrefix !== 'string' || shaPrefix.length < 8) {
    throw new Error('findBySha: sha 前缀至少 8 位');
  }
  const index = await loadIndex(rootDir);
  const prefix = shaPrefix.toLowerCase();
  for (const [sha, entry] of Object.entries(index.images)) {
    if (sha.startsWith(prefix)) return entry;
  }
  return null;
}

/**
 * 列出图片，按编号升序。
 * @param {string} rootDir
 * @param {object} [opts]
 * @param {number} [opts.limit]   最多返回几条（不传=全部）
 * @param {number} [opts.offset]  跳过前几条（分页用）
 * @returns {Promise<{total:number, items:object[]}>}
 */
export async function listImages(rootDir, { limit, offset } = {}) {
  const index = await loadIndex(rootDir);
  const items = Object.values(index.images);
  items.sort((a, b) => a.no - b.no);
  const total = items.length;
  const off = Number.isInteger(offset) && offset > 0 ? offset : 0;
  let out = items.slice(off);
  if (Number.isInteger(limit) && limit >= 0) {
    out = out.slice(0, limit);
  }
  return { total, items: out };
}

/**
 * 统计。
 * @returns {Promise<{unique:number, totalRefs:number, dedupedRefs:number,
 *                    totalBytes:number, maxNo:number}>}
 *   unique       —— 库里实际有几个不同的文件
 *   totalRefs    —— 一共被发过几次（refs 数组总长）
 *   dedupedRefs  —— 因为重复而省下的份数（= totalRefs - unique）
 */
export async function getStats(rootDir) {
  const index = await loadIndex(rootDir);
  const entries = Object.values(index.images);
  let totalRefs = 0;
  let totalBytes = 0;
  let maxNo = 0;
  for (const entry of entries) {
    totalRefs += entry.refs.length;
    totalBytes += entry.bytes ?? 0;
    if (entry.no > maxNo) maxNo = entry.no;
  }
  const dedupedRefs = totalRefs - entries.length;
  return {
    unique: entries.length,
    totalRefs,
    dedupedRefs,
    totalBytes,
    maxNo,
  };
}
