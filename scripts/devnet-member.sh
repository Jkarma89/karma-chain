#!/usr/bin/env sh
# scripts/devnet-member.sh —— 成员管理入口：看 / 加 / 退（功能 005 / US2 / US3、FR-017）。
#
# 用法：
#   scripts/devnet-member.sh status                                  只读报告：声明 vs 合约 vs P 链
#   scripts/devnet-member.sh add    --node-id NodeID-… [--yes]       ACP-77 四步，**每次只做一步**
#   scripts/devnet-member.sh remove --node-id NodeID-… [--emergency] [--yes]
#
# 退出码（与 tools/membership/exit-codes.mjs 同一套，**不复用 11/12/13/20**）：
#   0  成功（含"已经做完，无需操作"）
#   10 前置依赖缺失（docker / 工具镜像 / 网络 / 聚合器）
#   30 前置检查未通过 —— **一步都没动链**
#   31 某一步失败 —— 输出会说停在哪一步，改完直接重跑
#   32 人工中止，链未改动
#   33 只读报告发现漂移（只有 status 会给）
#
# 为什么要有这个脚本：文档此前让人直接敲 `node tools/membership/…`，
# 而 README 承诺**宿主唯一前置依赖是 Docker**。它和 devnet-verify 一样把工具跑在
# 容器里，因此没装 Node 的机器也能做成员变更。
#
# 与 devnet-verify 的不同只有两处，都是必须的：
#   ① `-i` —— 加入与退出在每个危险动作前会问一次，交互要能传进去
#   ② 聚合器 —— 第二步要连签名聚合器，而它默认只发布在**宿主**的 8646 上
set -eu
cd "$(dirname "$0")/.."

SUB="${1:-}"
case "$SUB" in
  status|add|remove) shift ;;
  ''|-h|--help)
    sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'
    exit 0 ;;
  *)
    echo "devnet-member: 未知子命令 '$SUB'（可用：status / add / remove）" >&2
    exit 10 ;;
esac

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-member: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"
# shellcheck source=./_devnet-common.sh
. "$(dirname "$0")/_devnet-common.sh"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
command -v docker >/dev/null 2>&1 || { echo "devnet-member: docker not found" >&2; exit 10; }
devnet_require_verify_image || { echo "devnet-member: 前置条件未满足（见上）" >&2; exit 10; }
NETWORK="$(devnet_node_network "$DOMAIN")" || { echo "devnet-member: 前置条件未满足（见上）" >&2; exit 10; }

case "$SUB" in
  status) TOOL=tools/membership/member-set.mjs ;;
  add)    TOOL=tools/membership/add-validator.mjs ;;
  remove) TOOL=tools/membership/remove-validator.mjs ;;
esac

# 聚合器：只有 add / remove 的**第二步**需要它。
#
# 它按文档是 `docker run -p 8646:8646` 起的，发布在**宿主**上 —— 而本工具跑在容器里，
# 宿主的 127.0.0.1 不是它的 127.0.0.1。所以按容器名连，并先确认两者在同一个网络上。
#
# 不在这里替用户 `docker network connect`：那会在他没预期的时候改动一个正在跑的容器。
# 报出确切的命令，让他自己决定。
AGG_ARGS=""
if [ "$SUB" != "status" ]; then
  if [ -n "${KARMACHAIN_AGGREGATOR_URL:-}" ]; then
    AGG_ARGS="-e KARMACHAIN_AGGREGATOR_URL=$KARMACHAIN_AGGREGATOR_URL"
  else
    AGG_NET="$(docker inspect -f "{{range \$k, \$v := .NetworkSettings.Networks}}{{\$k}}
{{end}}" karmachain-aggregator 2>/dev/null | sed '/^$/d' || true)"
    if [ -z "$AGG_NET" ]; then
      echo "devnet-member: 找不到运行中的 karmachain-aggregator" >&2
      echo "  第二步（收集验证者签名）需要它。起法见 docs/devnet.md §11.2 第③步；" >&2
      echo "  它在别的机器上时，用 KARMACHAIN_AGGREGATOR_URL 指过去。" >&2
      exit 10
    fi
    if ! printf '%s\n' "$AGG_NET" | grep -qx "$NETWORK"; then
      echo "devnet-member: karmachain-aggregator 不在节点网络 '$NETWORK' 上" >&2
      echo "  它现在接在：$(printf '%s' "$AGG_NET" | tr '\n' ' ')" >&2
      echo "  工具容器按**容器名**连它，因此两者要在同一个网络里。接上去：" >&2
      echo "    docker network connect $NETWORK karmachain-aggregator" >&2
      echo "  或者用 KARMACHAIN_AGGREGATOR_URL 指向一个本容器能到的地址。" >&2
      exit 10
    fi
    AGG_ARGS="-e KARMACHAIN_AGGREGATOR_URL=http://karmachain-aggregator:8646"
  fi
fi

# 挂载集合与 devnet-verify 一致（由 tests/unit/dashboard-container-env.test.mjs 守住）。
# blockchain/ 仍是**只读**：成员变更不写仓库 —— 进度一律从链上观测，不落状态文件。
# MSYS_NO_PATHCONV=1 的理由见 devnet-verify.sh。
# shellcheck disable=SC2086  # AGG_ARGS 要按词拆开传给 docker
exec env MSYS_NO_PATHCONV=1 docker run --rm -i \
  --network "$NETWORK" \
  -v "$(pwd)/blockchain:/workspace/blockchain:ro" \
  -v "$(pwd)/tools:/workspace/tools:ro" \
  -v "$(pwd)/.devnet:/workspace/.devnet" \
  -e KARMACHAIN_RPC_URL="$(devnet_container_rpc_url "$DOMAIN")" \
  $AGG_ARGS \
  karmachain/verify:local node "$TOOL" "$@"
