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
# shellcheck source=./_devnet-common.sh
. "$(dirname "$0")/_devnet-common.sh"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
command -v docker >/dev/null 2>&1 || { echo "devnet-verify: docker not found" >&2; exit 10; }
mkdir -p ./.devnet

# 网络名与容器内 RPC 地址都由公共件推导 —— 不能硬编码，理由见 _devnet-common.sh。
# 此前这里写死 `--network karmachain`（单机形态才有的网络），跨机形态下必然失败。
NETWORK="$(devnet_node_network "$DOMAIN")" || { echo "devnet-verify: 前置条件未满足（见上）" >&2; exit 10; }

# 不传 -w：镜像自带 WORKDIR=/workspace。
# MSYS_NO_PATHCONV=1：Git Bash 会把容器内路径当成本地路径去转换（/workspace → C:/Program Files/Git/workspace）；
# 该变量在其他 shell 上是无害的未知变量。
exec env MSYS_NO_PATHCONV=1 docker run --rm \
  --network "$NETWORK" \
  -v "$(pwd):/workspace" \
  -e KARMACHAIN_RPC_URL="$(devnet_container_rpc_url "$DOMAIN")" \
  karmachain/verify:local npm run verify -- "$@"
