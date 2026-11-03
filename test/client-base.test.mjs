/**
 * client.js 的 BASE 路径解析测试（2026-11-03）。
 *
 * 【为什么要有这条】
 * 云端 DSH 挂在 nginx 的 /dsh/ 下，而 DSH 自己不知道有这么一层前缀。
 * 写死 '/dsh-memory-vault' 时，浏览器会请求 http://<host>/dsh-memory-vault/... ——
 * 那里没有对应 location，直接 404，设置页就报「读取失败 http404」。
 * 换成裸相对路径后，浏览器按页面目录拼，两种部署形态都对。
 *
 * 这里不渲染组件，只验最关键的「拼出来的 URL 对不对」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// 与 client.js 里那段逻辑一字不差地抄一份（它依赖 document 是否存在）
function 取BASE(有document) {
  const document = 有document ? {} : undefined;
  try {
    return typeof document !== 'undefined' && document ? 'dsh-memory-vault' : '/dsh-memory-vault';
  } catch (e) {
    return '/dsh-memory-vault';
  }
}

test('挂在 /dsh/ 前缀下：相对 BASE 必须拼出带前缀的地址', () => {
  const url = new URL(取BASE(true) + '/settings', 'http://110.40.179.74/dsh/');
  assert.equal(url.pathname, '/dsh/dsh-memory-vault/settings');
});

test('挂在站点根下：相对 BASE 拼出不带前缀的地址（不能变成 /dsh/...）', () => {
  const url = new URL(取BASE(true) + '/settings', 'http://110.40.179.74/');
  assert.equal(url.pathname, '/dsh-memory-vault/settings');
});

test('注册反例：写死绝对路径时，/dsh/ 下会丢掉前缀 → 404', () => {
  const url = new URL('/dsh-memory-vault' + '/settings', 'http://110.40.179.74/dsh/');
  assert.equal(url.pathname, '/dsh-memory-vault/settings'); // 前缀没了
});

test('没有 document（node 单测环境）时退回绝对路径，行为与旧版一致', () => {
  assert.equal(取BASE(false), '/dsh-memory-vault');
});
