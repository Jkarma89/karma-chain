#!/usr/bin/env sh
# scripts/devnet-contracts.sh —— 列出链上所有合约（创世内置 + 运行期部署）。
#
# 用法：scripts/devnet-contracts.sh [--json] [--from <block>] [--no-probe]
# 退出码：0 成功 | 1 链不可达 | 10 Docker 不可用
#
# 只用公开 RPC，因此在容器内运行（与 devnet-verify 同一模式，无需宿主装 Node）。
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-contracts: docker not found" >&2; exit 10; }
exec docker compose run --rm verify node tools/inspect/list-contracts.mjs "$@"
