/**
 * 事件提炼档位的设置测试。
 *
 * 背景（2026-11-04）：主人问「把一整天聊天喂给大模型要多少 token」，
 * 实测 71,506 token/天（全部来源）。于是做成三档让用户自己选：
 *   full     = 全量原始聊天，约 7 万 token/天
 *   screened = 规则筛过再喂，约 2 万 token/天（默认）
 *   core     = 只喂核心，约 2 千 token/天
 *
 * 这个设置最容易出的错是**三处校验不同步**（默认值 / 写入 / 读取）。
 * 漏一处就是静默失效：
 *   · 漏了写入校验 → 存进一个拼错的档位，运行时查不到就按最贵的跑
 *   · 漏了读取兜底 → 老配置没有这个键，读出来是 undefined，下游崩
 * 所以这里逐条守住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSettings } from '../lib/settings.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 在临时目录造一份设置，测完删干净 —— 绝不碰真实配置 */
function 建临时设置 (t) {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-settings-'))
  t.after(() => rmSync(目录, { recursive: true, force: true }))
  return createSettings({ configPath: join(目录, 'config.json') })
}

const 合法档位 = ['full', 'screened', 'core']

test('默认档位是 screened（规则筛过再喂）', async (t) => {
  const s = 建临时设置(t)
  const cfg = await s.read()
  assert.equal(cfg.事件提炼档位, 'screened')
})

test('三个合法档位都能写入并读回', async (t) => {
  const s = 建临时设置(t)
  for (const 档 of 合法档位) {
    await s.write({ 事件提炼档位: 档 })
    assert.equal((await s.read()).事件提炼档位, 档, `写入 ${档} 后读回不一致`)
  }
})

test('非法档位被拒绝，不会覆盖已有值', async (t) => {
  const s = 建临时设置(t)
  await s.write({ 事件提炼档位: 'core' })

  for (const 坏 of ['FULL', 'fulll', '', 'screened ', 123, null, {}, []]) {
    await s.write({ 事件提炼档位: 坏 })
    assert.equal(
      (await s.read()).事件提炼档位,
      'core',
      `非法值 ${JSON.stringify(坏)} 被写进去了 —— 运行时查不到会落到最贵那档`,
    )
  }
})

test('配置文件里已经是非法值时，读取要兜底成默认', async (t) => {
  const 目录 = mkdtempSync(join(tmpdir(), 'mv-settings-'))
  t.after(() => rmSync(目录, { recursive: true, force: true }))
  const 路径 = join(目录, 'config.json')
  const { writeFileSync, readFileSync } = await import('node:fs')

  // 模拟「有人手工改了 config.json」——直接写入一个非法档位
  writeFileSync(路径, JSON.stringify({ version: 1, 事件提炼档位: '拼错的档位' }), 'utf8')
  // 先确认文件里确实是那个非法值（否则这个用例什么都没验到）
  assert.equal(JSON.parse(readFileSync(路径, 'utf8')).事件提炼档位, '拼错的档位')

  const s = createSettings({ configPath: 路径 })
  const cfg = await s.read()
  assert.equal(cfg.事件提炼档位, 'screened', '读到非法档位时必须兜底成默认，不能原样透传')
})

test('老配置（完全没有这个键）读出来等于默认值', async (t) => {
  const s = 建临时设置(t)
  const cfg = await s.read()
  // 全新的配置文件本来就没有这个键，读到必须有值而不是 undefined
  assert.ok(Object.hasOwn(cfg, '事件提炼档位'), '读出来的配置里没有这个键')
  assert.equal(cfg.事件提炼档位, 'screened')
  assert.notEqual(cfg.事件提炼档位, undefined)
})

test('改档位不会影响其他设置', async (t) => {
  const s = 建临时设置(t)
  const 前 = await s.read()
  await s.write({ 事件提炼档位: 'full' })
  const 后 = await s.read()

  for (const k of Object.keys(前)) {
    if (k === '事件提炼档位') continue
    assert.deepEqual(后[k], 前[k], `改档位时 ${k} 被动过了`)
  }
})

test('脱敏时档位不被遮掩（它不是敏感字段）', async (t) => {
  const s = 建临时设置(t)
  await s.write({ 事件提炼档位: 'core' })
  const cfg = await s.read()
  assert.equal(cfg.事件提炼档位, 'core', '档位不该被脱敏成 ***')
})
