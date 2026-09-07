#!/usr/bin/env sh
# scripts/devnet-topology.sh —— 校验并展示拓扑（功能 002 / US5）。
#
# 输出：节点 → 故障边界归属、每边界验证者数、推导出的容错上限、共享失效因素告警。
# 输出格式见 specs/002-resilient-validator-network/contracts/cli-interface.md。
#
# 用法：scripts/devnet-topology.sh [--deployment <name>] [--json] [--protocol <path>]
# 退出码：0 拓扑合法 | 10 声明缺失或不可读 | 13 拓扑违反容错约束
#
# 这是**部署前**的检查，不需要链在运行 —— 它只读声明。
# 与 devnet-verify 同一模式在容器内跑，因此宿主不需要装 Node（README 的前置依赖只有 Docker）。
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "devnet-topology: docker not found" >&2; exit 10; }
exec docker compose run --rm verify node tools/protocol/validate-topology.mjs "$@"
