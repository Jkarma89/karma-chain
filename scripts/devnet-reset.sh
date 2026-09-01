#!/usr/bin/env sh
# scripts/devnet-reset.sh —— 重置到创世：删除容器与链数据卷（FR-004）。下次 devnet-start 从创世重新部署。
# 无交互（可无人值守）。不删除镜像。
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-reset: docker not found" >&2; exit 10; }
docker compose down -v --remove-orphans
echo "devnet-reset: chain data removed (volume karmachain-devnet-data). 'scripts/devnet-start' will recreate the chain from genesis."
