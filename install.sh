#!/usr/bin/env bash
# ============================================================================
# install.sh —— 把记忆仓库装进一个 DSH profile
#
# 用法：
#   ./install.sh                 # 自动找 profile（只有一个时）
#   ./install.sh myprofile       # 指定 profile 名
#   ./install.sh --dry           # 只打印要做什么，不落盘
#
# 它做三件事，都是 DSH 官方的插件安装流程（不手工改配置树）：
#   1. 在 profile 的 package.json 里加一条 link: 依赖
#   2. 把插件名加进 dsh.profile.bundles
#   3. 跑 dsh plugin install，让 pnpm 建好链接
#
# ⚠️ 不要手写 cordis.patch.yml —— 本包自带 dsh.bundle.patch，
#    装依赖时 DSH 会自动应用，手加会重复注册。
# ⚠️ 收图相关的配置（onebotUrl / ownerQq / 群号）装完要自己填，
#    不填也能启动，只是不会去拉聊天（见 README「两个坑」）。
# ============================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_NAME='dsh-memory-vault'
DRY=0
PROFILE=''

for arg in "$@"; do
  case "$arg" in
    --dry) DRY=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "未知参数：$arg" >&2; exit 2 ;;
    *) PROFILE="$arg" ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

# ── 版本门槛：本包 engines 是 node >= 22 ─────────────────────────────────
if command -v node >/dev/null 2>&1; then
  NODE_V="$(node -p 'process.versions.node')"
  NODE_MAJOR="${NODE_V%%.*}"
  if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
    die "Node 版本太低：现在是 v$NODE_V，本插件要求 >= 22。
   升级 Node 后再跑一次（或换个 Node 22 的 profile 环境）。"
  fi
  say "✅ node v$NODE_V"
fi

# ── 找 dsh ───────────────────────────────────────────────────────────────
find_dsh() {
  for c in "$(command -v dsh 2>/dev/null || true)" \
           /usr/local/bin/dsh \
           /usr/bin/dsh \
           /opt/dshapp/runtime/node_modules/.bin/dsh; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}
DSH="$(find_dsh)" || die "找不到 dsh 命令。请先安装 DeepSeek Harness，或把 dsh 加进 PATH。
   已知位置都试过了：PATH / /usr/local/bin /usr/bin /opt/dshapp/runtime/node_modules/.bin"

say "✅ dsh: $DSH"

# ── 找 profile 根目录 ────────────────────────────────────────────────────
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILES_DIR="$DSH_HOME/profiles"
[ -d "$PROFILES_DIR" ] || die "找不到 profile 目录：$PROFILES_DIR
   （DSH_HOME 现在是 $DSH_HOME，如果装到别处请 export DSH_HOME=...）"

if [ -z "$PROFILE" ]; then
  # ⚠️ bash 变量名必须是 ASCII —— 用中文名会报 syntax error（踩过）
  cands=()
  for d in "$PROFILES_DIR"/*/; do
    [ -f "${d}package.json" ] && cands+=("$(basename "$d")")
  done
  case "${#cands[@]}" in
    0) die "在 $PROFILES_DIR 下没有任何 profile（没有带 package.json 的目录）" ;;
    1) PROFILE="${cands[0]}"; say "ℹ️  自动选中唯一的 profile：$PROFILE" ;;
    *) die "有多个 profile，请指定一个：${cands[*]}
   例如：./install.sh ${cands[0]}" ;;
  esac
fi

PROFILE_DIR="$PROFILES_DIR/$PROFILE"
[ -f "$PROFILE_DIR/package.json" ] || die "profile 不存在：$PROFILE_DIR"

say "✅ profile: $PROFILE  ($PROFILE_DIR)"
say "   插件将 link 到：$HERE"

if [ "$DRY" = 1 ]; then
  say ""
  say "── --dry：只显示计划，不落盘 ──"
  say "1. $PROFILE_DIR/package.json 的 dependencies 里加 \"$PKG_NAME\": \"link:$HERE\""
  say "2. 同文件的 dsh.profile.bundles 里加 \"$PKG_NAME\""
  say "3. 在 $PROFILE_DIR 跑：$DSH plugin --profile $PROFILE install"
  exit 0
fi

# ── 改 package.json（先备份）─────────────────────────────────────────────
BAK="$PROFILE_DIR/package.json.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PROFILE_DIR/package.json" "$BAK"
say "✅ 已备份 package.json → $(basename "$BAK")"

node - "$PROFILE_DIR/package.json" "$PKG_NAME" "link:$HERE" <<'NODE' || die "改 package.json 失败（原文件已备份：$BAK）"
const fs = require('fs')
const [file, name, link] = process.argv.slice(2)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))

pkg.dependencies = pkg.dependencies || {}
pkg.dependencies[name] = link

pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name)

fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log('   已写入 dependencies 与 dsh.profile.bundles')
NODE

# ── 确保 pnpm 可用 ───────────────────────────────────────────────────────
# DSH 的 plugin install 内部调用 pnpm。很多机器上 pnpm 没独立安装，
# 但有 corepack（Node 自带）—— 这时给一个临时 shim，装完就撤。
SHIM_DIR=''
cleanup_shim() { [ -n "$SHIM_DIR" ] && rm -rf "$SHIM_DIR" || true; }
trap cleanup_shim EXIT

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    SHIM_DIR="$(mktemp -d)"
    cat > "$SHIM_DIR/pnpm" <<'SHIM'
#!/bin/sh
exec corepack pnpm "$@"
SHIM
    chmod +x "$SHIM_DIR/pnpm"
    export PATH="$SHIM_DIR:$PATH"
    say "ℹ️  本机没有 pnpm，已用 corepack 临时顶替（装完自动撤掉）"
  else
    die "找不到 pnpm。请先装：
   npm i -g pnpm        （或）   corepack enable"
  fi
fi

# ── 装依赖 ───────────────────────────────────────────────────────────────
say ""
say "▶ 正在安装依赖（可能会下载一些包，慢的话等一下）…"
if ! ( cd "$PROFILE_DIR" && "$DSH" plugin --profile "$PROFILE" install ); then
  cp "$BAK" "$PROFILE_DIR/package.json"
  die "安装失败，已把 package.json 还原。
   排查建议：进 $PROFILE_DIR 手动跑 '$DSH plugin --profile $PROFILE install' 看完整报错。"
fi

# ── 验收：配置树里必须恰好出现 1 次 ──────────────────────────────────────
say ""
say "▶ 验收配置树…"
DUMP="$("$DSH" --profile "$PROFILE" --dump-config 2>&1 || true)"
# ⚠️ 只数「条目头」`- id: <包名>`，不要数裸包名 ——
#    包名在 dump 里会自然出现好几次（注释 + id 行 + name 行），
#    数裸包名会误判成「重复注册」。小鱼日记那边第一次就踩了这个坑。
# ⚠️ id 有的带引号有的不带：`@local/xxx` 这种会写成 '- id: '@local/xxx''，
#    本包是 '- id: dsh-memory-vault'（无引号）。两种都要认，否则永远数出 0。
CNT="$(printf '%s' "$DUMP" | grep -cE "^- id: ['\"]?${PKG_NAME}['\"]?\s*$" || true)"
SKIP="$(printf '%s' "$DUMP" | grep -c 'skipping profile bundle' || true)"

say "   注册条目数：$CNT  （应为 1，多于 1 说明被重复注册）"
say "   skipping 警告：$SKIP  （应为 0）"

if [ "$CNT" = "1" ] && [ "$SKIP" = "0" ]; then
  say ""
  say "🎉 装好了。重启 DSH 让插件生效："
  say "   systemctl restart <你的 dsh 服务名>      # 如果是 systemd 在跑"
  say "   或直接重开 dsh $PROFILE"
  say ""
  say "接下来两件事（不填也能启动，只是不会去拉聊天）："
  say "   1. 编辑 $PROFILE_DIR/cordis.patch.yml，给 dsh-memory-vault 填："
  say "      onebotUrl: 'http://127.0.0.1:3000'   ownerQq: '你的QQ号'"
  say "      群号: '730783833,859310353'   ← 多个群用英文逗号、别加空格；不填 = 一条群聊都不拉，且不报错"
  say "   2. onebotToken 建议用环境变量 ONEBOT_TOKEN，别写进配置文件"
  say ""
  say "装好后设置页左侧会多一项「记忆仓库」，存图模式（both/text/image）在那里改，改完立刻生效、不用重启。"
else
  say ""
  say "⚠️ 装上了但验收不通过。请把上面两行数字贴给维护者。"
  say "   回滚：cp '$BAK' '$PROFILE_DIR/package.json' && cd '$PROFILE_DIR' && '$DSH' plugin --profile '$PROFILE' install"
  exit 1
fi
