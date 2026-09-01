#!/usr/bin/env sh
# scripts/devnet-stop.sh —— 停止开发网络并保留链状态（容器收到 SIGTERM → avalanche network stop 保存快照）
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-stop: docker not found" >&2; exit 10; }
docker compose stop devnet
echo "devnet-stop: stopped (chain state preserved; 'scripts/devnet-start' resumes, 'scripts/devnet-reset' wipes)"
