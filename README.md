# dsh-memory-vault

[![tests](https://github.com/guoke-liu/dsh-memory-vault/actions/workflows/tests.yml/badge.svg)](https://github.com/guoke-liu/dsh-memory-vault/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![version](https://img.shields.io/github/v/tag/guoke-liu/dsh-memory-vault)](https://github.com/guoke-liu/dsh-memory-vault/tags)

给 DeepSeek Harness 用的**记忆仓库**：把 QQ 里的图和聊天记录存下来，同一张图只存一份、
每张图有个编号，模型可以按关键词搜回来。

> **适合谁**：你有一个 QQ 机器人助手，想让它「记得」你以前发过的图、说过的话。
>
> **核心特点**：零第三方依赖 · 不需要向量库 · 不需要 GPU · 没有看图模型也能用。
> 全部数据在自己硬盘上，纯文本 + 原图，随时能直接打开看、能 grep、能备份。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 存原图 | 字节原样落盘，不转码、不缩放 |
| 自动去重 | 同一张图（内容相同）只存一份，不管发多少次 |
| 编号引用 | 每张图一个编号（`#1`、`#2`…），记忆里只记编号 |
| 引用回复 | 有人引用某张图说话，自动关联到那张图的编号 |
| 聊天记录 | 按天存纯文本，**私聊群聊分开**，群聊再按群号分目录 |
| AI 检索 | 模型能直接调 6 个工具（见「AI 工具」一节） |
| 三档存图模式 | 有/没有看图模型的用户都能用（见下） |
| 按人检索 | 聊天记录能按「谁说的」筛，编号或 QQ 号都认 |
| 外部记忆导入 | 能读 claude-mem 的导出 JSON，一行命令导进来 |
| 开放接入 | 别的插件能把记忆 `POST` 进来（只写不读，白名单 + 限流） |

### 它**不**做什么（先说清楚，省得装了才失望）

| 不做 | 原因 |
|---|---|
| **不替代 QQ 机器人** | 它只负责记忆，收发消息要靠 `qq-bridge` 之类的插件 |
| **不自动「看懂」图片** | 默认只记录尺寸/格式/体积。要真看懂，得自己接一个视觉模型（见下） |
| **不替代 fish-memory 之类的记忆插件** | 那类插件存「这件事很重要」的结论；这个库存「原始素材」 |
| **不做云端同步** | 数据只在本机，要同步自己用网盘/Git |
| **不修改你的 QQ 消息** | 只读 OneBot 接口，不往外发任何东西 |

---

## 三档存图模式（重点）

不是所有人都有「能把图翻译成文字」的模型。所以给三档，在**设置页**里选：

| 模式 | 存什么 | 同一张 796KB 的图，实际占多少 |
|---|---|---|
| `both` | 原图 + 文字描述 | 约 802 KB |
| `text` | **只存文字描述，不存原图** | **约 482 字节** |
| `image` | 只存原图，不要文字 | 约 801 KB |

**没有看图模型就选 `text`。** 一张图只占几百字节。

> `text` 模式下原图**不会被写到磁盘上**——只在内存里算一次指纹用于去重，算完就丢。

---

## 安装

```bash
# 1. 装依赖
cd ~/.dsh/profiles/<你的profile>
pnpm add /path/to/dsh-memory-vault

# 2. 把这个包名加进 package.json 的 dsh.profile.bundles 数组
#    "dsh-memory-vault"

# 3. 重启
dsh --profile <你的profile>
```

装好后，DSH 设置页左侧会多一项「记忆仓库」。

---

## 三分钟上手

假设你已经有 `qq-bridge` 在跑、OneBot 在 `127.0.0.1:3000`。

```bash
# 1) 装进 profile
cd ~/.dsh/profiles/<你的profile>
pnpm add /path/to/dsh-memory-vault
#   → 把 "dsh-memory-vault" 加进 package.json 的 dsh.profile.bundles
dsh --profile <你的profile>        # 重启
```

```yaml
# 2) 在 cordis.patch.yml 里指一下 OneBot
- id: dsh-memory-vault
  config:
    onebotUrl: 'http://127.0.0.1:3000'
    ownerQq: '你的QQ号'
    轮询秒: 60
```

```bash
# 3) token 用环境变量，别写进配置文件
export ONEBOT_TOKEN='你的onebot token'
```

**4) 打开 DSH 设置页 → 左侧「记忆仓库」**，选存图模式：

| 你的情况 | 选 |
|---|---|
| 有视觉模型（能让模型看图） | `both` |
| 没有视觉模型 | `text`（一张图只占几百字节） |
| 只想要原图 | `image` |

**5) 验证它活着：**

```bash
ls ~/.dsh/memory-vault/            # 应该有 config.json
cat ~/.dsh/memory-vault/chat/private/$(date +%F).txt   # 一天后应该有内容
```

**6) 让模型搜一次：**

```
你：帮我找找之前发过的那张猫图
它：（调 memory_search）
```

---

## 常见问题

**Q：装了但没有任何记录？**

按顺序查：

```bash
# a) 插件活没活 —— 看有没有注册成功
tail -20 ~/.dsh/memory-vault/diag.log

# b) OneBot 通不通
curl -H "Authorization: Bearer $ONEBOT_TOKEN" http://127.0.0.1:3000/get_login_info

# c) 开关开没开
cat ~/.dsh/memory-vault/config.json
```

常见原因：`启用私聊` 没开 / `ownerQq` 填错 / OneBot token 没设。

**Q：图片库是 0 张，但聊天记录有内容？**

正常。`启用群聊` 只管**收群图片**，`记群聊聊天` 只管**记群文字**，两个开关各管各的。

**Q：`曾用名` 越来越长？**

已修。同一昵称只记一次 + 上限 10 条。如果你的库是旧版本建的，可以手动清一下
`people.json` 里的重复项。

**Q：能改成存到别的地方吗？**

能。设置页「库目录」填绝对路径即可。**改之前先把旧目录拷过去**，它不会自动迁移。

**Q：数据会传到云端吗？**

不会。全部在本机磁盘上，除非你自己接了联网的视觉模型。

**Q：怎么备份？**

整个目录拷走就行，结构和普通文件一样：

```bash
tar czf memory-vault-backup-$(date +%F).tar.gz -C ~/.dsh memory-vault
```

**Q：换电脑怎么迁移？**

`tar` 打包 → 在新机器解开到同一路径 → 重启。原图、索引、人物表全是相对路径，不用改配置。

**Q：支持多个 QQ 号吗？**

支持。每个 QQ 号独立一个编号（`p1`、`p2`…），**不合并**。
查询时用 `chat_search({ person: 'p2' })` 或 QQ 号都行。

---

## 配置

### 设置页（推荐）

设置页里能改：存图模式、启用私聊、启用群聊、库目录。改完立即生效，不用重启。

配置存在 `~/.dsh/memory-vault/config.json`，也可以直接改这个文件。

### 收图所需的 OneBot 配置

在 profile 的 `cordis.patch.yml` 里：

```yaml
- id: dsh-memory-vault
  config:
    onebotUrl: 'http://127.0.0.1:3000'   # OneBot 11 HTTP 地址
    ownerQq: '123456789'                 # 只收这个人的私聊
    轮询秒: 60                            # 多久扫一轮
```

Access-Token 建议用环境变量，别写进配置文件：

```bash
export ONEBOT_TOKEN='你的token'
```

---

## AI 工具（6 个）

模型可以直接调用这 6 个工具。**搜索不需要向量库、不需要 GPU、不需要联网。**

| 工具 | 参数 | 做什么 | 典型问法 |
|---|---|---|---|
| `memory_search` | `query`, `limit` | 按关键词搜图**描述** | 「找一下那张橘猫表情包」 |
| `memory_get` | `no` | 按编号查详情 | 「#3 那张图是谁发的」 |
| `memory_recent` | `limit` | 最近收到的图 | 「我刚刚发了什么图」 |
| `chat_search` | `query` + 可选 `chatType`/`groupId`/`person`/`limit` | 搜聊天记录 | 「我们之前聊过什么关于宝宝的事」 |
| `person_list` | — | 列出认识的所有号 | 「你都记得谁」 |
| `import_memories` | `path`, `source` | 导入外部记忆文件 | 「把这个 claude-mem 导出导进来」 |

### 返回值长什么样

```js
// memory_search({ query: '橘猫', limit: 3 })
{
  命中数: 1,
  结果: [{ no: 3, text: '一只橘猫眯眼大笑，底部文字「哈哈哈哈」', score: 2, imageSha: '…', refCount: 4, lastSeen: 1793516495058 }]
}

// memory_get({ no: 3 })
{
  编号: 3, 描述: '…', 谁发的: '小明(p1)', 什么时候: '2026-11-01 22:01',
  被引用次数: 4, 有原图: true, 原图路径: '/root/.dsh/memory-vault/objects/…gif'
}

// chat_search({ query: '宝宝', chatType: 'private', person: 'p2' })
{
  命中数: 2,
  结果: [{ 日期: '2026-11-01', 类型: '私聊', 群号: '', 内容: '[22:01:24] 小明(p2): 宝宝' }]
}
```

### 中文分词怎么做的

2 字滑窗，纯本地计算，零依赖：

```
"橘猫"           → ["橘猫"]
"腾讯云轻量服务器" → ["腾讯","讯云","云轻","轻量","量服","服务","务器"]
```

好处：搜「猫」能命中「橘猫」，搜「服务」能命中「服务器」。
代价：没有同义词（搜「猫咪」找不到只写了「猫」的图）。

### ⚠️ 给写插件的人：工具实现的两条硬规矩

如果你照这个插件写自己的工具，这两条必须遵守，否则**模型收不到任何结果**：

1. **`output.render()` 必须返回内容块数组**，不是字符串
   ```js
   // ❌ 错：宿主会在 result.content.some(...) 处抛 content.some is not a function
   render: (args, v) => `命中 ${v.命中数} 条`
   // ✅ 对
   render: (args, v) => [{ type: 'text', text: `命中 ${v.命中数} 条` }]
   ```
2. **`parameters` 用属性映射**，不是 JSON Schema
   ```js
   // ❌ 错：{ type:'object', properties:{...} }
   // ✅ 对：
   parameters: { query: { type: 'string', required: true }, limit: { type: 'number' } }
   ```

这两条是在实际使用中踩出来的（模型说「工具闹脾气了」，日志里是 `content.some is not a function`）。
单测全绿、配置树干净、日志无报错，**这三样都不等于工具可用** —— 必须模拟模型真调一次，
看它到底拿到什么文字。

---

## 和其他插件的兼容性

这是最多人关心的问题，逐条说清楚。

### 一、依赖关系

| 项 | 情况 |
|---|---|
| 第三方 npm 依赖 | **零**。只用了 Node 内置模块（`node:fs`、`node:crypto`、`node:path`） |
| peer 依赖 | 无 |
| Node 版本 | **>= 22**（用了 `node --test` 和 `??=`） |
| 需要 GPU / 向量库 | 不需要 |
| 需要联网 | 不需要（除非你自己接了视觉模型） |

### 二、DSH 版本

`package.json` 里已经声明了兼容性：

```json
"dsh": {
  "compatibility": {
    "dshReleases": {
      "0.2.1-rc.5": "compatible",
      "0.2.0-rc.2": "compatible"
    }
  }
}
```

**实测跑过**：云端 `0.2.1-rc.5`、本机 `0.2.0-rc.2`，两边的 6 个工具都能正常注册和调用。

### 三、和别的插件会不会冲突

| 冲突面 | 这个插件怎么做 | 会不会撞 |
|---|---|---|
| **工具名** | 全部带 `memory_` / `chat_` / `person_` / `import_` 前缀 | 不会。除非别人也起同名工具 |
| **HTTP 路由** | 只用 `/dsh-memory-vault/*` 三个路径 | 不会 |
| **cordis 服务** | 只**消费** `webServer`/`tools`/`timer`/`systemPrompt`，**不提供**任何新服务 | 不会 |
| **全局变量** | 只有一个 `ctx.__imgArchiveCollector`，挂在 cordis ctx 上 | 不会（不污染 globalThis） |
| **系统提示词** | 用 `systemPrompt.context()`（追加到对话末尾），**不用 `section()`** | 不会。`section` 会让整段 prompt 缓存失效（实测贵 20 倍） |
| **配置文件** | 只写 `~/.dsh/memory-vault/` 一个目录 | 不会 |

### 四、和 `qq-bridge` 的关系（实际使用中最常一起出现）

**它们不冲突，是分工关系：**

| 插件 | 负责 |
|---|---|
| `dsh-qq-bridge` | 收 QQ 消息 → 交给模型 → 把回复发回去 |
| `dsh-memory-vault`（本插件） | 你指定要留的东西（图、聊天记录）另存一份，供以后检索 |

**两个插件读的是同一个 OneBot 接口，互不干扰。** 桥接走它的轮询，本插件走自己的定时器。

> ⚠️ **已知现象（不是本插件的问题）**：
> `qq-bridge` 遇到**引用消息**时，正文里只写一句 `[引用了一条消息]`，被引用的图**不会**传给它。
> 本插件会自己反查被引用的原图并用描述器生成说明，通过系统提示词补进去。
> 如果你不用本插件，这个信息就彻底丢了。

### 五、和 `fish-memory` 之类「记忆插件」的关系

**可以同时装，各管一段：**

| 插件 | 存什么 | 适合回答 |
|---|---|---|
| `fish-memory` 类 | **结论**：「主人喜欢橘猫」「约定每周五聊天」 | 「记得我说过什么吗」 |
| `dsh-memory-vault`（本插件） | **原始素材**：发过的每张图、每句话 | 「我上个月发的那张图呢」 |

两者不抢数据、不抢工具名、不抢路由。**同时装不会有任何冲突。**

### 六、和别的记忆插件交换数据

两条路：

**① 主动导进来**（本插件拉别人的数据）

目前支持 **`claude-mem` 的导出 JSON**：

```bash
# 先在 claude-mem 那边导出
npx tsx scripts/export-memories.ts "关键词" export.json

# 让模型调（或直接调工具）
import_memories({ path: '/path/to/export.json', source: 'claude-mem' })
```

字段映射：

| claude-mem | 本插件 |
|---|---|
| `observations[].title` / `.text` | 标题 / 内容 |
| `observations[].type` | tags（如 `discovery`） |
| `observations[].memory_session_id` | tags（`session:xxx`） |
| `observations[].created_at_epoch` | 时间戳 |
| `summaries[]` | 加前缀「摘要：」 |
| `prompts[]` | 加前缀「提示：」 |
| `sessions[]` | **不导入**（只是元数据） |

去重规则：同一 `source` + 同一 `text` 视为同一条，重复导入自动跳过。

**② 被动收进来**（别人推给本插件）

`POST /dsh-memory-vault/ingest`，**只写不读**：

```bash
curl -X POST http://127.0.0.1:6600/dsh-memory-vault/ingest \
  -H 'Content-Type: application/json' \
  -d '{"type":"memo","source":"my-plugin","title":"标题","text":"内容","tags":["tag1"]}'
```

四道闸，缺一不可：

| 闸 | 规则 |
|---|---|
| 体积 | 请求体 ≤ 512 KB |
| 白名单 | `source` 必须在设置页「允许的插件」里，**默认空 = 全拒**（403） |
| 限流 | 每个 source 每分钟 60 次（429） |
| 校验 | `type` 只能是 `memo` / `chat` / `text` |

**没有任何查询或删除接口** —— 这是刻意的边界，防止别的插件读你/删你的记忆。

---

## 数据长什么样

```
~/.dsh/memory-vault/
├── config.json         设置页的配置
├── index.json          图片索引（原图模式下）
├── objects/            原图，按 sha256 命名
├── descriptions.json   文字描述库（文字模式下）
└── people.json         QQ 号 ↔ 编号对照
```

### index.json

```json
{
  "version": 1,
  "nextNo": 3,
  "images": {
    "<sha256>": {
      "no": 1,
      "sha256": "…",
      "ext": "gif",
      "bytes": 796928,
      "firstSeen": 1793516495058,
      "refs": [{ "messageId": "1351481316", "pid": "p1", "time": 1793510392000 }],
      "quotedBy": [{ "messageId": "2126890218", "pid": "p1", "time": 1793517042014 }]
    }
  }
}
```

- `refs` —— 这张图**被发出来**的记录
- `quotedBy` —— 这张图**被引用**的记录

### people.json

QQ 号只在这里出现一次，图片引用里只写 `pid`：

```json
{
  "nextNo": 2,
  "byQq": { "10000001": "p1" },
  "people": {
    "p1": { "qq": "10000001", "nickname": "小明", "曾用名": [], "refs": 2 }
  }
}
```

---

## 安全说明

- 图片存在本地磁盘，**不会上传到任何地方**
- Access-Token 只从配置或环境变量读，不写进代码、不打进日志
- 库目录权限默认跟随系统 umask，建议放在只有你自己能读的位置

---

## 已知限制

- **群聊图默认不收**（`启用群聊` 默认关）
- **`text` 模式下原图不可恢复**——只留了文字描述
- 文字描述从哪来：见下节「描述从哪来」
- 关键词搜索是字面匹配，同义词搜不到（搜「猫」找不到写「小猫」的）
- 引用消息只支持 OneBot 的 `reply` 段格式

---

## 聊天记录

聊天按天存成纯文本，**私聊和群聊分开**，群聊再按群号分目录：

```
<库根>/chat/
├── .seen.json                         去重表（按 messageId）
├── private/
│   └── 2026-11-01.txt                 私聊：一天一个文件
└── group/
    └── 123456789/
        └── 2026-11-01.txt             群聊：群号/日期
```

每行一条，格式固定：

```
[13:19:52] 小明(p1): 今天天气不错
[16:53:30] 乌鸡麻黑(p5): 老师你好。老师再见
```

- 时间一律**北京时间**，不受机器时区影响
- 群里优先用**群名片**（比 QQ 昵称更能认人）
- 同一条消息按 `messageId` 去重，重复拉取不会写两次
- 换行压成空格，保证一条消息只占一行

### 搜聊天

模型调 `chat_search`：

```js
chat_search({ query: '大肥鱼' })                      // 搜全部
chat_search({ query: '老师', chatType: 'group' })     // 只搜群聊
chat_search({ query: '小明', chatType: 'private' })   // 只搜私聊
chat_search({ query: '散课', groupId: '123456789' }) // 只搜某个群
```

---

## 描述从哪来（没有看图模型也能用）

`text` 和 `both` 模式需要「图片描述」。你说没有看图模型，插件会自动降级。

### 默认：元信息描述（零依赖，人人可用）

不需要任何模型，直接读图片文件头，生成：

```
一张 JPEG，300x230，6.6 KB
一张 GIF 动图，320x240，1.2 MB
一张 PNG，1116x2480，191.6 KB
```

能搜到「宽高」「格式」「动图」这类关键词。**不认识的格式会写「尺寸未知」，不会报错。**

### 进阶：接你自己的看图模型

有视觉模型的话，接一个自定义描述器，描述就会变具体：

```js
import { createDescriber } from 'dsh-memory-vault/lib/describer.js'

const describer = createDescriber({
  自定义描述器: async (bytes, meta) => {
    // 调你的视觉模型，返回一句中文描述
    return await 我的视觉模型(bytes)
  },
})
```

> 描述器抛错或返回空 → **自动降级回元信息**，不会中断收图。

---

## 开发

```bash
node --test test/*.test.mjs
```

零第三方依赖，只用 Node 内置模块。

许可证：[MIT](LICENSE)
