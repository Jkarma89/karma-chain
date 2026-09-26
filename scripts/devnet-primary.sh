#!/usr/bin/env sh
# scripts/devnet-primary.sh —— Primary 网络验证者集合的入口（功能 005 / US4 / T045）。
#
# 用法：
#   scripts/devnet-primary.sh add --node l1-5 [--days 365] [--stake-avax 1000000] [--dry-run] [--yes]
#
# 退出码（与 tools/membership/exit-codes.mjs 同一套，**不复用 11/12/13/20**）：
#   0  成功（含"已经是成员，无需操作"）
#   10 前置依赖缺失（docker / 工具镜像 / 节点网络）
#   30 前置检查未通过 —— **一步都没动链**
#   31 某一步失败 —— 可重跑
#   32 人工中止，链未改动
#
# ## 为什么要有这个脚本
#
# README 承诺**宿主唯一的前置依赖是 Docker**，而 `tools/membership/add-primary-validator.mjs`
# 需要 `ajv` 等依赖。2026-09-26 用户在 ubuntu-3 上直接敲那个 .mjs，撞到
# `Cannot find package 'ajv' imported from tools/protocol/load.mjs` ——
# 那台机器按承诺本来就不该需要 `npm install`。
#
# 和 `devnet-member` 一样：把工具跑在容器里，宿主只要有 Docker。
#
# ## 为什么不做成 devnet-member 的第四个子命令
#
# `devnet-member` 的契约写着**三个**子命令（docs/devnet.md §5.4），而且它管的是
# **L1 的成员集合**；这里动的是 **Primary 网络的验证者集合**，是另一条链上的另一件事。
# 混进去会让"退出码 33 = 只读报告发现漂移"这类约定跨越两个语义域。
# 新开一对入口不动既有契约。
#
# ## 与 devnet-member 的唯一实现差异
#
# **不需要签名聚合器。** 加入 Primary 网络走的是 `AddPermissionlessValidatorTx`
# （P 链原生交易），不经 Warp、不收 L1 验证者的签名 —— 那是 ACP-77 注册流程才有的环节。
set -eu
cd "$(dirname "$0")/.."

SUB="${1:-}"
case "$SUB" in
  add) shift ;;
  ''|-h|--help)
    sed -n '3,6p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *)
    echo "devnet-primary: 未知子命令 '$SUB'（可用：add）" >&2
    exit 10 ;;
esac

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-primary: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"
# shellcheck source=./_devnet-common.sh
. "$(dirname "$0")/_devnet-common.sh"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
command -v docker >/dev/null 2>&1 || { echo "devnet-primary: docker not found" >&2; exit 10; }
devnet_require_verify_image || { echo "devnet-primary: 前置条件未满足（见上）" >&2; exit 10; }
NETWORK="$(devnet_node_network "$DOMAIN")" || { echo "devnet-primary: 前置条件未满足（见上）" >&2; exit 10; }
mkdir -p .devnet

# `-i`：提交质押之前会问一次（**24 小时不可逆**），交互要能传进去。
# 挂载集合与 devnet-member 一致（由 tests/unit/dashboard-container-env.test.mjs 守住）。
# blockchain/ 只读：这一步不写仓库 —— 名单改在声明里，是**跑本工具之前**的事。
# MSYS_NO_PATHCONV=1 的理由见 devnet-verify.sh。
exec env MSYS_NO_PATHCONV=1 docker run --rm -i \
  --network "$NETWORK" \
  -v "$(pwd)/blockchain:/workspace/blockchain:ro" \
  -v "$(pwd)/tools:/workspace/tools:ro" \
  -v "$(pwd)/.devnet:/workspace/.devnet" \
  -e KARMACHAIN_RPC_URL="$(devnet_container_rpc_url "$DOMAIN")" \
  karmachain/verify:local node tools/membership/add-primary-validator.mjs "$@"
