#!/bin/bash
# 逐个测试文件单独跑。
#
# 为什么不用 `node --test "test/*.test.mjs"`：
#   Node 22/24 的测试运行器用子进程 IPC 汇报结果，跑多了会偶发
#   `Unable to deserialize cloned data due to invalid or unsupported version.`
#   —— 实测单独跑同一个文件 10 次挂 5 次，加上 --test-concurrency=1 也照样挂。
#   直接 `node <file>` 跑就绕开了那条 IPC 通道，实测连跑 10 次稳。
#
# 输出格式兼容 Node 的两套记法：
#   Node 22/部分版本: `ℹ pass 4` / `ℹ fail 0`
#   Node 24:          `# pass 4` / `# fail 0`

PASS=0
FAIL=0
FAILED=""

for f in test/*.test.mjs; do
  OUT=$(node "$f" 2>&1)
  # 同一条 sed 吃掉两种前缀，免得换 Node 版本就哑火
  F=$(echo "$OUT" | sed -n 's/^[ℹ#][[:space:]]*fail[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)
  P=$(echo "$OUT" | sed -n 's/^[ℹ#][[:space:]]*pass[[:space:]]\{1,\}\([0-9]\{1,\}\).*/\1/p' | tail -1)

  if [ -z "$F" ]; then
    # 连 pass/fail 都没打出来，多半是启动就崩了 —— 必须算失败，不能当 0 跳过。
    # 踩过：最早这版只 grep `^# fail`，在打 `ℹ fail` 的 Node 版本上永远匹配不到，
    # 于是「0 失败」是个假象。
    FAIL=$((FAIL + 1))
    FAILED="$FAILED $f(没有输出pass/fail)"
    continue
  fi

  if [ "$F" != "0" ]; then
    FAIL=$((FAIL + 1))
    FAILED="$FAILED $f(fail=$F)"
  fi
  PASS=$((PASS + ${P:-0}))
done

echo "总计 pass=$PASS 失败文件=$FAIL"
if [ -n "$FAILED" ]; then
  echo "失败:$FAILED"
  exit 1
fi
