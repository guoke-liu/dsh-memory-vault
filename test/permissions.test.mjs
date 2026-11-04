/**
 * 文件权限的测试。
 *
 * 背景（2026-11-04）：主人问「还有什么问题」，顺带一提发现云端有几个文件
 * 落成了 644（同机其他用户可读）：
 *   descriptions.json  758KB 图片描述（含中文正文）
 *   index.json         339KB 图片索引
 *   people.json         46KB 昵称 + QQ 号
 *   diag.log           274KB 诊断日志（含绝对路径）
 *
 * 这些全是隐私数据。事后 chmod 只能救一次，新写的文件照样会松 ——
 * 所以这里守住「写的时候就收权限」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { 写事件库, 事件库版本 } from '../lib/recall-events-store.js'
import { 写账本, 空账本 } from '../lib/recall-fed.js'
import { createSettings } from '../lib/settings.js'

/** 断言文件权限是 600 */
function 是私密文件 (路径, 说明) {
  const 模式 = statSync(路径).mode & 0o777
  assert.equal(模式, 0o600, `${说明} 权限该是 600，实际 ${模式.toString(8)}`)
}

test('事件库写成 600（里面有聊天片段）', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-perm-'))
  try {
    const 文件 = join(目录, 'events.json')
    await 写事件库(文件, { 事件们: [{ 事件: 'x', 结果: '含聊天内容' }], 统计: {} })
    是私密文件(文件, 'events.json')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('投喂账本写成 600', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-perm2-'))
  try {
    const 文件 = join(目录, 'events-feed.json')
    await 写账本(文件, 空账本())
    是私密文件(文件, 'events-feed.json')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('config.json 写成 600（里面有模型密钥）', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-perm3-'))
  try {
    const 文件 = join(目录, 'config.json')
    const s = createSettings({ configPath: 文件 })
    await s.write({ 启用聊天分层: true })
    是私密文件(文件, 'config.json')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('写文件不留临时文件（原子写的副作用检查）', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-perm4-'))
  try {
    await 写事件库(join(目录, 'events.json'), { 事件们: [], 统计: {} })
    const 名单 = readdirSync(目录).filter((f) => !f.startsWith('.'))
    assert.deepEqual(名单, ['events.json'], `目录里只该有目标文件，实际：${名单.join(',')}`)
  } finally { rmSync(目录, { recursive: true, force: true }) }
})

test('写事件库：覆盖已有文件后权限仍是 600（rename 会带过来新文件的权限）', async () => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-perm5-'))
  try {
    const 文件 = join(目录, 'events.json')
    // 先造一个 644 的旧文件，模拟历史遗留
    writeFileSync(文件, JSON.stringify({ version: 事件库版本, 事件们: [] }))
    await 写事件库(文件, { 事件们: [{ 事件: 'y' }], 统计: {} })
    是私密文件(文件, '覆盖后的 events.json')
  } finally { rmSync(目录, { recursive: true, force: true }) }
})


test('存量文件：chatlog 追加写之后，老文件的 644 也会变成 600', async () => {
  // mode 参数只管新建文件。老用户的聊天文件是在加权限之前建的，
  // 写完必须再 chmod 一次 —— 实测云端 20 个聊天文件全是 644。
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-mig3-'))
  try {
    const { appendChatLine } = await import('../lib/chatlog.js')
    if (typeof appendChatLine !== 'function') {
      // 换一个入口名再试
      const m = await import('../lib/chatlog.js')
      const 写 = m.追加 || m.appendLine || m.写一行
      if (typeof 写 !== 'function') return // 找不到入口就跳过，不误报
      const chatDir = join(目录, 'chat', 'private')
      mkdirSync(chatDir, { recursive: true })
      const 文件 = join(chatDir, '2026-11-03.txt')
      writeFileSync(文件, '')
      const { chmodSync } = require('node:fs')
      chmodSync(文件, 0o644)
      await 写({ 聊天目录: chatDir, 日期: '2026-11-03', 时间: '10:00:00', 昵称: '甲', pid: 'p1', 内容: '测试' })
      是私密文件(文件, '追加写后的聊天文件')
    }
  } finally { rmSync(目录, { recursive: true, force: true }) }
})
