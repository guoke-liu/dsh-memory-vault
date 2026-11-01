// ============================================================================
// onebot.js —— OneBot 11 HTTP 客户端
//
// 【改这个文件前先知道】
//   · token 只从参数或 ONEBOT_TOKEN 环境变量来，**不硬编码、不打印、不写日志**
//   · get_msg / get_group_msg_history 的响应是 {status, retcode, data:{...}} 包装过的，
//     取消息内容要拿 .data —— 漏了这步会「永远拿不到图」（quotehint 踩过）
//   · 图片段可能是 segment 数组，也可能是 CQ 码字符串，extractImages 两种都处理
//   · 取图字节按 url → base64:// → 本地路径 依次回退，全失败返回 null 不抛错
// ============================================================================

/**
 * OneBot 11 HTTP 客户端 + 私聊消息图片提取工具。
 *
 * 用法：
 *   import { createOneBot, extractImages, fetchImageBytes } from './lib/onebot.js';
 *   const ob = createOneBot({ baseUrl: 'http://127.0.0.1:3000' }); // token 缺省读 ONEBOT_TOKEN
 *   await ob.getLoginInfo();
 *   const msgs = await ob.getRecentPrivateMessages(10086, 0);
 *   for (const m of msgs) {
 *     for (const seg of extractImages(m)) {
 *       const buf = await fetchImageBytes(seg); // Buffer，全失败为 null
 *     }
 *   }
 *
 * 安全约定：
 *   - token 只从参数或环境变量 ONEBOT_TOKEN 来，不硬编码、不打印、不写日志。
 *   - 零第三方依赖，只用 Node 内置能力。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const BASE64_PREFIX = 'base64://';

/** CQ 码形态的图片段：[CQ:image,file=xxx,url=yyy] */
const CQ_IMAGE_RE = /\[CQ:image,([^\]]*)\]/g;

/** 去掉 baseUrl 尾部斜杠，避免拼出 `//action`。 */
function normalizeBaseUrl(baseUrl) {
  const url = String(baseUrl ?? '').trim();
  if (!url) throw new TypeError('createOneBot: 缺少 baseUrl');
  return url.replace(/\/+$/, '');
}

/**
 * 解析 CQ 码参数串 "k1=v1,k2=v2"。
 * OneBot 惯例：值是 URL 编码过的（逗号、中括号等特殊字符会被转义），
 * 所以先按逗号切分、再对每个值做 decodeURIComponent。
 */
function parseCqParams(raw) {
  const params = {};
  for (const part of String(raw).split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const value = part.slice(eq + 1).trim();
    try {
      params[key] = decodeURIComponent(value);
    } catch {
      params[key] = value; // 编码不合法时原样保留，宁拿原始串也不丢图
    }
  }
  return params;
}

/**
 * 构造 OneBot 客户端。
 * @param {object} opts
 * @param {string} opts.baseUrl  例如 http://127.0.0.1:3000
 * @param {string} [opts.token]  Access-Token；缺省读环境变量 ONEBOT_TOKEN；为空则不发 Authorization 头
 * @param {typeof fetch} [opts.fetchImpl] 注入的 fetch（测试用）；缺省用全局 fetch
 * @returns {{
 *   call: (action: string, params?: object) => Promise<any>,
 *   getLoginInfo: () => Promise<{userId: number, nickname: string}>,
 *   getRecentPrivateMessages: (userId: number, seq?: number) => Promise<Array>
 * }}
 */
export function createOneBot({ baseUrl, token, fetchImpl } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const resolvedToken = token ?? process.env.ONEBOT_TOKEN ?? '';
  const impl = fetchImpl ?? globalThis.fetch;
  if (typeof impl !== 'function') {
    throw new TypeError('createOneBot: 需要 fetchImpl 或可用的全局 fetch');
  }

  /**
   * POST {baseUrl}/{action}，body 为 JSON 的 params，带 Authorization: Bearer <token>（token 为空则不带）。
   * status=failed 或 retcode 非 0 时抛错，错误对象带 .retcode / .status / .httpStatus。
   */
  async function call(action, params) {
    const headers = { 'Content-Type': 'application/json' };
    const tok = String(resolvedToken).trim();
    if (tok) headers.Authorization = `Bearer ${tok}`;

    const res = await impl(`${base}/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(params ?? {}),
    });

    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null; // 响应体不是 JSON（比如网关错误页）
    }

    const httpOk = res.ok ?? (res.status >= 200 && res.status < 300);
    const bizFailed =
      data != null &&
      (data.status === 'failed' ||
        (data.retcode !== undefined && data.retcode !== 0));

    if (!httpOk || bizFailed) {
      const parts = [`OneBot action "${action}" failed`];
      if (res && res.status !== undefined) parts.push(`http=${res.status}`);
      if (data != null) {
        parts.push(`status=${data.status}`);
        parts.push(`retcode=${data.retcode}`);
        const msg = data.message ?? data.msg ?? data.wording;
        if (msg) parts.push(`message=${msg}`);
      }
      const err = new Error(parts.join(', '));
      if (data != null) {
        err.status = data.status;
        err.retcode = data.retcode;
      }
      err.httpStatus = res?.status;
      throw err;
    }

    return data;
  }

  /** 获取登录号信息，返回 { userId, nickname }。 */
  async function getLoginInfo() {
    const resp = await call('get_login_info', {});
    const d = resp?.data ?? {};
    return { userId: d.user_id, nickname: d.nickname };
  }

  /**
   * 拉取与某好友的最近私聊消息（每页最多 20 条）。
   * @param {number} userId 对方 QQ 号
   * @param {number} [seq]  message_seq；传上一次拿到的最旧一条的 seq 可继续往前翻，不传取最新
   * @returns {Promise<Array>} 消息事件数组（元素可直接喂给 extractImages）
   */
  async function getRecentPrivateMessages(userId, seq) {
    if (userId == null) throw new TypeError('getRecentPrivateMessages: 缺少 userId');
    const resp = await call('get_friend_msg_history', {
      user_id: userId,
      count: 20,
      message_seq: seq ?? undefined, // undefined 在 JSON.stringify 时会被丢弃
    });
    const d = resp?.data;
    if (Array.isArray(d)) return d;                    // data 直接是数组
    if (Array.isArray(d?.messages)) return d.messages; // NapCat/LLOneBot 风格 { messages: [...] }
    return [];
  }

  /**
   * 拉某个群的最近消息（和私聊对称）。
   * @param {number|string} groupId 群号
   * @param {number} [seq] message_seq，往前翻页用
   * @returns {Promise<Array>} 消息事件数组
   */
  async function getRecentGroupMessages(groupId, seq) {
    if (groupId == null) throw new TypeError('getRecentGroupMessages: 缺少 groupId')
    const resp = await call('get_group_msg_history', {
      group_id: Number(groupId),
      count: 20,
      message_seq: seq ?? undefined,
    })
    const d = resp?.data
    if (Array.isArray(d)) return d
    if (Array.isArray(d?.messages)) return d.messages
    return []
  }

  return { call, getLoginInfo, getRecentPrivateMessages, getRecentGroupMessages };
}

/**
 * 从一条 OneBot 消息事件里抽出所有图片段。
 * 兼容两种 message 形态：
 *   - segment 数组：[{ type: 'image', data: { file, url, subType } }, ...]
 *   - CQ 码字符串：'[CQ:image,file=xxx.jpg,url=https%3A%2F%2F...]'
 * @param {{ message?: Array|string }} messageEvent
 * @returns {Array<{file: string|null, url: string|null, isBase64: boolean}>}
 */
export function extractImages(messageEvent) {
  const images = [];
  if (messageEvent == null) return images;
  const message = messageEvent.message;

  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type !== 'image') continue;
      const data = seg.data ?? {};
      const file = typeof data.file === 'string' ? data.file : null;
      const url = typeof data.url === 'string' ? data.url : null;
      images.push({
        file,
        url,
        isBase64: file != null && file.startsWith(BASE64_PREFIX),
      });
    }
  } else if (typeof message === 'string') {
    CQ_IMAGE_RE.lastIndex = 0; // 全局正则有状态，防复用串味
    for (const match of message.matchAll(CQ_IMAGE_RE)) {
      const params = parseCqParams(match[1]);
      const file = typeof params.file === 'string' ? params.file : null;
      images.push({
        file,
        url: typeof params.url === 'string' ? params.url : null,
        isBase64: file != null && file.startsWith(BASE64_PREFIX),
      });
    }
  }
  // 其它形态（无 message 等）一律空数组
  return images;
}

/**
 * 从一条消息里找出「它引用了哪条消息」。
 * OneBot 的引用回复是一个 { type: 'reply', data: { id: '消息id' } } 的段。
 * @returns {string|null} 被引用消息的 id，没有引用返回 null
 */
export function extractReplyId(messageEvent) {
  if (messageEvent == null) return null
  const message = messageEvent.message
  if (Array.isArray(message)) {
    for (const seg of message) {
      if (seg?.type !== 'reply') continue
      const id = seg.data?.id
      if (id != null && String(id).trim()) return String(id).trim()
    }
    return null
  }
  if (typeof message === 'string') {
    // CQ 码形态：[CQ:reply,id=123]
    const m = message.match(/\[CQ:reply,([^\]]*)\]/)
    if (!m) return null
    const params = parseCqParams(m[1])
    return params.id != null && String(params.id).trim() ? String(params.id).trim() : null
  }
  return null
}

/**
 * 把一个图片段（extractImages 的返回项）取成字节。
 * 依次尝试：
 *   1. seg.url（http/https）
 *   2. seg.file 以 base64:// 开头
 *   3. seg.file 是本地路径（含 file:// 形式，OneBot 端与本插件同机时常见）
 * 全部失败返回 null，不抛异常。
 * @param {{file?: string|null, url?: string|null, isBase64?: boolean}} seg
 * @param {{ fetchImpl?: typeof fetch }} [opts]
 * @returns {Promise<Buffer|null>}
 */
export async function fetchImageBytes(seg, { fetchImpl } = {}) {
  if (seg == null) return null;
  const impl = fetchImpl ?? globalThis.fetch;

  // 1) url
  if (typeof seg.url === 'string' && /^https?:\/\//i.test(seg.url)) {
    try {
      const res = await impl(seg.url);
      if (res && res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 0) return buf;
      }
    } catch {
      // 换下一个途径
    }
  }

  // 2) base64://
  const file = typeof seg.file === 'string' ? seg.file : '';
  if (file.startsWith(BASE64_PREFIX)) {
    try {
      const buf = Buffer.from(file.slice(BASE64_PREFIX.length), 'base64');
      if (buf.length > 0) return buf;
    } catch {
      // 换下一个途径
    }
  }

  // 3) 本地路径
  if (file && !file.startsWith(BASE64_PREFIX)) {
    try {
      const path = file.startsWith('file://') ? fileURLToPath(file) : file;
      const buf = await readFile(path);
      if (buf.length > 0) return buf;
    } catch {
      // 全部途径失败
    }
  }

  return null;
}
