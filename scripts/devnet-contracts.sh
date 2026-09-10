#!/usr/bin/env sh
# scripts/devnet-contracts.sh —— 列出链上所有合约（创世内置 + 运行期部署）。
#
# 用法：scripts/devnet-contracts.sh [--json] [--from <block>] [--no-probe]
# 退出码：0 成功 | 1 链不可达 | 10 前置依赖缺失
#
# 只用公开 RPC，因此在容器内运行（与 devnet-verify 同一模式，无需宿主装 Node）。
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-contracts: $ENV_FILE 不存在 —— 先运行 scripts/devnet-render" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"
# shellcheck source=./_devnet-common.sh
. "$(dirname "$0")/_devnet-common.sh"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
command -v docker >/dev/null 2>&1 || { echo "devnet-contracts: docker not found" >&2; exit 10; }

# 此前这里是 `docker compose run --rm verify …`，它把容器落在**工具项目自己**的默认网络上，
# 接不到节点 —— 2026-09-08 在跨机形态下实测：容器内连 127.0.0.1 上的宿主 RPC 端口（那是容器自己），
# ECONNREFUSED。改为与 devnet-verify 完全同一条路径：接到节点网络、显式给出代理地址。
# 工具镜像是本地构建的：不存在时 docker 会去 pull 并报一句指向错误方向的
# "pull access denied … may require docker login"。理由见 _devnet-common.sh。
devnet_require_verify_image || { echo "devnet-contracts: 前置条件未满足（见上）" >&2; exit 10; }

NETWORK="$(devnet_node_network "$DOMAIN")" || { echo "devnet-contracts: 前置条件未满足（见上）" >&2; exit 10; }

# MSYS_NO_PATHCONV=1：Git Bash 会把容器内路径当成本地路径去转换。
exec env MSYS_NO_PATHCONV=1 docker run --rm \
  --network "$NETWORK" \
  -v "$(pwd):/workspace" \
  -e KARMACHAIN_RPC_URL="$(devnet_container_rpc_url "$DOMAIN")" \
  karmachain/verify:local node tools/inspect/list-contracts.mjs "$@"
