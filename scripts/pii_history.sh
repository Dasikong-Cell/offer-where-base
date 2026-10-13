#!/bin/sh
# ============================================================================
# 手动跑「历史 blob PII 扫描」。与 .githooks/pre-push 第 6 步同一套管道，
# 只是默认范围不同（这里默认**全库历史**，钩子里只扫本次推送新增的部分）。
#
# 为什么是 .sh 而不是 npm 里一行管道：枚举部分必须由 **POSIX shell** 完成
# （本环境下 node 自建子进程会 EBUSY，见 scripts/pii_guard.ts 文件头），
# 而 npm 在 Windows 上走 cmd.exe —— `cut`/`awk`/`sort` 都不存在，管道会碎。
#
# 用法：
#   sh scripts/pii_history.sh                  # 扫全库历史（最彻底，慢一点）
#   sh scripts/pii_history.sh origin/main..HEAD  # 只扫某个区间
#   sh scripts/pii_history.sh HEAD~5..HEAD
# ============================================================================
set -e

RANGE="$1"
# ⚠️ 不用 `mktemp`：本机 `rm` 装了删除护栏（safe-delete），它拒绝带盘符前缀的路径
#    （实测 `[safe-delete][SAFE_DELETE_INVALID_PATH] embedded drive prefix is not allowed`），
#    于是 trap 里的 rm 会失败、临时文件留在盘上。改用 **仓库内 gitignored 的 _tools/**，
#    固定文件名直接覆盖写，连删除都不需要。
mkdir -p _tools
BLOBS="_tools/_pii_history_blobs.txt"

if [ -n "$RANGE" ]; then
  echo "▶ 扫描区间：$RANGE"
  git rev-list --objects "$RANGE"
else
  echo "▶ 扫描范围：全库历史（--all）"
  git rev-list --objects --all
fi \
  | cut -d' ' -f1 | sort -u \
  | git cat-file --batch-check='%(objectname) %(objecttype)' \
  | awk '$2=="blob"{print $1}' | sort -u > "$BLOBS"

echo "  唯一 blob 数：$(wc -l < "$BLOBS")"

NODE=node
if [ -x "./node/node.exe" ]; then NODE="./node/node.exe"; fi

git cat-file --batch < "$BLOBS" \
  | "$NODE" node_modules/tsx/dist/cli.mjs scripts/pii_history_guard.ts --stdin
