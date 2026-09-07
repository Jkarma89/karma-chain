#!/usr/bin/env sh
# scripts/devnet-verify.sh —— 对运行中的开发网络执行 13 项自动化验证（薄封装）。
#
# 功能 002：验证容器接到节点所在的容器网络上，逐节点检查因此可用
# （001 时节点只监听容器内回环，node/validator 两项只能降级为 SKIP）。
#
# 退出码：0 全部通过 | 1 任一失败 | 10 前置依赖缺失
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-verify: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
command -v docker >/dev/null 2>&1 || { echo "devnet-verify: docker not found" >&2; exit 10; }
mkdir -p ./.devnet

# 走 RPC 代理而不是某个验证者：代理是对外的唯一入口，验证应当从与第三方相同的位置发起
# 不传 -w：镜像自带 WORKDIR=/workspace。
# MSYS_NO_PATHCONV=1：Git Bash 会把容器内路径当成本地路径去转换（/workspace → C:/Program Files/Git/workspace）；
# 该变量在其他 shell 上是无害的未知变量。
exec env MSYS_NO_PATHCONV=1 docker run --rm \
  --network karmachain \
  -v "$(pwd):/workspace" \
  -e KARMACHAIN_RPC_URL="http://karmachain-rpc-${DOMAIN}:${KARMACHAIN_RPC_PORT}${KARMACHAIN_RPC_PATH}" \
  karmachain/verify:local npm run verify -- "$@"
