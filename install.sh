#!/usr/bin/env bash
# ============================================================================
# install.sh —— 把记忆仓库装进一个 DSH profile（薄壳，真正干活的是 install.mjs）
#
# 用法：
#   ./install.sh                 # 自动找 profile（只有一个时）
#   ./install.sh myprofile       # 指定 profile 名
#   ./install.sh --dry           # 只打印要做什么，不落盘
#
# 【为什么改成壳】原来这份是纯 bash，Windows 用户得先装 Git Bash / WSL 才能跑 ——
#   而机器上既然有 DSH，就一定有 Node ≥ 22。逻辑搬进 install.mjs（三系统通用），
#   这个文件只转调。Windows 上直接跑：node install.mjs
# ============================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 找不到 node。本包的安装器要在 Node ≥ 22 下跑。" >&2
  exit 1
fi
exec node "$HERE/install.mjs" "$@"
