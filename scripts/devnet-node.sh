#!/usr/bin/env sh
# scripts/devnet-node.sh —— 单节点生命周期控制，用于故障注入（薄封装）。
# 用法：scripts/devnet-node.sh <pause|resume|stop|start|status> <node>
#   pause/resume 用 SIGSTOP/SIGCONT，完全可逆，推荐用于故障演练。
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-node: docker not found" >&2; exit 10; }
exec docker compose exec -T devnet devnet-node "$@"
