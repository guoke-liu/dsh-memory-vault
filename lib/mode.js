// ============================================================================
// mode.js —— 三档存图模式的实际执行
//
// 【三档干什么】
//   both  —— 原图 + 文字描述（有视觉模型的用户）
//   text  —— 只存文字，**原图绝不落盘**（没视觉模型的用户，最省磁盘）
//   image —— 只存原图，不要文字
//
// 【改这个文件前先知道】
//   · text 模式下原图字节**仍然要过一遍**（算 sha256 用于去重），但算完立刻丢
//   · 描述可以由外部描述器自动生成（describer 参数），没传就不会自动产生
//   · 实测：同一张 796KB 的图，text 模式只占 494 字节
// ============================================================================

// 存图模式的实际执行：把「存图模式」翻译成「这次到底落盘什么」。
//
// 三档（开源给所有人用，所以每档都要真的生效）：
//   both  —— 原图落盘 + 文字描述落盘
//   text  —— 只落文字描述，原图不落盘（没翻译系统的用户，最省磁盘）
//   image —— 只落原图，不要文字描述
//
// 关键点：text 模式下「原图字节」仍然要参与 sha256 计算（否则同一张图无法去重），
// 但算完之后立刻丢弃，不写进 objects/。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { archiveImage } from './archive.js'

const 说明文件 = 'descriptions.json'

async function 读描述(rootDir) {
  try {
    const d = JSON.parse(await readFile(join(rootDir, 说明文件), 'utf8'))
    if (d && typeof d === 'object' && d.images && typeof d.images === 'object') return d
  } catch {}
  return { version: 1, nextNo: 1, images: {} }
}

async function 写描述(rootDir, d) {
  await mkdir(rootDir, { recursive: true })
  const 最终 = join(rootDir, 说明文件)
  const 临时 = 最终 + '.tmp-' + process.pid + '-' + Date.now()
  await writeFile(临时, JSON.stringify(d, null, 1))
  await rename(临时, 最终)
}

/** 文字描述的 sha256（和图片一样按内容去重） */
function 文本指纹(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * 按模式归档。
 *
 * @param {string} rootDir
 * @param {object} args
 * @param {Buffer} args.bytes        原图字节（text 模式下也要传，用于算指纹去重）
 * @param {string} [args.description] 文字描述（看图模型翻译出来的；没有就传空）
 * @param {string} args.mode         'both' | 'text' | 'image'
 * @param {object} [args.meta]       透传给 archiveImage 的元信息
 * @param {{describe: Function, hasCustom: Function}} [args.describer]
 *   createDescriber 的返回值。mode 是 both/text 且没传 description（或空串）时，
 *   用它自动生成描述；没传则保持旧行为（没描述就不存文字）。
 * @returns {Promise<{no:number|null, sha256:string, storedImage:boolean, storedText:boolean, deduped:boolean, refCount:number, textNo:number|null}>}
 */
export async function 按模式归档(rootDir, { bytes, description, mode, meta = {}, describer }) {
  const 模式 = ['both', 'text', 'image'].includes(mode) ? mode : 'both'
  const 要图 = 模式 === 'both' || 模式 === 'image'
  // 没传 description（或空串）时，both/text 模式可让 describer 自动生成
  const 缺描述 = (模式 === 'both' || 模式 === 'text') &&
    !(typeof description === 'string' && description.trim() !== '')
  let 描述文本 = typeof description === 'string' && description.trim() !== '' ? description : null
  if (缺描述 && describer && typeof describer.describe === 'function') {
    描述文本 = await describer.describe(bytes, meta)
  }
  const 要文 = (模式 === 'both' || 模式 === 'text') && 描述文本 != null

  const 结果 = {
    no: null, sha256: '', storedImage: false, storedText: false,
    deduped: false, refCount: 0, textNo: null,
  }

  // 图：要图才走 archiveImage（它会落盘原图）
  if (要图) {
    const r = await archiveImage(rootDir, bytes, meta)
    结果.no = r.no
    结果.sha256 = r.sha256
    结果.storedImage = true
    结果.deduped = r.deduped
    结果.refCount = r.refCount
  } else if (Buffer.isBuffer(bytes) && bytes.length) {
    // text 模式：算指纹用于去重，但绝不落盘原图
    结果.sha256 = createHash('sha256').update(bytes).digest('hex')
  }

  // 文：要文才写 descriptions.json
  if (要文) {
    const d = await 读描述(rootDir)
    const 指纹 = 文本指纹(description)
    let e = d.images[指纹]
    if (e) {
      e.refs = (e.refs || [])
      e.refs.push({ messageId: meta.messageId, pid: meta.pid, time: meta.time ?? Date.now() })
      e.lastSeen = Date.now()
      结果.deduped = true
    } else {
      const no = d.nextNo
      d.nextNo = no + 1
      d.images[指纹] = {
        no,
        text: String(描述文本),
        sha256: 指纹,
        imageSha: 结果.sha256 || null,  // 关联到原图（image 模式下可能没有）
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        refs: [{ messageId: meta.messageId, pid: meta.pid, time: meta.time ?? Date.now() }],
      }
    }
    await 写描述(rootDir, d)
    结果.storedText = true
    // 如果没存图，编号就用文字编号
    if (结果.no == null) 结果.no = d.images[指纹].no
    结果.textNo = d.images[指纹].no
  }

  return 结果
}

/** 读文字描述库 */
export async function 读文字库(rootDir) {
  return 读描述(rootDir)
}
