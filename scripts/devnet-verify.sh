#!/usr/bin/env sh
# scripts/devnet-verify.sh —— 对运行中的开发网络执行 13 项自动化验证（薄封装）。
# 退出码：0 全部通过 | 1 任一失败 | 10 Docker 不可用（契约见 specs/001-*/contracts/cli-interface.md）
# 透传参数，例如：scripts/devnet-verify.sh --quick
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-verify: docker not found" >&2; exit 10; }
mkdir -p ./.devnet
exec docker compose run --rm verify npm run verify -- "$@"
