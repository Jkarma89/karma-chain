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
mkdir -p ./.devnet

# 挂载**按子目录**，不整仓覆盖 /workspace ——
# 整仓挂载会把镜像里的 /workspace/node_modules 一起盖掉，于是在**宿主没跑过 npm ci**
# 的机器上报 `Cannot find package 'ajv' imported from /workspace/tools/protocol/load.mjs`。
# win-1 上一直没暴露，只因为那台机器的宿主仓库里有 node_modules（2026-09-10 在 win-2 撞到）。
#
# 这三个就是容器内的工具真正需要的全部：blockchain（协议参数、创世、建链制品、开发账户）、
# tools（工具自身，含面板前端）、.devnet（读容器事实 / 写验证报告）。
# docker/ 与 docs/ 只有 render 生成器读（走 scripts/devnet-render），tests/ 与 specs/
# 没有任何 tools 读。node_modules 与 package.json 一律取自镜像 ——
# 因此**改 package-lock.json 必须重建镜像**（Dockerfile 顶部已注明）。
#
# 挂载集合由 tests/unit/dashboard-container-env.test.mjs 守住四对脚本一致，防止漂移。
exec env MSYS_NO_PATHCONV=1 docker run --rm \
  --network "$NETWORK" \
  -v "$(pwd)/blockchain:/workspace/blockchain:ro" \
  -v "$(pwd)/tools:/workspace/tools:ro" \
  -v "$(pwd)/.devnet:/workspace/.devnet" \
  -e KARMACHAIN_RPC_URL="$(devnet_container_rpc_url "$DOMAIN")" \
  karmachain/verify:local node tools/inspect/list-contracts.mjs "$@"
