#!/usr/bin/env sh
# scripts/devnet-status.sh —— 每节点健康/共识状态（薄封装）。
# 退出码：0 全部健康 | 1 存在不健康节点 | 2 网络未运行 | 10 Docker 不可用
# 透传参数，例如：scripts/devnet-status.sh --json
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-status: docker not found" >&2; exit 10; }
exec docker compose exec -T devnet devnet-status "$@"
