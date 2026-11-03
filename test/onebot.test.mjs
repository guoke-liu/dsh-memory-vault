/**
 * lib/onebot.js 的单元测试。
 * 约束：全部使用注入的假 fetchImpl，不访问真实网络，不读真实 token。
 * 运行：在插件根目录执行 node --test test/*.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOneBot,
  extractImages,
  fetchImageBytes,
} from '../lib/onebot.js';

const BASE_URL = 'http://127.0.0.1:3000';
const DUMMY_TOKEN = 'DUMMY-TEST-TOKEN-纯假token-非真实凭证';

/** 造一个带调用记录的假 fetch，记录每次 (url, opts)。 */
function makeFakeFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const record = { url, opts };
    calls.push(record);
    return responder(record);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** OneBot 成功响应的假 JSON。 */
const okJson = (data) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok', retcode: 0, data }),
});

// ---------------- extractImages ----------------

test('extractImages: segment 数组形态能抽出图片', () => {
  const event = {
    message: [
      { type: 'text', data: { text: '看这两张图' } },
      { type: 'image', data: { file: 'ABC123.image', url: 'https://gchat.qpic.cn/a.jpg', subType: 0 } },
      { type: 'face', data: { id: '12' } },
      { type: 'image', data: { file: 'base64://aGVsbG8=' } },
    ],
  };
  const images = extractImages(event);

  assert.equal(images.length, 2);
  assert.deepEqual(images[0], {
    file: 'ABC123.image',
    url: 'https://gchat.qpic.cn/a.jpg',
    isBase64: false,
  });
  assert.equal(images[1].file, 'base64://aGVsbG8=');
  assert.equal(images[1].url, null);
  assert.equal(images[1].isBase64, true);
});

test('extractImages: CQ 码字符串形态能抽出图片', () => {
  const event = {
    message:
      '前文[CQ:face,id=12][CQ:image,file=abc.jpg,url=https%3A%2F%2Fgchat.qpic.cn%2Fa.jpg]后文[CQ:image,file=def.png]',
  };
  const images = extractImages(event);

  assert.equal(images.length, 2);
  assert.deepEqual(images[0], {
    file: 'abc.jpg',
    url: 'https://gchat.qpic.cn/a.jpg',
    isBase64: false,
  });
  assert.equal(images[1].file, 'def.png');
  assert.equal(images[1].url, null);
  assert.equal(images[1].isBase64, false);
});

test('extractImages: 没有图片的消息返回空数组', () => {
  assert.deepEqual(
    extractImages({
      message: [{ type: 'text', data: { text: '纯文字' } }, { type: 'face', data: { id: '1' } }],
    }),
    []
  );
  assert.deepEqual(extractImages({ message: '今天天气不错' }), []);
  assert.deepEqual(extractImages({ message: '[CQ:record,file=voice.mp3]' }), []);
  assert.deepEqual(extractImages({}), []);
  assert.deepEqual(extractImages(null), []);
});

// ---------------- createOneBot().call ----------------

test('call: POST 到 {baseUrl}/{action}，带 Authorization: Bearer 头；token 为空则不带', async () => {
  const f1 = makeFakeFetch(() => okJson({ user_id: 1, nickname: 'bot' }));
  const ob1 = createOneBot({ baseUrl: BASE_URL, token: DUMMY_TOKEN, fetchImpl: f1 });
  await ob1.call('get_login_info', {});

  assert.equal(f1.calls.length, 1);
  assert.equal(f1.calls[0].url, `${BASE_URL}/get_login_info`);
  assert.equal(f1.calls[0].opts.method, 'POST');
  assert.equal(f1.calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(f1.calls[0].opts.headers['Authorization'], `Bearer ${DUMMY_TOKEN}`);
  assert.deepEqual(JSON.parse(f1.calls[0].opts.body), {});

  // token 为空则不带 Authorization
  const f2 = makeFakeFetch(() => okJson({}));
  const ob2 = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f2 });
  await ob2.call('get_login_info', {});
  assert.ok(!('Authorization' in f2.calls[0].opts.headers));

  // baseUrl 尾部斜杠要归一化
  const f3 = makeFakeFetch(() => okJson({}));
  const ob3 = createOneBot({ baseUrl: `${BASE_URL}/`, token: DUMMY_TOKEN, fetchImpl: f3 });
  await ob3.call('get_version_info', {});
  assert.equal(f3.calls[0].url, `${BASE_URL}/get_version_info`);
});

test('call: status=failed 或 retcode 非 0 时抛错，错误带 retcode', async () => {
  const f = makeFakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'failed',
      retcode: 1200,
      word: 'sql',
      message: 'database error',
    }),
  }));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  await assert.rejects(
    () => ob.call('get_friend_msg_history', { user_id: 10086 }),
    (err) => {
      assert.equal(err.retcode, 1200);
      assert.equal(err.status, 'failed');
      assert.match(err.message, /retcode=1200/);
      return true;
    }
  );

  // retcode=1（非 0）同样要抛
  const f2 = makeFakeFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ status: 'async', retcode: 1 }),
  }));
  const ob2 = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f2 });
  await assert.rejects(
    () => ob2.call('send_private_msg', {}),
    (err) => err.retcode === 1
  );
});

// ---------------- createOneBot 便捷方法 ----------------

test('getLoginInfo: 调 get_login_info，返回 {userId, nickname}', async () => {
  const f = makeFakeFetch(() => okJson({ user_id: 10086, nickname: '小美' }));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  const info = await ob.getLoginInfo();

  assert.deepEqual(info, { userId: 10086, nickname: '小美' });
  assert.ok(f.calls[0].url.endsWith('/get_login_info'));
});

test('getRecentPrivateMessages: POST get_friend_msg_history，body 含 user_id/count=20/message_seq，返回消息数组', async () => {
  const imageMsg = {
    message: [{ type: 'image', data: { file: 'a.image', url: 'https://gchat.qpic.cn/a.png' } }],
  };
  const f = makeFakeFetch(() => okJson({ messages: [imageMsg] }));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  const messages = await ob.getRecentPrivateMessages(10086, 12345);

  assert.equal(f.calls[0].url, `${BASE_URL}/get_friend_msg_history`);
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), {
    user_id: 10086,
    count: 20,
    message_seq: 12345,
  });
  assert.equal(messages.length, 1);
  assert.equal(extractImages(messages[0]).length, 1);

  // 不传 seq 时 body 里不出现 message_seq
  await ob.getRecentPrivateMessages(10086);
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { user_id: 10086, count: 20 });
});

// ---------------- 群聊历史翻页（2026-11-03） ----------------
//
// 这组测试盯的是一个真实事故：SnowLuma 不认 message_seq，只认 message_id，
// 于是「首次回填历史」永远只拿到最近一页就停（100 条）。下面每条都对应一个实测过的坑。

test('getRecentGroupMessages: 不传 seq 时 body 只有 group_id + count，不带任何游标', async () => {
  const f = makeFakeFetch(() => okJson([{ message_id: 1, message_seq: 10 }]));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  await ob.getRecentGroupMessages(934074044, undefined, 100);

  assert.equal(f.calls[0].url, `${BASE_URL}/get_group_msg_history`);
  assert.deepEqual(JSON.parse(f.calls[0].opts.body), { group_id: 934074044, count: 100 });
  // 关键：没有 seq 时绝不能冒出 message_id: undefined 这种会被序列化成 null 的键
  assert.ok(!('message_id' in JSON.parse(f.calls[0].opts.body)));
  assert.ok(!('message_seq' in JSON.parse(f.calls[0].opts.body)));
});

test('getGroupMessagesBefore: 只传 message_id，绝不带 message_seq（同传会被 SnowLuma 判成空页）', async () => {
  const f = makeFakeFetch(() => okJson([{ message_id: 222, message_seq: 9 }]));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  await ob.getGroupMessagesBefore(934074044, { message_id: 273901214, message_seq: 601485 }, 100);

  const body = JSON.parse(f.calls[0].opts.body);
  assert.deepEqual(body, { group_id: 934074044, count: 100, message_id: 273901214 });
  assert.ok(!('message_seq' in body), '带上 message_seq 会让 SnowLuma 返回空页');
});

test('getGroupMessagesBefore: 游标原样传，不做 -1（SnowLuma 口径是「不含这一条」，-1 会返回空）', async () => {
  const f = makeFakeFetch(() => okJson([]));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  await ob.getGroupMessagesBefore(934074044, { message_id: 1687256396 }, 50);

  assert.equal(JSON.parse(f.calls[0].opts.body).message_id, 1687256396);
});

test('getGroupMessagesBefore: 没有 message_id 时抛 TypeError，不发请求', async () => {
  const f = makeFakeFetch(() => okJson([]));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  await assert.rejects(
    () => ob.getGroupMessagesBefore(934074044, {}, 100),
    /message_id/
  );
  assert.equal(f.calls.length, 0);
});

test('getGroupMessagesBefore: data 直接是数组或包在 messages 里都能取到', async () => {
  const flat = makeFakeFetch(() => okJson([{ message_id: 1 }]));
  const wrapped = makeFakeFetch(() => okJson({ messages: [{ message_id: 2 }, { message_id: 3 }] }));

  const a = await createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: flat })
    .getGroupMessagesBefore(1, { message_id: 9 });
  const b = await createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: wrapped })
    .getGroupMessagesBefore(1, { message_id: 9 });

  assert.equal(a.length, 1);
  assert.equal(b.length, 2);
});

test('getRecentGroupMessages: 像消息 id 的 seq（>1e8）走 message_id，像序号的走 message_seq', async () => {
  const f = makeFakeFetch(() => okJson([]));
  const ob = createOneBot({ baseUrl: BASE_URL, token: '', fetchImpl: f });

  // SnowLuma 的 message_id 是 9~10 位随机数；message_seq 是小得多的递增序号
  await ob.getRecentGroupMessages(1, 273901214, 100);
  assert.equal(JSON.parse(f.calls[0].opts.body).message_id, 273901214);
  assert.ok(!('message_seq' in JSON.parse(f.calls[0].opts.body)));

  // 序号口径：规范是「含游标本身」，所以要 -1 才真正往前挪一格
  await ob.getRecentGroupMessages(1, 601485, 100);
  assert.equal(JSON.parse(f.calls[1].opts.body).message_seq, 601484);
  assert.ok(!('message_id' in JSON.parse(f.calls[1].opts.body)));
});

// ---------------- fetchImageBytes ----------------

test('fetchImageBytes: 从 base64:// 取出字节（不发起网络请求）', async () => {
  const raw = Buffer.from('图片原始字节\x89PNG\r\n\x1a\n', 'utf8');
  const seg = {
    file: `base64://${raw.toString('base64')}`,
    url: null,
    isBase64: true,
  };
  // 这个 fetchImpl 一旦被调用就炸，证明 base64 路径完全不走网络
  const f = makeFakeFetch(() => {
    throw new Error('不应该发起网络请求');
  });

  const buf = await fetchImageBytes(seg, { fetchImpl: f });

  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(buf, raw);
  assert.equal(f.calls.length, 0);
});

test('fetchImageBytes: url 可用时直接拉字节', async () => {
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const f = makeFakeFetch(async (call) => {
    assert.equal(call.url, 'https://gchat.qpic.cn/a.png');
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () =>
        raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    };
  });

  const buf = await fetchImageBytes(
    { file: 'x.image', url: 'https://gchat.qpic.cn/a.png', isBase64: false },
    { fetchImpl: f }
  );

  assert.ok(Buffer.isBuffer(buf));
  assert.deepEqual(Uint8Array.from(buf), Uint8Array.from(raw));
});

test('fetchImageBytes: url 失败时回退到 base64://', async () => {
  const raw = Buffer.from('fallback-bytes', 'utf8');
  const f = makeFakeFetch(async () => {
    throw new Error('network down');
  });

  const buf = await fetchImageBytes(
    {
      file: `base64://${raw.toString('base64')}`,
      url: 'https://gchat.qpic.cn/dead.png',
      isBase64: true,
    },
    { fetchImpl: f }
  );

  assert.deepEqual(buf, raw);
  assert.equal(f.calls.length, 1); // 试过一次 url
});

test('fetchImageBytes: 全部途径失败返回 null 且不抛', async () => {
  const f = makeFakeFetch(async () => ({
    ok: false,
    status: 404,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));

  const buf = await fetchImageBytes(
    {
      file: '/tmp/dsh-memory-vault-v2-test-nonexistent/no-such-image.png',
      url: 'https://gchat.qpic.cn/404.png',
      isBase64: false,
    },
    { fetchImpl: f }
  );

  assert.equal(buf, null);
});
