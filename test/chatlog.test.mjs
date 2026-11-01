// chatlog.test.mjs —— 聊天记录存储（按天分文件、私聊群聊分开）的测试
//
// 断言依据的时间戳都先用 node 实际算过北京时间（Asia/Shanghai, UTC+8），不是猜的：
//   1793510392000 → 北京 2026-11-01 13:19:52（UTC 2026-11-01T05:19:52Z）
//   1793462399000 → 北京 2026-10-31 23:59:59（UTC 2026-10-31T15:59:59Z）
//   1793462400000 → 北京 2026-11-01 00:00:00（UTC 2026-10-31T16:00:00Z，北京日期分界线）
// 这两个 UTC 同在 10-31 的时刻，北京却分属两天，正好用来验证换算走的是北京时间。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  日期键,
  格式化一行,
  追加一条,
  读某天,
  列出已有日期,
  搜索记录,
} from '../lib/chatlog.js';

// 北京 2026-11-01 13:19:52
const T1 = 1793510392000;
// 北京 2026-10-31 23:59:59（前一天）
const T0 = 1793462399000;

// 每个用例独立临时目录，互不影响；用完即删
async function 临时目录() {
  return mkdtemp(join(tmpdir(), 'chatlog-test-'));
}

test('chatlog: 日期键 按北京时间换算（不是 UTC，也不是机器时区）', () => {
  // 实现里 timeZone 固定写死 Asia/Shanghai，结果与机器时区无关
  assert.equal(日期键(T1), '2026-11-01');
  // 北京日期分界线两侧各一秒：UTC 都是 2026-10-31，北京却分属两天
  assert.equal(日期键(T0), '2026-10-31');
  assert.equal(日期键(1793462400000), '2026-11-01');
  // 非法输入兜底
  assert.equal(日期键('不是数字'), '');
  assert.equal(日期键(NaN), '');
});

test('chatlog: 格式化一行 标准 / 缺昵称 / 缺 pid / 都缺', () => {
  const 消息 = { timeMs: T1, nickname: '小明', pid: 'p1', text: '哈哈哈哈' };
  assert.equal(格式化一行(消息), '[13:19:52] 小明(p1): 哈哈哈哈');
  // 缺昵称 → '未知'
  assert.equal(格式化一行({ ...消息, nickname: undefined }), '[13:19:52] 未知(p1): 哈哈哈哈');
  assert.equal(格式化一行({ ...消息, nickname: '' }), '[13:19:52] 未知(p1): 哈哈哈哈');
  // 缺 pid → 省略括号部分
  assert.equal(格式化一行({ ...消息, pid: undefined }), '[13:19:52] 小明: 哈哈哈哈');
  assert.equal(格式化一行({ ...消息, pid: null }), '[13:19:52] 小明: 哈哈哈哈');
  // 都缺
  assert.equal(格式化一行({ ...消息, nickname: '', pid: '' }), '[13:19:52] 未知: 哈哈哈哈');
});

test('chatlog: 私聊追加 → 文件出现在 chat/private/<日期>.txt', async () => {
  const root = await 临时目录();
  try {
    const r = await 追加一条(root, {
      chatType: 'private', timeMs: T1, nickname: '小明', pid: 'p1', messageId: 'm1', text: '哈哈哈哈',
    });
    const file = join(root, 'chat', 'private', '2026-11-01.txt');
    assert.equal(r.appended, true);
    assert.equal(r.duplicated, false);
    assert.equal(r.file, file);
    assert.equal(await readFile(file, 'utf8'), '[13:19:52] 小明(p1): 哈哈哈哈\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 群聊追加 → 文件出现在 chat/group/<群号>/<日期>.txt，群与群分开', async () => {
  const root = await 临时目录();
  try {
    const r = await 追加一条(root, {
      chatType: 'group', groupId: '668800', timeMs: T1, nickname: '群友', pid: 'u9', messageId: 'g1', text: '签到',
    });
    const file = join(root, 'chat', 'group', '668800', '2026-11-01.txt');
    assert.equal(r.file, file);
    assert.equal(await readFile(file, 'utf8'), '[13:19:52] 群友(u9): 签到\n');

    // 另一个群各走各的目录
    await 追加一条(root, {
      chatType: 'group', groupId: '777', timeMs: T1, nickname: '群友', pid: 'u9', messageId: 'g2', text: '另一群',
    });
    const 群s = await readdir(join(root, 'chat', 'group'));
    assert.deepEqual([...群s].sort(), ['668800', '777']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 同 messageId 第二次追加 → duplicated:true，文件仍只有一行', async () => {
  const root = await 临时目录();
  try {
    const 消息 = { chatType: 'group', groupId: '88', timeMs: T1, nickname: '甲', pid: 'u1', messageId: 'same-id', text: '你好' };
    const r1 = await 追加一条(root, 消息);
    // 即使内容不一样，同一个 id 也算重复
    const r2 = await 追加一条(root, { ...消息, text: '改过的内容' });
    assert.equal(r1.appended, true);
    assert.equal(r2.appended, false);
    assert.equal(r2.duplicated, true);

    const 行s = (await readFile(join(root, 'chat', 'group', '88', '2026-11-01.txt'), 'utf8'))
      .split('\n').filter((l) => l !== '');
    assert.equal(行s.length, 1);
    assert.ok(行s[0].includes('你好'));

    // 去重表落在 chat/.seen.json，messageId 作 key
    const 已见 = JSON.parse(await readFile(join(root, 'chat', '.seen.json'), 'utf8'));
    assert.ok(Object.prototype.hasOwnProperty.call(已见, 'same-id'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 不同 messageId 各写一行（追加，不重写）', async () => {
  const root = await 临时目录();
  try {
    await 追加一条(root, { chatType: 'private', timeMs: T1, nickname: '小明', pid: 'p1', messageId: 'a', text: '第一条' });
    await 追加一条(root, { chatType: 'private', timeMs: T1 + 60000, nickname: '小明', pid: 'p1', messageId: 'b', text: '第二条' });
    const 行s = (await readFile(join(root, 'chat', 'private', '2026-11-01.txt'), 'utf8'))
      .split('\n').filter((l) => l !== '');
    assert.deepEqual(行s, [
      '[13:19:52] 小明(p1): 第一条',
      '[13:20:52] 小明(p1): 第二条',
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 空 text（trim 后为空）不写，也不建文件', async () => {
  const root = await 临时目录();
  try {
    const 空s = ['', '   ', '\n\t '];
    for (let i = 0; i < 空s.length; i++) {
      const r = await 追加一条(root, { chatType: 'private', timeMs: T1, messageId: 'e' + i, text: 空s[i] });
      assert.deepEqual(r, { appended: false });
    }
    const r2 = await 追加一条(root, { chatType: 'group', groupId: '5', timeMs: T1, messageId: 'e-null', text: null });
    assert.deepEqual(r2, { appended: false });
    // 什么都没写，连 chat/ 目录都不该被建出来
    let 有chat目录 = true;
    try { await readdir(join(root, 'chat')); } catch { 有chat目录 = false; }
    assert.equal(有chat目录, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: text 含换行只占一行（换行转空格）', async () => {
  const root = await 临时目录();
  try {
    await 追加一条(root, {
      chatType: 'private', timeMs: T1, nickname: '诗人', pid: 'p7', messageId: 'n1',
      text: '第一行\n第二行\r\n第三行\r结尾',
    });
    const 原文 = await readFile(join(root, 'chat', 'private', '2026-11-01.txt'), 'utf8');
    assert.equal(原文, '[13:19:52] 诗人(p7): 第一行 第二行 第三行 结尾\n');
    assert.equal(原文.split('\n').filter((l) => l !== '').length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 读某天 读得回来；不存在返回 []', async () => {
  const root = await 临时目录();
  try {
    await 追加一条(root, { chatType: 'group', groupId: '88', timeMs: T0, nickname: '甲', pid: 'u1', messageId: 'd1', text: '昨天的话' });
    await 追加一条(root, { chatType: 'group', groupId: '88', timeMs: T1, nickname: '乙', pid: 'u2', messageId: 'd2', text: '今天的话' });

    assert.deepEqual(
      await 读某天(root, { chatType: 'group', groupId: '88', date: '2026-11-01' }),
      ['[13:19:52] 乙(u2): 今天的话'],
    );
    assert.deepEqual(
      await 读某天(root, { chatType: 'group', groupId: '88', date: '2026-10-31' }),
      ['[23:59:59] 甲(u1): 昨天的话'],
    );
    // 不存在的日期 / 不存在的群 / 非法日期格式
    assert.deepEqual(await 读某天(root, { chatType: 'group', groupId: '88', date: '2020-01-01' }), []);
    assert.deepEqual(await 读某天(root, { chatType: 'group', groupId: '404', date: '2026-11-01' }), []);
    assert.deepEqual(await 读某天(root, { chatType: 'group', groupId: '88', date: '2026/11/01' }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 列出已有日期 降序（最新在前）', async () => {
  const root = await 临时目录();
  const root2 = await 临时目录();
  try {
    // 故意先写旧的一天，再写新的一天
    await 追加一条(root, { chatType: 'private', timeMs: T0, messageId: 'x1', text: '旧' });
    await 追加一条(root, { chatType: 'private', timeMs: T1, messageId: 'x2', text: '新' });
    assert.deepEqual(await 列出已有日期(root, { chatType: 'private' }), ['2026-11-01', '2026-10-31']);

    // 群聊；不传 groupId 时合并所有群
    await 追加一条(root, { chatType: 'group', groupId: '88', timeMs: T1, messageId: 'x3', text: '群新' });
    await 追加一条(root, { chatType: 'group', groupId: '99', timeMs: T0, messageId: 'x4', text: '另一群旧' });
    assert.deepEqual(await 列出已有日期(root, { chatType: 'group', groupId: '88' }), ['2026-11-01']);
    assert.deepEqual(await 列出已有日期(root, { chatType: 'group' }), ['2026-11-01', '2026-10-31']);

    // 空库返回 []
    assert.deepEqual(await 列出已有日期(root2, { chatType: 'private' }), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(root2, { recursive: true, force: true });
  }
});

test('chatlog: 搜索记录 能搜到，chatType/groupId 过滤生效', async () => {
  const root = await 临时目录();
  try {
    await 追加一条(root, { chatType: 'private', timeMs: T0, nickname: '小明', pid: 'p1', messageId: 's1', text: '今天吃了苹果' });
    await 追加一条(root, { chatType: 'group', groupId: '88', timeMs: T1, nickname: '甲', pid: 'u1', messageId: 's2', text: '苹果多少钱' });
    await 追加一条(root, { chatType: 'group', groupId: '99', timeMs: T1, nickname: '乙', pid: 'u2', messageId: 's3', text: '今天下雨' });

    // 全搜（私聊 + 所有群），从新到旧
    const 全部 = await 搜索记录(root, '苹果');
    assert.equal(全部.length, 2);
    assert.deepEqual(全部.map((h) => h.date), ['2026-11-01', '2026-10-31']);

    // 只搜私聊
    const 私 = await 搜索记录(root, '苹果', { chatType: 'private' });
    assert.equal(私.length, 1);
    assert.equal(私[0].chatType, 'private');
    assert.equal(私[0].groupId, null);
    assert.equal(私[0].date, '2026-10-31');
    assert.equal(私[0].line, '[23:59:59] 小明(p1): 今天吃了苹果');
    assert.equal(私[0].text, '今天吃了苹果');

    // 只搜指定群
    const 群88 = await 搜索记录(root, '苹果', { chatType: 'group', groupId: '88' });
    assert.equal(群88.length, 1);
    assert.equal(群88[0].groupId, '88');

    // 群聊整体（不指定群）：只有 88 群提到苹果
    const 群 = await 搜索记录(root, '苹果', { chatType: 'group' });
    assert.equal(群.length, 1);
    assert.equal(群[0].groupId, '88');

    // 忽略大小写
    await 追加一条(root, { chatType: 'private', timeMs: T1, messageId: 's4', text: 'Hello World' });
    assert.equal((await 搜索记录(root, 'hello world')).length, 1);

    // 搜不到 / 空关键词
    assert.deepEqual(await 搜索记录(root, '不存在的词xyz'), []);
    assert.deepEqual(await 搜索记录(root, '   '), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 搜索记录 limit 生效（默认 50 不截断正常结果）', async () => {
  const root = await 临时目录();
  try {
    for (let i = 0; i < 5; i++) {
      await 追加一条(root, {
        chatType: 'group', groupId: '88', timeMs: T1 + i * 1000, nickname: '甲', pid: 'u1',
        messageId: 'l' + i, text: '刷屏 ' + i,
      });
    }
    assert.equal((await 搜索记录(root, '刷屏')).length, 5);
    const 限2 = await 搜索记录(root, '刷屏', { limit: 2 });
    assert.equal(限2.length, 2);
    // 不传 limit（默认 50）：5 条全给
    assert.equal((await 搜索记录(root, '刷屏', {})).length, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: .seen.json 限长 5000，超了丢最老的', async () => {
  const root = await 临时目录();
  try {
    const chatDir = join(root, 'chat');
    await mkdir(chatDir, { recursive: true });
    // 预置 5000 个旧 id，时间戳一路递增，old-0000 最老
    const 旧表 = {};
    for (let i = 0; i < 5000; i++) 旧表['old-' + String(i).padStart(4, '0')] = 1000000000 + i;
    await writeFile(join(chatDir, '.seen.json'), JSON.stringify(旧表), 'utf8');

    const r = await 追加一条(root, { chatType: 'private', timeMs: T1, messageId: 'new-1', text: '第5001条' });
    assert.equal(r.appended, true);

    const 已见 = JSON.parse(await readFile(join(chatDir, '.seen.json'), 'utf8'));
    const keys = Object.keys(已见);
    assert.equal(keys.length, 5000); // 上限封顶
    assert.equal('old-0000' in 已见, false); // 最老的被丢
    assert.equal('old-4999' in 已见, true);  // 较新的还在
    assert.equal('new-1' in 已见, true);     // 新进来的在
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chatlog: 异常都不抛给调用方，返回 { appended:false, error }', async () => {
  const root = await 临时目录();
  try {
    const e1 = await 追加一条(root, { chatType: 'privateX', timeMs: T1, messageId: 'z1', text: 'hi' });
    assert.equal(e1.appended, false);
    assert.ok(typeof e1.error === 'string' && e1.error.length > 0);

    // 群聊缺 groupId
    const e2 = await 追加一条(root, { chatType: 'group', timeMs: T1, messageId: 'z2', text: 'hi' });
    assert.equal(e2.appended, false);
    assert.ok(e2.error);

    // groupId 带路径穿越，必须拒绝，且不能在 chat/ 之外建目录
    const e3 = await 追加一条(root, { chatType: 'group', groupId: '../越权', timeMs: T1, messageId: 'z3', text: 'hi' });
    assert.equal(e3.appended, false);
    assert.ok(e3.error);
    assert.equal(existsSync(join(root, '越权')), false);
    assert.equal(existsSync(join(root, 'chat')), false);

    const e4 = await 追加一条(null, { chatType: 'private', text: 'x' });
    assert.equal(e4.appended, false);
    assert.ok(e4.error);
    const e5 = await 追加一条(root, null);
    assert.equal(e5.appended, false);
    assert.ok(e5.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
