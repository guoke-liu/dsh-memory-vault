// 外部转换器（MarkItDown）集成测试
//
// 重点：**没装时必须优雅降级**。这是开源适配性的核心 ——
// 不能因为用户没装 Python 工具，整个导入功能就不可用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { 需要外部转换, 探测转换器, 转换, 剥噪音, 清探测缓存, 需外部转换 } from '../lib/recall-extract.js'

let 过 = 0
let 挂 = 0
const 失败 = []
const 测 = (n, c, d) => { if (c) { 过++; console.log('  ✅ ' + n) } else { 挂++; 失败.push(n); console.log('  ❌ ' + n + (d ? ' → ' + d : '')) } }

console.log('—— 扩展名判定 ——')
测('PDF 需要转换', 需要外部转换('a.pdf'))
测('DOCX 需要转换', 需要外部转换('a.docx'))
测('XLSX 需要转换', 需要外部转换('a.xlsx'))
测('EPUB 需要转换', 需要外部转换('a.epub'))
测('HTML 需要转换', 需要外部转换('a.html'))
测('大写扩展名也认', 需要外部转换('A.PDF'))
测('JSON 不需要', !需要外部转换('a.json'))
测('Markdown 不需要', !需要外部转换('a.md'))
测('纯文本不需要', !需要外部转换('a.txt'))
测('无扩展名不需要', !需要外部转换('a'))

console.log('\n—— 噪音剥离（实测 markitdown 每次都打这些）——')
const 噪音 = `Error in cpuinfo: failed to parse the list of possible processors
onnxruntime cpuid_info warning: Failed to initialize PyTorch cpuinfo library
真正的错误在这里`
const 干净 = 剥噪音(噪音)
测('去掉了 cpuinfo', !干净.includes('cpuinfo'))
测('去掉了 onnxruntime', !干净.includes('onnxruntime'))
测('保留了真实错误', 干净.includes('真正的错误'), 干净)

test('探测与转换：装了就用，没装不影响其他功能', async () => {
  清探测缓存()
  const 探 = await 探测转换器({ 强制: true })
  console.log(`  探测结果：${探.ok ? '可用' : '不可用'} — ${探.原因.slice(0, 90)}`)

  if (!探.ok) {
    // 没装时：必须给出可操作的提示，而不是抛异常
    测('没装时给出安装指引', /pip install/.test(探.原因), 探.原因)
    测('没装时命令列表为空', Array.isArray(探.命令) && 探.命令.length === 0)
    const r = await 转换('/tmp/x.pdf')
    测('没装时转换返回失败而不抛异常', r.ok === false)
    return
  }

  // 装了：实测一次真转换
  测('探测给出可用命令', Array.isArray(探.命令) && 探.命令.length >= 1)

  const 根 = mkdtempSync(path.join(tmpdir(), 'ext-'))
  const html = path.join(根, 't.html')
  writeFileSync(html, '<h1>标题</h1><p>正文内容</p><ul><li>项目一</li></ul>')
  const r = await 转换(html)
  测('HTML 转换成功', r.ok === true, r.错误)
  测('保留标题结构', r.文本.includes('# 标题'), JSON.stringify(r.文本.slice(0, 40)))
  测('保留列表结构', r.文本.includes('项目一'))

  // 不存在的文件要失败而不是崩
  const r2 = await 转换(path.join(根, '不存在.pdf'))
  测('不存在的文件返回失败', r2.ok === false)
})

test('导入链路：HTML 走外部转换后能被切成条目', async () => {
  const 探 = await 探测转换器()
  if (!探.ok) {
    console.log('  ⏭  跳过（没装 MarkItDown）')
    return
  }
  const { 导入 } = await import('../lib/recall-import.js')
  const 根 = mkdtempSync(path.join(tmpdir(), 'impext-'))
  const html = path.join(根, 'note.html')
  writeFileSync(html, '<h1>2026-11-01</h1><p>这是导入的日记正文，足够长了吧。</p>')
  const r = await 导入({ 源文件: html, 目标目录: path.join(根, 'imp'), 默认来源: 'html' })
  测('导入成功', r.ok === true, r.错误)
  测('标记走了外部转换', r.走了外部转换 === true)
  测('切成 markdown 形状', r.形状 === 'markdown')
  测('至少 1 条', r.解析条数 >= 1)
})

test('recall-extract 全部断言', () => { if (挂 > 0) throw new Error(`${挂} 条失败：${失败.join(' / ')}`) })
