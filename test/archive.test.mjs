import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initArchive,
  archiveImage,
  findByNo,
  findBySha,
  listImages,
  getStats,
} from '../lib/archive.js';

// 每个用例独立临时目录，互不影响
const temps = [];
function tempDir() {
  return mkdtemp(join(tmpdir(), 'archive-test-')).then((d) => {
    temps.push(d);
    return d;
  });
}

// 一张最小合法的 PNG（1x1 像素红点），字节固定
function png1x1() {
  return Buffer.from(
    '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626000002001000525a38c5c0000' +
    '000049454e44ae426082',
    'hex',
  );
}

test('archive: 首次归档分配编号 1，原图字节完全一致', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);
  const src = png1x1();

  const r1 = await archiveImage(rootDir, src, { messageId: 'm1', userId: 'u1' });
  assert.equal(r1.no, 1);
  assert.equal(r1.deduped, false);
  assert.equal(r1.refCount, 1);
  assert.equal(r1.ext, undefined); // 不返回 ext 字段

  // 读回原图，与输入字节 deepEqual
  const back = await readFile(r1.file);
  assert.deepEqual(back, src);
});

test('archive: 相同字节再归档 deduped=true、编号不变、refCount=2', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);
  const src = png1x1();

  const r1 = await archiveImage(rootDir, src, { messageId: 'm1' });
  const r2 = await archiveImage(rootDir, Buffer.from(src), { messageId: 'm2' });

  assert.equal(r1.no, 1);
  assert.equal(r2.no, 1);
  assert.equal(r2.deduped, true);
  assert.equal(r2.refCount, 2);
});

test('archive: 不同字节编号递增 1 → 2', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);

  const a = await archiveImage(rootDir, png1x1(), { messageId: 'm1' });
  const b = await archiveImage(rootDir, Buffer.concat([png1x1().subarray(0, 64), Buffer.from([0xde, 0xad])]), { messageId: 'm2' });

  assert.equal(a.no, 1);
  assert.equal(b.no, 2);
});

test('archive: 按编号 / 按 sha 前缀都能查到', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);
  const r = await archiveImage(rootDir, png1x1(), { messageId: 'm1' });

  const byNo = await findByNo(rootDir, 1);
  assert.equal(byNo.sha256, r.sha256);

  const bySha = await findBySha(rootDir, r.sha256.slice(0, 12));
  assert.equal(bySha.no, 1);
  assert.equal(bySha.sha256, r.sha256);

  // 查不存在的编号
  assert.equal(await findByNo(rootDir, 999), null);
  // 查不存在的 sha
  assert.equal(await findBySha(rootDir, 'ffffffff'), null);
});

test('archive: 空 Buffer 抛错', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);
  await assert.rejects(
    () => archiveImage(rootDir, Buffer.alloc(0), {}),
    /空 Buffer/,
  );
});

test('archive: index.json 被写成非法内容时自愈，不抛异常', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);
  await archiveImage(rootDir, png1x1(), { messageId: 'm1' });

  // 把 index.json 写坏
  await writeFile(join(rootDir, 'index.json'), '这不是 JSON {{{');

  // 继续归档不应抛
  const r = await archiveImage(rootDir, png1x1(), { messageId: 'm2' });
  assert.equal(r.no, 1); // 自愈成空库后，重新分配编号 1
  assert.equal(r.deduped, false);

  // 其它函数也不抛
  assert.ok(await getStats(rootDir));
  assert.ok(await listImages(rootDir));
  const found = await findByNo(rootDir, 1);
  assert.equal(found?.no, 1); // 自愈后重新分配的编号 1 能查到
});

test('archive: getStats 的 unique / totalRefs 数字正确', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);

  const a = png1x1();
  await archiveImage(rootDir, a, { messageId: 'm1' });
  await archiveImage(rootDir, Buffer.from(a), { messageId: 'm2' }); // 重复
  await archiveImage(rootDir, Buffer.concat([a, Buffer.from([0xff])]), { messageId: 'm3' }); // 不同

  const s = await getStats(rootDir);
  assert.equal(s.unique, 2);
  assert.equal(s.totalRefs, 3);
  assert.equal(s.dedupedRefs, 1); // 3 引用 - 2 唯一
  assert.equal(s.maxNo, 2);
  assert.ok(s.totalBytes > 0);
});

test('archive: listImages 按编号升序，支持 limit / offset', async () => {
  const dir = await tempDir();
  const { rootDir } = await initArchive(dir);

  const a = png1x1();
  await archiveImage(rootDir, a, { messageId: 'm1' });
  await archiveImage(rootDir, Buffer.concat([a, Buffer.from([0x11])]), { messageId: 'm2' });
  await archiveImage(rootDir, Buffer.concat([a, Buffer.from([0x22])]), { messageId: 'm3' });

  const all = await listImages(rootDir);
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((i) => i.no), [1, 2, 3]);

  const paged = await listImages(rootDir, { limit: 2, offset: 1 });
  assert.equal(paged.total, 3);
  assert.deepEqual(paged.items.map((i) => i.no), [2, 3]);
});

test('archive: 不存在的 rootDir 自动创建', async () => {
  const dir = await tempDir();
  const nested = join(dir, 'does', 'not', 'exist');
  const { rootDir } = await initArchive(nested);
  assert.equal(rootDir, nested);
  // 直接归档（不先 init）也能建目录
  const r = await archiveImage(nested, png1x1(), {});
  assert.equal(r.no, 1);
});

// 清理临时目录
process.on('exit', async () => {
  for (const d of temps) {
    try { await rm(d, { recursive: true, force: true }); } catch {}
  }
});
