// settings.js + routes.js 的测试：配置读写、三档存图模式校验、并发安全、路由注册容错。

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettings } from '../lib/settings.js';
import { registerRoutes } from '../lib/routes.js';

// 每个用例独立临时目录，互不影响
const temps = [];
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), 'settings-test-'));
  temps.push(d);
  return d;
}
async function tempConfigPath() {
  return join(await tempDir(), 'settings.json');
}

after(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

test('settings: 文件不存在时 read() 返回默认值，存图模式为 both', async () => {
  const s = createSettings({ configPath: await tempConfigPath() });
  const cfg = await s.read();
  assert.equal(cfg.version, 1);
  assert.equal(cfg['存图模式'], 'both');
  assert.equal(cfg['启用私聊'], true);
  assert.equal(cfg['启用群聊'], false);
  assert.equal(cfg['记私聊聊天'], true);
  assert.equal(cfg['记群聊聊天'], true);
  assert.equal(cfg['定时拉取'], true);
  assert.equal(cfg['拉取间隔秒'], 60);
  assert.equal(cfg['库目录'], '');
});

test('settings: 聊天记录与定时拉取开关可单独读写', async () => {
  const s = createSettings({ configPath: await tempConfigPath() });
  await s.write({ 记私聊聊天: false, 记群聊聊天: false, 定时拉取: false, 拉取间隔秒: 120 });
  const cfg = await s.read();
  assert.equal(cfg['记私聊聊天'], false);
  assert.equal(cfg['记群聊聊天'], false);
  assert.equal(cfg['定时拉取'], false);
  assert.equal(cfg['拉取间隔秒'], 120);
  // 非法间隔被拒，保持原值
  await s.write({ 拉取间隔秒: 5 });
  assert.equal((await s.read())['拉取间隔秒'], 120);
});

test('settings: write() 部分更新，其他字段保持不动', async () => {
  const s = createSettings({ configPath: await tempConfigPath() });

  await s.write({ '存图模式': 'text' });
  let cfg = await s.read();
  assert.equal(cfg['存图模式'], 'text');
  assert.equal(cfg['启用私聊'], true); // 没传的字段 → 保持默认
  assert.equal(cfg['启用群聊'], false);
  assert.equal(cfg['version'], 1);

  await s.write({ '启用群聊': true, '库目录': 'imgs' });
  cfg = await s.read();
  assert.equal(cfg['存图模式'], 'text'); // 上一次写进去的还在
  assert.equal(cfg['启用群聊'], true);
  assert.equal(cfg['库目录'], 'imgs');
  assert.equal(cfg['启用私聊'], true);
  assert.equal(cfg['version'], 1);
});

test('settings: 非法存图模式回退成 both（write 传入和文件里已有，两条路径都验）', async () => {
  // a) write() 直接传非法值
  const s = createSettings({ configPath: await tempConfigPath() });
  await s.write({ '存图模式': '只存文字' }); // 不在 both/text/image 里
  assert.equal((await s.read())['存图模式'], 'both');

  // b) 从合法值先切走，再传非法值，也要落回 both
  await s.write({ '存图模式': 'image' });
  await s.write({ '存图模式': 'BOTH' }); // 大小写也算非法
  assert.equal((await s.read())['存图模式'], 'both');

  // c) 配置文件里直接写着非法值，read() 同样回退
  const path2 = await tempConfigPath();
  await writeFile(path2, JSON.stringify({ version: 1, '存图模式': 'everything' }), 'utf8');
  const s2 = createSettings({ configPath: path2 });
  assert.equal((await s2.read())['存图模式'], 'both');
});

test('settings: 文件损坏时 read() 不抛异常，返回默认值', async () => {
  const path = await tempConfigPath();
  const s = createSettings({ configPath: path });

  // 半截 JSON
  await writeFile(path, '{ 这不是 JSON !!!', 'utf8');
  let cfg = await s.read(); // 不抛
  assert.equal(cfg['存图模式'], 'both');
  assert.equal(cfg['version'], 1);

  // 合法 JSON 但不是对象，也算损坏
  for (const junk of ['[1,2,3]', '"text"', 'null', '123', '']) {
    await writeFile(path, junk, 'utf8');
    cfg = await s.read();
    assert.equal(cfg['存图模式'], 'both');
    assert.equal(cfg['启用私聊'], true);
  }
});

test('settings: 并发 write 不丢数据', async () => {
  const s = createSettings({ configPath: await tempConfigPath() });
  await Promise.all([
    s.write({ '存图模式': 'text' }),
    s.write({ '启用群聊': true }),
    s.write({ '启用私聊': false }),
    s.write({ '库目录': 'pic' }),
  ]);
  const cfg = await s.read();
  assert.equal(cfg['存图模式'], 'text');
  assert.equal(cfg['启用群聊'], true);
  assert.equal(cfg['启用私聊'], false);
  assert.equal(cfg['库目录'], 'pic');
  assert.equal(cfg['version'], 1);
});

test('settings: describe() 返回非空字符串，且覆盖三档模式', () => {
  const s = createSettings({ configPath: '/tmp/settings-test-unused.json' });
  const d = s.describe();
  assert.equal(typeof d, 'string');
  assert.ok(d.length > 0);
  for (const mode of ['both', 'text', 'image']) {
    assert.ok(d.includes(mode), `describe() 应提到 ${mode}`);
  }
});

test('routes: webServer 缺失或没有 register 方法时不抛错', () => {
  const s = createSettings({ configPath: '/tmp/settings-test-unused.json' });
  assert.doesNotThrow(() => registerRoutes(undefined, { settings: s }));
  assert.doesNotThrow(() => registerRoutes(null, { settings: s }));
  assert.doesNotThrow(() => registerRoutes({}, { settings: s })); // 没有 register
  assert.doesNotThrow(() => registerRoutes({ register: 'nope' }, { settings: s })); // register 不是函数
});

test('routes: 假 webServer 抓出 handler，GET settings 能拿到配置，POST 能改', async () => {
  const s = createSettings({ configPath: await tempConfigPath() });
  const regs = [];
  // 真实签名：register({ kind:'exact', path, handler })，且要包在 ctx.effect 里
  const ctx = {
    webServer: { register: (r) => regs.push(r) },
    effect: (fn) => fn(),
  };
  registerRoutes(ctx, { settings: s, log: () => {} });

  // 2026-11-02：新增 /scan（手动扫描）后是 3 条
  assert.equal(regs.length, 3, '应注册 settings / stats / scan 三条路由');
  const settingsRoute = regs.find((r) => r.path === '/dsh-memory-vault/settings');
  const statsRoute = regs.find((r) => r.path === '/dsh-memory-vault/stats');
  assert.ok(settingsRoute, '应有 settings 路由');
  assert.ok(statsRoute, '应有 stats 路由');
  const scanRoute = regs.find((r) => r.path === '/dsh-memory-vault/scan');
  assert.ok(scanRoute, '应有 scan 路由（手动扫描）');
  assert.equal(settingsRoute.kind, 'exact', '必须用 kind:exact，不是 method');

  // 造一个假的 res 收响应（真实签名要求自己写 head + end）
  const 造res = () => {
    const out = {};
    return { writeHead: (c) => { out.status = c }, end: (b) => { out.body = b }, get: () => out };
  };

  // GET
  let res = 造res();
  await settingsRoute.handler({ method: 'GET' }, res);
  const cfg = JSON.parse(res.get().body);
  assert.equal(cfg['存图模式'], 'both');
  assert.equal(cfg['version'], 1);

  // POST
  res = 造res();
  await settingsRoute.handler({ method: 'POST', json: async () => ({ 存图模式: 'image' }) }, res);
  assert.equal(JSON.parse(res.get().body)['存图模式'], 'image');
  assert.equal((await s.read())['存图模式'], 'image', '要真落盘');

  // POST 坏 body → 不改字段，也不炸
  res = 造res();
  await settingsRoute.handler({ method: 'POST', json: async () => { throw new Error('bad') } }, res);
  assert.equal((await s.read())['存图模式'], 'image');

  // stats
  res = 造res();
  await statsRoute.handler({ method: 'GET' }, res);
  assert.deepEqual(JSON.parse(res.get().body), { ok: true });
});

// ---------------- 私聊/群聊分开设档（2026-11-03） ----------------

test('分档默认是空串：老配置读出来「跟随总开关」，行为不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-split-'));
  const s = createSettings({ configPath: join(dir, 'config.json') });
  const cfg = await s.read();
  assert.equal(cfg['私聊存图模式'], '');
  assert.equal(cfg['群聊存图模式'], '');
  assert.equal(cfg['存图模式'], 'both');
});

test('分档能单独设：私聊 text、群聊 image，互不影响也不动总开关', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-split-'));
  const s = createSettings({ configPath: join(dir, 'config.json') });
  await s.write({ '存图模式': 'both', '私聊存图模式': 'text', '群聊存图模式': 'image' });
  const cfg = await s.read();
  assert.equal(cfg['私聊存图模式'], 'text');
  assert.equal(cfg['群聊存图模式'], 'image');
  assert.equal(cfg['存图模式'], 'both');
});

test('分档写回空串 = 重新跟随总开关', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-split-'));
  const s = createSettings({ configPath: join(dir, 'config.json') });
  await s.write({ '私聊存图模式': 'text' });
  assert.equal((await s.read())['私聊存图模式'], 'text');
  await s.write({ '私聊存图模式': '' });
  assert.equal((await s.read())['私聊存图模式'], '');
});

test('分档写非法值：忽略，保留当前值（不会被悄悄改成 both）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-split-'));
  const s = createSettings({ configPath: join(dir, 'config.json') });
  await s.write({ '群聊存图模式': 'text' });
  await s.write({ '群聊存图模式': '随便瞎写' });
  assert.equal((await s.read())['群聊存图模式'], 'text');
});

test('文件里的分档是脏值：读的时候回退空串（跟随），不是回退 both', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mv-split-'));
  const p = join(dir, 'config.json');
  await writeFile(p, JSON.stringify({ version: 1, '存图模式': 'text', '群聊存图模式': 'nonsense' }), 'utf8');
  const s = createSettings({ configPath: p });
  const cfg = await s.read();
  assert.equal(cfg['群聊存图模式'], '');
  assert.equal(cfg['存图模式'], 'text');   // 总开关没被连累
});

// ── 密钥脱敏与文件权限（安全相关，必须有测试）────────────────────────
// 追加到已有 import
import { 脱敏配置 } from '../lib/settings.js'
import { mkdtempSync, statSync, readFileSync } from 'node:fs'
import { join as joinP } from 'node:path'

test('脱敏配置：密钥变成 ***，其余字段不动', () => {
  const 脱 = 脱敏配置({ 模型密钥: 'sk-真值', 模型名称: 'x', 存图模式: 'both' })
  assert.equal(脱['模型密钥'], '***', '密钥必须脱敏')
  assert.equal(脱['模型名称'], 'x', '其他字段不能动')
  assert.equal(脱['存图模式'], 'both')
})

test('脱敏配置：空密钥保持空串（区分「没设」和「设了但不显示」）', () => {
  assert.equal(脱敏配置({ 模型密钥: '' })['模型密钥'], '')
  assert.equal(脱敏配置({})['模型密钥'], '')
})

test('脱敏后的值里不含真 key 任何片段', () => {
  const 真 = 'sk-abcdef123456789'
  const 脱 = 脱敏配置({ 模型密钥: 真 })
  assert.ok(!JSON.stringify(脱).includes('abcdef'), '响应里不能出现真 key 的任何部分')
})

test('config.json 写成 600 权限', async () => {
  const 目录 = mkdtempSync(joinP(tmpdir(), 'perm-'))
  const 文件 = joinP(目录, 'config.json')
  const s = createSettings({ configPath: 文件 })
  await s.write({ 模型密钥: 'sk-test' })
  const 模式 = statSync(文件).mode & 0o777
  assert.equal(模式, 0o600, `配置文件权限应为 600，实际 ${模式.toString(8)}`)
  // 真值确实写进去了（脱敏只影响接口，不影响落盘）
  assert.ok(readFileSync(文件, 'utf8').includes('sk-test'))
})
