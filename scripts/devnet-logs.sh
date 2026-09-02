#!/usr/bin/env sh
# scripts/devnet-logs.sh —— 按节点查看日志（薄封装）。默认脱敏 staking 密钥材料（FR-026）。
# 用法：scripts/devnet-logs.sh [<node>] [--chain] [--file <name>] [-f] [-n N] [--raw]
#   不带参数时列出可选节点与日志文件。
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-logs: docker not found" >&2; exit 10; }
exec docker compose exec -T devnet devnet-logs "$@"
