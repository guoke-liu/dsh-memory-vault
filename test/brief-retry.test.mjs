/**
 * 重新投喂的端到端测试（用假模型服务，不花钱、不联网）。
 *
 * 背景（2026-11-04）：主人要求「用户对某天投喂不满意时能手动重新投喂」。
 *
 * 这里验的是完整链路：预览 → 扣账 → 重喂 → 重新记账 → 下次跳过。
 * 每一条都是真跑一遍分层流程，不是只测单个函数 ——
 * 投喂账本的价值全在「链路串起来之后对不对」，单函数全绿也可能整体串错。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { 跑分层 } from '../lib/recall-ingest.js'
import { 已投喂 } from '../lib/recall-fed.js'

/** 假模型：按 prompt 里的消息编号数返回对应条数的结果 */
let 服务
let 端口
let 请求次数 = 0

before(async () => {
  服务 = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      请求次数 += 1
      const n = (body.match(/\n\s*\d+[.、]/g) || []).length || 1
      const 结果 = Array.from({ length: n }, (_, i) => ({ i: i + 1, 层级: 2, 分: 6 }))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(结果) } }] }))
    })
  })
  await new Promise((ok) => 服务.listen(0, '127.0.0.1', ok))
  端口 = 服务.address().port
})

after(() => {
  try { 服务.close() } catch { /* 已关 */ }
})

/** 造一个只有两天聊天的临时仓库 */
function 造仓库 () {
  const 根 = mkdtempSync(join(tmpdir(), 'mv-retry-'))
  const chat = join(根, 'chat', 'private')
  mkdirSync(chat, { recursive: true })
  writeFileSync(join(chat, '2026-11-01.txt'),
    '[10:00:00] 甲(p1): 我们决定把端口改到 8080 记得改配置\n'
    + '[10:01:00] 乙(p2): 好的我下午处理这件事\n')
  writeFileSync(join(chat, '2026-11-02.txt'),
    '[11:00:00] 甲(p1): 明天要交报告别忘了备份数据库\n'
    + '[11:05:00] 乙(p2): 收到我记在日历上了\n')
  return { 根, 输出: join(根, 'levels.json') }
}

/** 跑一次分层的简写 */
async function 跑 (env, extra = {}) {
  return 跑分层({
    仓库根: env.根,
    输出文件: env.输出,
    用模型: true,
    模型配置: { baseURL: `http://127.0.0.1:${端口}/v1`, apiKey: 'x', model: 't', 批大小: 10, 批间隔毫秒: 0 },
    投喂档位: 'screened',
    日志: () => {},
    ...extra,
  })
}

/** 读分层库里 screened 档的记账条数 */
function 账数 (env) {
  const d = JSON.parse(readFileSync(env.输出, 'utf8'))
  return Object.keys(d.投喂账本.按档位.screened).length
}

test('首次投喂后记账，再跑一遍全部跳过', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))

  const 一 = await 跑(env)
  assert.equal(一.模型.处理数, 4, '四条消息都该喂')
  assert.equal(账数(env), 4)

  const 二 = await 跑(env)
  assert.equal(二.模型.处理数, 0, '第二次不该再喂')
  assert.equal(二.模型.跳过数, 4, '应该报跳过 4 条')
})

test('预览：算清楚要重喂多少条，但不真跑、不改账本', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)

  const 前 = 账数(env)
  const 调前 = 请求次数
  const r = await 跑(env, { 重新投喂: '2026-11-02', 只预览: true })

  assert.equal(r.ok, true)
  assert.equal(r.预览, true)
  assert.equal(r.重新投喂.消息数, 2, '11-02 有 2 条消息')
  assert.equal(r.重新投喂.可扣账, 2, '两条都已记过账')
  assert.equal(r.重新投喂.日期数, 1)
  assert.equal(账数(env), 前, '预览不能改账本')
  assert.equal(请求次数, 调前, '预览不能真调模型')
})

test('真正重喂那天：只重喂那天，不动别的日子', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)

  const r = await 跑(env, { 重新投喂: '2026-11-02' })
  assert.equal(r.模型.处理数, 2, '只该重喂 11-02 的 2 条')
  assert.equal(r.模型.重新投喂.扣掉, 2, '扣掉 2 条旧记账')
  assert.equal(r.模型.重新投喂.起, '2026-11-02')
  assert.equal(账数(env), 4, '重喂成功后重新记账，总数不变')
})

test('重喂之后再跑：全部跳过（账本被正确重建了）', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)
  await 跑(env, { 重新投喂: '2026-11-02' })

  // 这一步是关键：如果重喂靠「绕过账本」，这里的 11-02 会再次被喂
  const 三 = await 跑(env)
  assert.equal(三.模型.处理数, 0, '重喂过的消息必须重新记上账')
  assert.equal(三.模型.跳过数, 4)
})

test('重喂区间：两天一起重来', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)

  const r = await 跑(env, { 重新投喂: '2026-11-01..2026-11-02' })
  assert.equal(r.模型.处理数, 4, '区间内所有消息都重喂')
  assert.equal(r.模型.重新投喂.日期数, 2)
  assert.equal(账数(env), 4)
})

test('重喂没喂过的日期：不扣账，也不报错', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)

  // 11-03 没有任何聊天
  const r = await 跑(env, { 重新投喂: '2026-11-03' })
  assert.equal(r.ok, true, '没数据的日期不该报错')
  assert.equal(r.模型.重新投喂.消息数, 0)
  assert.equal(r.模型.重新投喂.扣掉, 0)
})

test('非法日期写法：整个流程失败，不猜、不花钱', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)

  const 调前 = 请求次数
  const r = await 跑(env, { 重新投喂: '11月2号' })
  assert.equal(r.ok, false, '写法不认必须失败')
  assert.match(String(r.错误), /看不懂|日期/)
  assert.equal(请求次数, 调前, '失败时一条都不该调模型')
  assert.equal(账数(env), 4, '失败不能扣账')
})

test('重喂只影响当前档位，别的档位记账保留', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))

  await 跑(env, { 投喂档位: 'core' })
  await 跑(env, { 重新投喂: '2026-11-02', 投喂档位: 'screened' })

  const d = JSON.parse(readFileSync(env.输出, 'utf8'))
  assert.equal(Object.keys(d.投喂账本.按档位.core).length, 4, 'core 档的记账不该被 screened 的重喂影响')
})

test('重喂后账本里保留其他档位的记录', async (t) => {
  const env = 造仓库()
  t.after(() => rmSync(env.根, { recursive: true, force: true }))
  await 跑(env)

  const { 读账本 } = await import('../lib/recall-fed.js')
  const 库 = JSON.parse(readFileSync(env.输出, 'utf8'))
  const 账 = 读账本(库)
  // 任意一条 11-01 的消息：重喂 11-02 之后它还应该记着
  const 全部 = Object.keys(账.按档位.screened)
  await 跑(env, { 重新投喂: '2026-11-02' })
  const 库2 = JSON.parse(readFileSync(env.输出, 'utf8'))
  const 账2 = 读账本(库2)
  assert.equal(Object.keys(账2.按档位.screened).length, 全部.length, '总数应保持一致')
})

test('没配模型时要求重新投喂：直接报错，不偷偷跑规则分层', async () => {
  // 实测踩过（2026-11-04）：只传了「重新投喂」但没配模型，
  // 代码照常跑了规则分层、一声不响写了一遍库。
  // 用户以为重喂了某天，实际什么都没重喂，却改动了真实数据。
  const { 注册AI工具 } = await import('../lib/tools.js')
  const 注册表 = []
  注册AI工具({
    defineTool: (t) => t,
    ctx: { tools: { register (t) { 注册表.push(t) } } },
    rootDir: () => '/tmp/nonexistent-vault-retry',
    diaryRootDir: () => '/tmp/nonexistent-diary-retry',
    配置目录: '/tmp/nonexistent-vault-retry',
    读设置: async () => ({ 事件提炼档位: 'screened' }), // 没有任何模型配置
    log: () => {},
  })
  const t = 注册表.find((x) => x.name === 'memory_score_chats')
  assert.ok(t, '找不到 memory_score_chats')

  for (const 参数 of [{ 重新投喂: '2026-11-03' }, { 重新投喂: '2026-11-03', 只预览: true }]) {
    const out = await t.execute(参数)
    assert.equal(out.ok, false, `${JSON.stringify(参数)} 没配模型时必须失败`)
    assert.match(String(out.text), /需要大模型|没有配置模型/, '要说清楚为什么不能重喂')
  }
})
