// ============================================================================
// chatlog.js —— 聊天记录存储
//
// 【改这个文件前先知道】
//   · 一天一个文件，私聊群聊分开，群聊再按群号分目录：
//       chat/private/2026-11-01.txt
//       chat/group/123456789/2026-11-01.txt
//   · 每行固定格式：`[HH:MM:SS] 昵称(pid): 内容`
//     ⚠️ 检索时靠正则从这行里抠 pid，改格式要同步改 取行内pid()
//   · 时间一律北京时间（Intl + Asia/Shanghai），不依赖机器时区
//   · 去重表在 chat/.seen.json，按 messageId 记，上限 5000 条
// ============================================================================

// 聊天记录存储：纯文本、一天一个文件；私聊群聊分开，群与群再分开。
//
// 目录布局（挂在记忆库 rootDir 下新开的 chat/ 子树里，与图片仓库互不干扰）：
//   <rootDir>/
//   └── chat/
//       ├── .seen.json                        去重记录（messageId 作 key，最多留 5000 个）
//       ├── private/<YYYY-MM-DD>.txt          私聊：一天一个文件
//       └── group/<群号>/<YYYY-MM-DD>.txt     群聊：先按群分目录，再按天分文件
//
// 每行一条记录，格式固定：`[HH:MM:SS] 昵称(pid): 内容`，时间一律北京时间（Asia/Shanghai, UTC+8）。
// 写入用 appendFile 追加，绝不重写已有内容。

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// .seen.json 上限：超过就按消息时间丢掉最老的，避免文件无限增长
const 已见上限 = 5000;
const 已见文件名 = '.seen.json';

// ── 时间 ──
// 统一用 Intl 按时区取件，不依赖机器时区。hourCycle:'h23' 保证午夜是 00 而不是 24。
const 北京格式 = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

function 北京件(timeMs) {
  const ms = Number(timeMs);
  if (!Number.isFinite(ms)) return null;
  const 件 = {};
  for (const part of 北京格式.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') 件[part.type] = part.value;
  }
  return 件;
}

/** 毫秒时间戳 → 'YYYY-MM-DD'（北京时间）。非法输入返回 ''。 */
export function 日期键(timeMs) {
  const 件 = 北京件(timeMs);
  return 件 ? `${件.year}-${件.month}-${件.day}` : '';
}

function 时刻件(timeMs) {
  const 件 = 北京件(timeMs);
  return 件 ? `${件.hour}:${件.minute}:${件.second}` : '00:00:00';
}

// ── 一行记录 ──

// 把换行压成空格，保证一条消息只占一行（\r\n、\r、\n 都算换行）
function 压平(text) {
  if (text == null) return '';
  return String(text).replace(/\r\n?/g, '\n').replace(/\n/g, ' ');
}

/**
 * 一条消息 → 一行记录：`[HH:MM:SS] 昵称(pid): 内容`
 * 昵称缺失 → '未知'；pid 缺失 → 连括号一起省略。
 */
export function 格式化一行({ timeMs, nickname, pid, text } = {}) {
  const 昵 = nickname == null || String(nickname).trim() === '' ? '未知' : String(nickname).trim();
  const 号 = pid == null || String(pid).trim() === '' ? '' : `(${String(pid).trim()})`;
  return `[${时刻件(timeMs)}] ${昵}${号}: ${压平(text)}`;
}

// ── 路径规则 ──
// 群号直接当目录名（OneBot 群号就是数字串）；但目录名不能拿去穿越路径，
// 带斜杠、控制字符或 . / .. 的一律拒绝。

function 群号段(groupId) {
  const s = String(groupId ?? '').trim();
  if (s === '' || s === '.' || s === '..' || /[\\/\x00-\x1f]/.test(s)) return null;
  return s;
}

function 日期段(date) {
  const s = String(date ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function 私聊目录(rootDir) {
  return join(rootDir, 'chat', 'private');
}

// ── 并发保护 ──
// 追加一条是「读 .seen.json → 查重 → 追加正文 → 写回 .seen.json」，
// 并发调用会互相覆盖导致重复行。按 rootDir 排一条串行队列（同 archive.js 的做法）。
const 队列 = new Map();
function 串行(rootDir, fn) {
  const key = resolve(String(rootDir));
  const 前 = 队列.get(key) ?? Promise.resolve();
  const 这次 = 前.then(fn, fn);
  队列.set(key, 这次.catch(() => {})); // 队列本身永不断链，结果/错误由调用方拿
  return 这次;
}

// ── 去重记录 ──
// .seen.json 就是平铺对象 { "<messageId>": <消息毫秒时间> }；value 存消息时间，
// 截断时按它从新到旧保留。读不到/损坏一律当空表自愈。

async function 读已见(chatDir) {
  let raw;
  try {
    raw = await readFile(join(chatDir, 已见文件名), 'utf8');
  } catch {
    return {}; // 不存在 = 还没见过任何消息
  }
  try {
    const data = JSON.parse(raw);
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    return {}; // 损坏自愈：当空表，下次写回时覆盖
  }
}

function 截断已见(已见) {
  const keys = Object.keys(已见);
  if (keys.length <= 已见上限) return;
  const 条目 = keys.map((k) => [k, Number(已见[k]) || 0]);
  条目.sort((a, b) => b[1] - a[1]); // 时间新的在前
  const 留 = new Set(条目.slice(0, 已见上限).map(([k]) => k));
  for (const k of keys) {
    if (!留.has(k)) delete 已见[k];
  }
}

// ── 主流程 ──

/**
 * 追加一条聊天记录。
 * msg = { chatType: 'private'|'group', groupId?, timeMs, nickname, pid, messageId, text }
 * 返回 { file, appended, duplicated }；任何异常都转成 { appended:false, error }，不抛给调用方。
 */
export async function 追加一条(rootDir, msg) {
  try {
    if (!rootDir) return { appended: false, error: 'rootDir 不能为空' };
    if (!msg || typeof msg !== 'object') return { appended: false, error: 'msg 必须是对象' };
    if (msg.chatType !== 'private' && msg.chatType !== 'group') {
      return { appended: false, error: `chatType 必须是 'private' 或 'group'` };
    }
    const 根 = String(rootDir);
    let 目录;
    if (msg.chatType === 'private') {
      目录 = 私聊目录(根);
    } else {
      const 群号 = 群号段(msg.groupId);
      if (!群号) return { appended: false, error: '群聊消息缺少合法 groupId' };
      目录 = join(根, 'chat', 'group', 群号);
    }

    const 内容 = 压平(msg.text);
    if (内容.trim() === '') return { appended: false }; // 空消息不写、也不记去重

    let timeMs = Number(msg.timeMs);
    if (!Number.isFinite(timeMs)) timeMs = Date.now(); // 缺时间按收到时刻兜底
    const date = 日期键(timeMs);
    const file = join(目录, `${date}.txt`);
    const line = 格式化一行({ timeMs, nickname: msg.nickname, pid: msg.pid, text: 内容 });
    const messageId = msg.messageId == null ? '' : String(msg.messageId).trim();

    return 串行(根, () => 落盘(根, 目录, file, line, messageId, timeMs));
  } catch (err) {
    return { appended: false, error: err?.message ?? String(err) };
  }
}

async function 落盘(根, 目录, file, line, messageId, timeMs) {
  try {
    const chatDir = join(根, 'chat');
    const 已见 = messageId === '' ? {} : await 读已见(chatDir);
    if (messageId !== '' && Object.prototype.hasOwnProperty.call(已见, messageId)) {
      return { file, appended: false, duplicated: true };
    }
    await mkdir(目录, { recursive: true }); // 文件不存在就连目录一起建
    await appendFile(file, line + '\n', 'utf8'); // 追加写，不动已有内容
    if (messageId !== '') {
      已见[messageId] = timeMs;
      截断已见(已见);
      await writeFile(join(chatDir, 已见文件名), JSON.stringify(已见), 'utf8');
    }
    return { file, appended: true, duplicated: false };
  } catch (err) {
    return { appended: false, error: err?.message ?? String(err) };
  }
}

// ── 读 ──

async function 读行(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return []; // 不存在（或读不了）一律给空
  }
  return raw
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l !== '');
}

async function 列群目录(根) {
  try {
    return await readdir(join(根, 'chat', 'group'));
  } catch {
    return []; // chat/group 还不存在 = 一个群都没有
  }
}

// 列一个目录下所有 <YYYY-MM-DD>.txt 的日期部分
async function 列日期(dir) {
  let 名单;
  try {
    名单 = await readdir(dir);
  } catch {
    return [];
  }
  return 名单.filter((n) => /^\d{4}-\d{2}-\d{2}\.txt$/.test(n)).map((n) => n.slice(0, 10));
}

const 按日期降序 = (a, b) => (a < b ? 1 : a > b ? -1 : 0);

/** 读某天全部记录，返回行数组（每行一条）。文件不存在返回 []。 */
export async function 读某天(rootDir, { chatType, groupId, date } = {}) {
  try {
    if (!rootDir) return [];
    const d = 日期段(date);
    if (!d) return [];
    const 根 = String(rootDir);
    if (chatType === 'private') {
      return 读行(join(私聊目录(根), `${d}.txt`));
    }
    if (chatType === 'group') {
      if (groupId != null && groupId !== '') {
        const 群号 = 群号段(groupId);
        return 群号 ? 读行(join(根, 'chat', 'group', 群号, `${d}.txt`)) : [];
      }
      // 不传 groupId：合并所有群这一天的记录（按群号排序，顺序稳定）
      const 行s = [];
      for (const 群号 of (await 列群目录(根)).sort()) {
        行s.push(...(await 读行(join(根, 'chat', 'group', 群号, `${d}.txt`))));
      }
      return 行s;
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 列出这个私聊/群聊有哪些日期文件，降序（最新在前），如 ['2026-11-01', '2026-10-31']。
 * 群聊不传 groupId 时合并所有群的日期。
 */
export async function 列出已有日期(rootDir, { chatType, groupId } = {}) {
  try {
    if (!rootDir) return [];
    const 根 = String(rootDir);
    if (chatType === 'private') {
      return (await 列日期(私聊目录(根))).sort(按日期降序);
    }
    if (chatType === 'group') {
      if (groupId != null && groupId !== '') {
        const 群号 = 群号段(groupId);
        return 群号 ? (await 列日期(join(根, 'chat', 'group', 群号))).sort(按日期降序) : [];
      }
      const dates = new Set();
      for (const 群号 of await 列群目录(根)) {
        for (const d of await 列日期(join(根, 'chat', 'group', 群号))) dates.add(d);
      }
      return [...dates].sort(按日期降序);
    }
    return [];
  } catch {
    return [];
  }
}

// 从整行里取出消息内容（`[HH:MM:SS] 昵称(pid): 内容` 最后一段）；不合格式就退回整行
function 取内容(line) {
  const m = /^\[\d{2}:\d{2}:\d{2}\] .+?: (.*)$/.exec(line);
  return m ? m[1] : line;
}

/** 从整行里取出括号里的 pid（`[HH:MM:SS] 昵称(pid): 内容`）；取不到返回 null */
function 取行内pid(line) {
  const m = /^\[\d{2}:\d{2}:\d{2}\] [^(]*\(([^)]+)\): /.exec(line);
  return m ? m[1] : null;
}

/**
 * 把「编号或 QQ 号」解析成 pid。认得 `p1` 也认得 `10000002`。
 * 找不到返回 null（调用方据此返回空结果，而不是忽略过滤）。
 */
async function 解析成pid(rootDir, person) {
  const v = String(person ?? '').trim();
  if (!v) return null;
  try {
    const d = JSON.parse(await readFile(join(rootDir, 'people.json'), 'utf8'));
    const byQq = d && typeof d.byQq === 'object' ? d.byQq : {};
    const people = d && typeof d.people === 'object' ? d.people : {};
    if (people[v]) return v;                    // 本来就是 pid
    if (byQq[v]) return byQq[v];                // QQ 号
    // 也许传的是别人记在 people 里的 qq 字段
    for (const [pid, rec] of Object.entries(people)) {
      if (rec && String(rec.qq) === v) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 简单关键词搜索：不分词，直接 includes 匹配、忽略大小写。
 * opts.chatType 不传 = 私聊和群聊都搜；groupId 只对群聊有意义（不传 = 所有群）。
 * 从新到旧搜（日期新的文件先搜，文件内从最后一行往前），命中满 limit 就停（默认 50）。
 * 返回 [{ date, chatType, groupId, line, text }]：line 是整行记录，text 是其中的消息内容。
 */
export async function 搜索记录(rootDir, query, { chatType, groupId, person, limit } = {}) {
  try {
    if (!rootDir) return [];
    const 词 = String(query ?? '').trim().toLowerCase();
    if (词 === '') return [];
    const n = Number(limit);
    const 上限 = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50;

    const 根 = String(rootDir);
    // 按人过滤：指定了人但查不到 → 直接空结果（不能悄悄返回所有人的）
    let 过滤pid = null;
    if (person != null && String(person).trim() !== '') {
      过滤pid = await 解析成pid(根, person);
      if (过滤pid === null) return [];
    }
    const 搜私聊 = !chatType || chatType === 'private';
    const 搜群聊 = !chatType || chatType === 'group';
    if (!搜私聊 && !搜群聊) return [];

    const 目标 = []; // { chatType, groupId, date, file }
    const 收群 = async (群号, dir) => {
      for (const d of await 列日期(dir)) {
        目标.push({ chatType: 'group', groupId: 群号, date: d, file: join(dir, `${d}.txt`) });
      }
    };

    if (搜私聊) {
      const dir = 私聊目录(根);
      for (const d of await 列日期(dir)) {
        目标.push({ chatType: 'private', groupId: null, date: d, file: join(dir, `${d}.txt`) });
      }
    }
    if (搜群聊) {
      if (groupId != null && groupId !== '') {
        const 群号 = 群号段(groupId);
        if (!群号) return []; // groupId 非法：明确不搜，而不是悄悄扩大到全部群
        await 收群(群号, join(根, 'chat', 'group', 群号));
      } else {
        for (const 群号 of await 列群目录(根)) {
          await 收群(群号, join(根, 'chat', 'group', 群号));
        }
      }
    }

    // 从新到旧；同一天里私聊在前、群按群号，保证顺序稳定
    目标.sort((a, b) =>
      按日期降序(a.date, b.date) ||
      (a.chatType === b.chatType
        ? String(a.groupId ?? '').localeCompare(String(b.groupId ?? ''))
        : a.chatType === 'private' ? -1 : 1),
    );

    const 命中 = [];
    for (const t of 目标) {
      if (命中.length >= 上限) break; // 够了就停，后面的文件不再读
      const 行s = await 读行(t.file);
      for (let i = 行s.length - 1; i >= 0; i--) {
        const 行 = 行s[i];
        if (过滤pid !== null && 取行内pid(行) !== 过滤pid) continue;
        if (!行.toLowerCase().includes(词)) continue;
        命中.push({ date: t.date, chatType: t.chatType, groupId: t.groupId, line: 行, text: 取内容(行) });
        if (命中.length >= 上限) break;
      }
    }
    return 命中;
  } catch {
    return [];
  }
}
