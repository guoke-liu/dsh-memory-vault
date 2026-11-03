// 配置管理器：三档「存图模式」开关的读写。
//
// 配置存成一个 JSON 文件（路径由 createSettings({ configPath }) 指定）：
//   {
//     "version": 1,
//     "存图模式": "both",   // ⭐ 总开关（兜底）：私聊/群聊没单独设过时都用它
//     "私聊存图模式": "",    // ⭐ 留空 = 跟随「存图模式」；private 专用档位
//     "群聊存图模式": "",    // ⭐ 留空 = 跟随「存图模式」；group 专用档位
//     "启用私聊": true,
//     "启用群聊": false,
//     "库目录": "",
//     "允许的插件": []      // 开放接入白名单：谁可以 POST /ingest 写记忆；空 = 全拒
//   }
//
// 约定：
//   - read() 永不抛异常：文件不存在 / 损坏 / 不是 JSON 对象 → 整体回退默认值；
//     JSON 合法但个别字段类型不对 → 只把坏字段回退，好字段保留。
//   - write() 部分更新 + 原子写（临时文件 + rename）；
//     实例内用串行队列包住「读-改-写」，并发调用不丢字段。
//   - 存图模式 只认 'both' | 'text' | 'image'，其它值一律回退 'both'。
//   - 零第三方依赖，只用 Node 内置能力。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const SETTINGS_VERSION = 1;

/** 存图模式三档：both=原图+文字描述；text=只存文字描述；image=只存原图。 */
export const VALID_MODES = ['both', 'text', 'image'];

/** 默认配置。read() 返回的永远是拷贝，调用方随便改也不会污染这里。 */
const DEFAULTS = Object.freeze({
  version: SETTINGS_VERSION,
  '存图模式': 'both',
  // ⭐ 2026-11-03：私聊/群聊分开设档。
  //   空串 = 跟随上面那个总开关 —— 老配置没有这两个键时自动就是这个值，
  //   行为跟改之前完全一样（不迁移、不丢设置）。
  '私聊存图模式': '',
  '群聊存图模式': '',
  '启用私聊': true,
  '启用群聊': false,
  '记私聊聊天': true,
  '记群聊聊天': true,
  '定时拉取': true,
  '拉取间隔秒': 60,
  '库目录': '',
  // ⭐ 2026-11-03：日记库目录（只读）。留空 = 不启用日记检索，
  // memory_recall 会自动退回「只搜记忆仓库」。
  // 为什么不写死 ~/.dsh/xiaoyu-diary：别的用户可能没装日记插件，
  // 或者装在不同位置。留空让功能自动降级，比装个路径进来让人排查半天好。
  '日记库目录': '',
  '允许的插件': [],
  // ⭐ 2026-11-02：首次安装自动回填历史聊天记录（只跑一次，跑完写标记）
  '首次回填': true,
  '回填条数': 500,
});

/** write() 只认这四个键（version 由本模块维护，不接受外部改）。 */
const WRITABLE_KEYS = ['存图模式', '私聊存图模式', '群聊存图模式', '启用私聊', '启用群聊', '记私聊聊天', '记群聊聊天', '定时拉取', '拉取间隔秒', '库目录', '日记库目录', '允许的插件', '首次回填', '回填条数'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 洗「私聊存图模式 / 群聊存图模式」这两个分档字段。
 * 空串是合法值，意思是「跟随总开关」；非法值一律回退空串（= 跟随），
 * 而不是像总开关那样回退 'both' —— 否则用户写错一个词就把「只存文字」悄悄变成「存原图」。
 */
function 洗分档(v) {
  if (v === undefined || v === null || v === '') return '';
  return VALID_MODES.includes(v) ? v : '';
}

/**
 * 「允许的插件」白名单：只接受字符串数组，过滤非字符串项，每项 trim 后丢掉空串。
 * 返回的永远是新建数组，不会引用到 DEFAULTS / 调用方传入的对象。
 */
function 洗插件名单(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s !== '') out.push(s);
  }
  return out;
}

/**
 * 把任意来源的原始数据洗成合法配置：
 * - 缺字段 / 类型不对的字段 → 用默认值补上（存图模式非法值回退 'both'）；
 * - version 固定为 SETTINGS_VERSION。
 */
function sanitize(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    version: SETTINGS_VERSION,
    '存图模式': VALID_MODES.includes(src['存图模式']) ? src['存图模式'] : DEFAULTS['存图模式'],
    // 两个分档：空串（跟随总开关）或合法档位都收；其它值 → 回退空串（跟随），不静默改成某个具体档
    '私聊存图模式': 洗分档(src['私聊存图模式']),
    '群聊存图模式': 洗分档(src['群聊存图模式']),
    '启用私聊': typeof src['启用私聊'] === 'boolean' ? src['启用私聊'] : DEFAULTS['启用私聊'],
    '启用群聊': typeof src['启用群聊'] === 'boolean' ? src['启用群聊'] : DEFAULTS['启用群聊'],
    记私聊聊天: typeof src['记私聊聊天'] === 'boolean' ? src['记私聊聊天'] : DEFAULTS['记私聊聊天'],
    记群聊聊天: typeof src['记群聊聊天'] === 'boolean' ? src['记群聊聊天'] : DEFAULTS['记群聊聊天'],
    定时拉取: typeof src['定时拉取'] === 'boolean' ? src['定时拉取'] : DEFAULTS['定时拉取'],
    拉取间隔秒: (Number.isFinite(Number(src['拉取间隔秒'])) && Number(src['拉取间隔秒']) >= 10) ? Math.min(Math.round(Number(src['拉取间隔秒'])), 3600) : DEFAULTS['拉取间隔秒'],
    '库目录': typeof src['库目录'] === 'string' ? src['库目录'] : DEFAULTS['库目录'],
    '日记库目录': typeof src['日记库目录'] === 'string' ? src['日记库目录'] : DEFAULTS['日记库目录'],
    '允许的插件': 洗插件名单(src['允许的插件']),
  };
}

/** 把 partial 按字段校验后叠到 current 上；只更新传入的合法键，其余保持不动。 */
function applyPartial(current, partial) {
  const next = { ...current };
  if (!isPlainObject(partial)) return next;
  for (const key of WRITABLE_KEYS) {
    if (!(key in partial)) continue;
    switch (key) {
      case '存图模式':
        // 硬性校验：非法值回退 'both'（哪怕当前存的是别的合法档位）
        next[key] = VALID_MODES.includes(partial[key]) ? partial[key] : DEFAULTS['存图模式'];
        break;
      case '私聊存图模式':
      case '群聊存图模式':
        // 空串合法（= 跟随总开关）；非法值忽略，保留当前值
        if (partial[key] === '' || VALID_MODES.includes(partial[key])) next[key] = 洗分档(partial[key]);
        break;
      case '启用私聊':
      case '启用群聊':
      case '记私聊聊天':
      case '记群聊聊天':
      case '定时拉取':
        // 非布尔值 → 忽略该字段，保留当前值（少意外，不静默重置）
        if (typeof partial[key] === 'boolean') next[key] = partial[key];
        break;
      case '拉取间隔秒': {
        const n = Number(partial[key])
        if (Number.isFinite(n) && n >= 10) next[key] = Math.min(Math.round(n), 3600)
        break
      }
      case '库目录':
        // 相对路径或空串都允许；非字符串 → 忽略
        if (typeof partial[key] === 'string') next[key] = partial[key];
        break;
      case '日记库目录':
        // 同 库目录：相对路径或空串都允许
        if (typeof partial[key] === 'string') next[key] = partial[key];
        break;
      case '允许的插件':
        // 字符串数组原样洗后收下；逗号分隔字符串拆成数组；其它类型 → 忽略，保留当前值
        if (Array.isArray(partial[key])) {
          next[key] = 洗插件名单(partial[key]);
        } else if (typeof partial[key] === 'string') {
          next[key] = 洗插件名单(partial[key].split(','));
        }
        break;
    }
  }
  return next;
}

/** createSettings({ configPath }) → { read(), write(partial), describe() } */
export function createSettings({ configPath } = {}) {
  if (typeof configPath !== 'string' || configPath.trim() === '') {
    throw new Error('createSettings: 缺少 configPath（配置 JSON 文件的路径）');
  }

  // 串行队列：并发 write 排队执行，每次执行都重新读盘，先到的改动不会被后到的覆盖丢掉。
  let queue = Promise.resolve();
  let writeSeq = 0;
  let lastKnown = null; // describe() 用来展示最近一次读/写到的配置

  /** 直接读盘并洗成合法配置；任何异常都吞掉回默认值，绝不外抛。 */
  async function readFromDisk() {
    try {
      const text = await readFile(configPath, 'utf8');
      return sanitize(JSON.parse(text));
    } catch {
      // 文件不存在 / 损坏 / 不是 JSON 对象 → 整体默认值
      return sanitize({});
    }
  }

  async function doWrite(partial) {
    const current = await readFromDisk();
    const next = applyPartial(current, partial);
    const dir = dirname(configPath);
    await mkdir(dir, { recursive: true });
    // 原子写：临时文件 + rename；临时名带 pid/时间戳/序号，杜绝同名互踩
    const tmpPath = join(dir, `${basename(configPath)}.tmp-${process.pid}-${Date.now()}-${writeSeq++}`);
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmpPath, configPath);
    lastKnown = next;
    return next;
  }

  return {
    /** 读完整配置；文件不存在或损坏时返回默认值，绝不抛异常。 */
    async read() {
      const cfg = await readFromDisk();
      lastKnown = cfg;
      return cfg;
    },

    /** 部分更新：只改传入的字段；原子写；返回更新后的完整配置。 */
    write(partial) {
      const run = queue.then(() => doWrite(partial));
      // 某次失败不能卡死后续排队（失败本身仍会抛给对应调用方）
      queue = run.catch(() => {});
      return run;
    },

    /**
     * 给人看的配置说明（同步、非空）：三档模式各存什么、占什么代价，
     * 外加最近一次读/写到的配置快照。
     */
    describe() {
      const lines = [
        `【dsh-memory-vault-v2 配置】文件：${configPath}`,
        '存图模式三档（修改：POST /dsh-memory-vault/settings，body 传要改的字段）：',
        '  both  —— 原图 + 文字描述都存。适合已有看图模型（能把图翻译成文字）的用户。',
        '           代价：磁盘占用最大；图片按内容去重，但每张图都要落盘。',
        '  text  —— 只存文字描述，不存原图。适合没有看图模型的用户。',
        '           代价：磁盘占用最小；原图不留底，事后无法恢复出图。',
        '  image —— 只存原图，不要文字描述。适合只想留底、不按文字搜图的场景。',
        '           代价：磁盘占用大；没有文字可检索。',
        '',
      ];
      if (lastKnown) {
        lines.push(
          `当前配置：存图模式=${lastKnown['存图模式']}｜启用私聊=${lastKnown['启用私聊'] ? '开' : '关'}` +
            `｜启用群聊=${lastKnown['启用群聊'] ? '开' : '关'}｜库目录=${lastKnown['库目录'] === '' ? '（未设置）' : lastKnown['库目录']}`,
        );
      } else {
        lines.push('当前配置：尚未读取，调用 read() 后这里会显示快照。');
      }
      return lines.join('\n');
    },
  };
}
