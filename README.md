# dsh-memory-vault

给 DeepSeek Harness 用的**记忆仓库**：把私聊里的图存下来，同一张图只存一份，每张图有个编号；
模型可以按关键词搜回来。

> 适合：你有一个 QQ 机器人助手，想让它「记得」你以前发过的图。

---

## 它能做什么

| 能力 | 说明 |
|---|---|
| 存原图 | 字节原样落盘，不转码、不缩放 |
| 自动去重 | 同一张图（内容相同）只存一份，不管发多少次 |
| 编号引用 | 每张图一个编号（`#1`、`#2`…），记忆里只记编号 |
| 引用回复 | 有人引用某张图说话，自动关联到那张图的编号 |
| 聊天记录 | 按天存纯文本，**私聊群聊分开**，群聊再按群号分目录 |
| AI 检索 | 模型能直接调 `memory_search` / `memory_get` / `memory_recent` / `chat_search` |
| 三档存图模式 | 有/没有看图模型的用户都能用（见下） |

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

## AI 工具

模型可以调用这三个工具：

| 工具 | 参数 | 用途 |
|---|---|---|
| `memory_search` | `query`, `limit` | 按关键词搜图片描述 |
| `memory_get` | `no` | 按编号查详情：谁发的、什么时候、原图在不在 |
| `memory_recent` | `limit` | 最近收到的图 |

**搜索不需要向量库、不需要 GPU、不需要联网。** 中文按 2 字滑窗分词，纯本地计算：

```
"橘猫" → ["橘猫"]
"腾讯云轻量服务器" → ["腾讯","讯云","云轻","轻量",...,"服务","务器"]
```

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
