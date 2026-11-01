// ============================================================================
// describer.js —— 图片描述器（可插拔）
//
// 【改这个文件前先知道】
//   · 默认只读文件头生成元信息：`一张 JPEG，300x230，6.6 KB`（零依赖、人人可用）
//   · 想接视觉模型就传 自定义描述器（见 /root/.dsh/memory-vault-local/vision.mjs）
//   · **describe() 永远返回非空字符串、永不抛错**：自定义描述器挂了自动降级到元信息
//   · PNG 尺寸偏移是**段名 12 / 宽 16 / 高 20**（曾错写成 16/20/24，高度读出垃圾值）
// ============================================================================

// 可插拔的图片描述器。
//
// text 模式（只存文字描述、不存原图）依赖 description，但插件自己不产生描述——
// 没有看图模型的用户选了 text 模式，等于什么都没存。这个模块补上这个缺口：
//   - 装了自定义描述器（async 函数，看图模型接在这）：优先用它的结果
//   - 没装 / 它抛错 / 它返回空：降级到「元信息描述」（格式 + 尺寸 + 大小 + 是否动图）
//
// 硬性要求：describe() 永远返回非空字符串、永不抛错。

// ── 魔数判格式（与 archive.js 的 SIGNATURES 保持一致，但自成一体）──
const 魔数 = [
  { 格式: 'PNG',  sig: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { 格式: 'JPEG', sig: [0xff, 0xd8, 0xff] },
  { 格式: 'GIF',  sig: [0x47, 0x49, 0x46, 0x38] }, // 'GIF8'
  { 格式: 'WebP', sig: [0x52, 0x49, 0x46, 0x46] },  // 'RIFF'，须再校验偏移 8-11 'WEBP'
];

function 判格式(bytes) {
  for (const { 格式, sig } of 魔数) {
    if (bytes.length < sig.length) continue;
    let 命中 = true;
    for (let i = 0; i < sig.length; i++) {
      if (bytes[i] !== sig[i]) { 命中 = false; break; }
    }
    if (!命中) continue;
    if (格式 === 'WebP') {
      // RIFF 不是专属 WebP，须再确认 'WEBP' 标记
      if (bytes.length >= 12 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'WebP';
      }
      continue;
    }
    return 格式;
  }
  return '未知';
}

// ── 尺寸解析：格式各自的关键字段，读不出就不猜（返回 null）──

// PNG 结构：8 字节签名 + 4 字节长度 + 4 字节段名"IHDR" + 4 字节宽 + 4 字节高
//   → 段名在偏移 12，宽在 16，高在 20
//   ⚠️ 曾经错写成「段名 16 / 宽 20 / 高 24」，把长度字段算进去了，
//      结果高度读成垃圾值（600x134610944）。用真实 PNG 实测才暴露。
function PNG尺寸(bytes) {
  if (bytes.length < 24) return null;
  // 校验这确实是 IHDR 段，避免错位后读出离谱数字
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const 宽 = bytes.readUInt32BE(16);
  const 高 = bytes.readUInt32BE(20);
  if (!宽 || !高 || 宽 > 100000 || 高 > 100000) return null;
  return [宽, 高];
}

// JPEG：扫 0xFFCx（C0..CF 的 SOF 段）。
// SOF 段载荷（marker 后偏移 i）：i+2=段长，i+4=精度(1)，i+5=高(2 大端)，i+7=宽(2 大端)。
function JPEG尺寸(bytes) {
  if (bytes.length < 4) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) break; // 不是有效的段头，到此为止
    const marker = bytes[i + 1];
    // SOF0..SOF15
    if (marker >= 0xc0 && marker <= 0xcf) {
      if (i + 9 > bytes.length) return null;
      const 高 = bytes.readUInt16BE(i + 5);
      const 宽 = bytes.readUInt16BE(i + 7);
      return [宽, 高];
    }
    // 无长度字段的 marker
    if (marker === 0xd8 || marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01) {
      i += 2;
      continue;
    }
    if (i + 4 > bytes.length) break;
    const len = bytes.readUInt16BE(i + 2);
    if (len < 2) break;
    i += 2 + len;
  }
  return null;
}

// GIF：偏移 6 起，宽 2 字节小端，高 2 字节小端
function GIF尺寸(bytes) {
  if (bytes.length < 10) return null;
  return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
}

// WebP：'RIFF' <size4> 'WEBP' <chunk4>，chunk 头在 12
function WebP尺寸(bytes) {
  if (bytes.length < 30) return null;
  const chunk = bytes.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    // @20 flags(4)；@24 reserved 高2位占 3 字节，@27 宽占 3 字节
    const 高 = (bytes[25] << 8) | bytes[26];
    const 宽 = (bytes[28] << 8) | bytes[29];
    return [宽, 高];
  }
  if (chunk === 'VP8L') {
    // @20 起 4 字节：L 标志 + 23 位尺寸（14 位宽 + 9 位高）
    const v = bytes.readUInt32BE(20);
    const 高 = ((v & 0x1fff) + 1);
    const 宽 = (((v >> 14) & 0x3fff) + 1);
    return [宽, 高];
  }
  if (chunk === 'VP8') {
    // @20 起 3 字节头后：宽 2 字节小端（低 14 位）、高 2 字节小端
    if (bytes.length < 30) return null;
    const 宽 = bytes.readUInt16LE(26) & 0x3fff;
    const 高 = bytes.readUInt16LE(28) & 0x3fff;
    return [宽, 高];
  }
  return null;
}

// GIF 动图判断：统计「有效」图像描述符（0x2C 且前缀合法）数量，>1 就是动图。
// 简化为：0x2C 必须前面紧跟逻辑结构尾部（偏移 13 起，跳过逻辑屏幕描述符 7 字节 +
// 可能的 global color table）才计；进一步退化为：只数 0x2C 但要求它不是「帧头位置 13
// 之前」的意外命中。保守做法：数 0x2C 出现次数，再减掉 13 之前出现的（逻辑描述符区）。
function GIF帧数(bytes) {
  // 逻辑屏幕描述符区 = 头 6 字节 + 逻辑 7 字节 = 13 字节，之后才是帧
  let n = 0;
  const 起 = Math.min(13, bytes.length);
  for (let i = 起; i < bytes.length; i++) {
    if (bytes[i] === 0x2c) n++;
  }
  return n;
}

// ── 字节大小：好读的 KB / MB ──
function 人读大小(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

// ── 元信息描述（降级路径）──
function 元信息描述(bytes) {
  const 格式 = 判格式(bytes);
  let 宽 = null, 高 = null;
  try {
    let dim = null;
    if (格式 === 'PNG') dim = PNG尺寸(bytes);
    else if (格式 === 'JPEG') dim = JPEG尺寸(bytes);
    else if (格式 === 'GIF') dim = GIF尺寸(bytes);
    else if (格式 === 'WebP') dim = WebP尺寸(bytes);
    if (dim && Number.isFinite(dim[0]) && Number.isFinite(dim[1]) && dim[0] > 0 && dim[1] > 0) {
      宽 = dim[0]; 高 = dim[1];
    }
  } catch {
    // 解析失败：尺寸写成「尺寸未知」
  }

  const 尺寸 = 宽 != null ? `${宽}x${高}` : '尺寸未知';

  let 名称 = 格式;
  let 动图 = false;
  if (格式 === 'GIF' && GIF帧数(bytes) > 1) {
    动图 = true;
    名称 = 'GIF 动图';
  }

  const 大 = 人读大小(bytes.length);
  return `一张 ${名称}，${尺寸}，${大}`;
}

/**
 * 创建描述器。
 *
 * @param {object} opts
 * @param {(bytes:Buffer, meta:object) => Promise<string>} [opts.自定义描述器]
 *   async 函数；返回非空字符串则直接采用，抛错或返回空则降级。
 * @returns {{describe: (bytes:Buffer, meta:object) => Promise<string>, hasCustom: () => boolean}}
 */
export function createDescriber({ 自定义描述器 } = {}) {
  const 有自定义 = typeof 自定义描述器 === 'function';

  async function describe(bytes, meta = {}) {
    if (有自定义) {
      try {
        const r = await 自定义描述器(bytes, meta);
        if (typeof r === 'string' && r.trim() !== '') return r.trim();
      } catch {
        // 自定义描述器抛错：不中断，继续降级
      }
    }
    // 降级：元信息描述（格式 + 尺寸 + 大小 + 是否动图）
    return 元信息描述(bytes);
  }

  return { describe, hasCustom: () => 有自定义 };
}
