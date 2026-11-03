// 回归测试：text 提供器必须是**同步**返回字符串。
// 背景（2026-11-02）：宿主 resolveContext 同步取 text，async 函数会返回 Promise，
// Promise.length 是 undefined，`undefined > 0` 为 false → 被静默丢弃，无任何报错。
// 这个 bug 从 v1.2.0 一直活到 v1.3.3，10 个单测全绿也照样漏。
import test from "node:test"
import assert from "node:assert/strict"
import { 造回忆引导 } from "../lib/recallhint.js"

test("造回忆引导 返回的原始函数是异步的（记录现状）", async () => {
  const f = 造回忆引导({ 有记忆: async () => true })
  const r = f()
  assert.ok(r instanceof Promise, "原始实现是 async，返回 Promise")
  await r
})

test("喂给宿主前必须包成同步提供器（否则会被静默丢弃）", async () => {
  const 原始 = 造回忆引导({ 有记忆: async () => true })
  let 缓存 = ""
  const 同步 = () => 缓存
  await (async () => { 缓存 = (await 原始()) || "" })()

  const t = 同步()
  assert.equal(typeof t, "string", "必须是字符串，不能是 Promise")
  assert.ok(!(t instanceof Promise))
  assert.ok(t.length > 0, "有记忆时应有内容")
  assert.ok(t.includes("【记忆仓库】"))
  assert.ok(t.length > 0, "必须能通过宿主 filter(s => s.text.length > 0)")
})

test("空记忆时同步提供器返回空串（不污染上下文）", async () => {
  const 原始 = 造回忆引导({ 有记忆: async () => false })
  let 缓存 = ""
  const 同步 = () => 缓存
  缓存 = (await 原始()) || ""
  assert.equal(同步(), "")
  assert.equal(同步().length > 0, false, "空串会被宿主 filter 掉，不注入")
})
