// ============================================================================
// recall-extract.js —— 用外部工具把各种文档转成文本（可选增强）
//
// 【这个模块负责什么】
//   调用 Microsoft MarkItDown（如果你装了的话），把 PDF / Word / Excel / PPT /
//   EPUB / HTML / CSV 这些**我们的代码转不动的**格式转成 Markdown 文本，
//   再交给 recall-import 切成日记条目。
//
// 【为什么这样设计】
//   · 为什么不自己写：PDF/Word/Excel 的解析是巨大工程（每家的二进制格式都不
//     一样），自己写只会写出一堆「大部分情况下能用」的代码。MarkItDown
//     有 19 万 star、MIT、微软维护，这件事上直接依赖成熟实现是理性的选择。
//
//   · 为什么是「可选」而不是硬依赖：它是 Python 包，装它要 Python 3.10+
//     和一批依赖。让一个念日记的插件强制要求 Python 环境是荒谬的。
//     所以：装了就用，没装就给出明确的安装指引，功能降级但不报错。
//
//   · 为什么走 CLI 而不是 Python API：跨进程调用是唯一解耦方式。
//     不引入 Python 脚本文件、不用管 Python 依赖版本、崩了也不会拖垮
//     Node 进程。代价是每次调用有几十毫秒的启动开销 —— 导入是低频操作，
//     这个代价完全可以接受。
//
//   · 为什么 JSON/CSV 就不必走它：JSON 我们自己解析更准（能拿到字段结构）；
//     CSV 虽然它转得好，但结构简单的 CSV 我们自己也能切。它真正的价值
//     在 PDF/Word/Excel 这些我们根本啃不动的格式上。
//
// 【对外导出】
//   · 探测转换器(选项) —— 找得到 MarkItDown 吗，返回路径与版本
//   · 需要外部转换(文件) —— 这个扩展名要不要走外部工具
//   · 转换(文件, 选项) —— 真正执行转换，返回文本
// ============================================================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'
import path from 'node:path'

const exec文件 = promisify(execFile)

/**
 * 需要外部工具才能读的扩展名。
 *
 * 这里只放「我们自己的解析器确实处理不了」的：
 *   · PDF  —— 二进制 + 压缩流 + 字体编码，没法自己读
 *   · DOCX —— zip 包 + XML，理论能读但表格/样式会丢
 *   · XLSX —— 同上，还要处理公式与共享字符串
 *   · PPTX —— 同上
 *   · EPUB —— zip + XHTML
 *   · HTML —— 虽然是文本，但带标签，直接进检索库会污染分词
 *
 * 不包含 .json/.md/.txt/.csv：这些我们自己处理得更准或足够好。
 */
export const 需外部转换 = new Set([
  '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
  '.epub', '.html', '.htm', '.rtf', '.odt', '.ods', '.odp',
])

/**
 * 这个文件要不要走外部转换。
 *
 * @param {string} 文件
 * @returns {boolean}
 */
export function 需要外部转换 (文件) {
  return 需外部转换.has(path.extname(String(文件 || '')).toLowerCase())
}

/** 探测结果缓存（探测要起子进程，不必每次都跑）。 */
let 探测缓存 = null
const 探测有效期毫秒 = 5 * 60 * 1000

/**
 * 探测 MarkItDown 是否可用。
 *
 * 按优先级试三种调用方式：
 *   ① `markitdown` 命令（pip install 后通常有这个入口）
 *   ② `python3 -m markitdown`（只装了模块、没建脚本链接时）
 *   ③ `python -m markitdown`（有些环境只有 python 没有 python3）
 *
 * 为什么要试三种：实测同机器上 `pip install` 之后 `markitdown` 命令
 * **不一定**出现在 PATH 里（取决于 pip 的 --user / venv 情况），
 * 但 `python3 -m markitdown` 依然可用。只认第一种会误判成「没装」。
 *
 * @param {{强制?: boolean}} [选项]
 * @returns {Promise<{ok: boolean, 命令: string[], 版本: string, 原因: string}>}
 */
export async function 探测转换器 (选项 = {}) {
  const 现在 = Date.now()
  if (!选项.强制 && 探测缓存 && 现在 - 探测缓存.时间 < 探测有效期毫秒) return 探测缓存.值

  const 候选 = [
    ['markitdown'],
    ['python3', '-m', 'markitdown'],
    ['python', '-m', 'markitdown'],
  ]
  const 失败们 = []
  let 结果 = { ok: false, 命令: [], 版本: '', 原因: '' }

  for (const 命令 of 候选) {
    try {
      const { stdout } = await exec文件(命令[0], [...命令.slice(1), '--help'], {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
        // 不设 shell：避免命令注入（文件名会被当参数传，不能进 shell）
        windowsHide: true,
      })
      if (/markitdown|MarkItDown/i.test(String(stdout || ''))) {
        结果 = { ok: true, 命令, 版本: '', 原因: `可用：${命令.join(' ')}` }
        break
      }
      失败们.push(`${命令.join(' ')}: 输出里没有 markitdown 字样`)
    } catch (e) {
      // 命令不存在 / 模块没装 / 超时，都记下来试下一个
      失败们.push(`${命令.join(' ')}: ${String(e?.code || e?.message || e).slice(0, 60)}`)
    }
  }

  if (!结果.ok) {
    结果 = {
      ok: false,
      命令: [],
      版本: '',
      原因: '没找到 MarkItDown。安装：pip install "markitdown[all]"（需要 Python 3.10+）。' +
        '细节：' + 失败们.join('；'),
    }
  }
  探测缓存 = { 时间: 现在, 值: 结果 }
  return 结果
}

/** 清探测缓存（测试用）。 */
export function 清探测缓存 () {
  探测缓存 = null
}

/**
 * 用外部工具把文件转成文本。
 *
 * @param {string} 文件 绝对或相对路径
 * @param {{超时毫秒?: number, 最大字节?: number}} [选项]
 * @returns {Promise<{ok: boolean, 文本: string, 错误: string}>}
 */
export async function 转换 (文件, 选项 = {}) {
  const p = String(文件 || '').trim()
  if (!p) return { ok: false, 文本: '', 错误: '缺少文件路径' }

  try {
    const st = await stat(p)
    if (!st.isFile()) return { ok: false, 文本: '', 错误: '不是一个文件' }
    // 大文件保护：一个 200MB 的 PDF 转出来可能是几十万字，
    // 进检索库会把整个索引撑爆，也会让一次导入跑很久。
    const 上限字节 = Number(选项.最大字节) > 0 ? Number(选项.最大字节) : 50 * 1024 * 1024
    if (st.size > 上限字节) {
      return { ok: false, 文本: '', 错误: `文件太大（${(st.size / 1048576).toFixed(1)}MB > ${(上限字节 / 1048576).toFixed(0)}MB 上限）` }
    }
  } catch (e) {
    return { ok: false, 文本: '', 错误: `读不了文件：${e?.message || e}` }
  }

  const 探 = await 探测转换器()
  if (!探.ok) return { ok: false, 文本: '', 错误: 探.原因 }

  const 超时 = Number(选项.超时毫秒) > 0 ? Number(选项.超时毫秒) : 120000
  try {
    const { stdout } = await exec文件(探.命令[0], [...探.命令.slice(1), p], {
      timeout: 超时,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    })
    const 文本 = String(stdout || '')
    if (!文本.trim()) return { ok: false, 文本: '', 错误: '转换结果为空（文件可能是纯图片扫描件，需要 OCR）' }
    return { ok: true, 文本, 错误: '' }
  } catch (e) {
    // stderr 里的 cpuinfo/onnxruntime 噪音是常态，不该当作错误信息展示
    const 详情 = 剥噪音(String(e?.stderr || e?.message || e))
    return { ok: false, 文本: '', 错误: `转换失败：${详情 || '未知错误'}` }
  }
}

/**
 * 剥掉 MarkItDown 启动时的 CPU 探测噪音。
 *
 * 那些行来自 onnxruntime / py-cpuinfo，每次调用都会打，与转换结果无关。
 * 原样带进错误信息会让用户以为转换出了问题。
 *
 * @param {string} 文
 * @returns {string}
 */
export function 剥噪音 (文) {
  return String(文 || '')
    .split('\n')
    .filter((l) => l.trim())
    .filter((l) => !/cpuinfo|onnxruntime|Failed to initialize|Unknown CPU vendor/i.test(l))
    .slice(0, 6)
    .join('；')
}
