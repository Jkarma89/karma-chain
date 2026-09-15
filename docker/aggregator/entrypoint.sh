#!/usr/bin/env sh
# docker/aggregator/entrypoint.sh —— 从挂进来的声明推导聚合器配置（功能 005 / T027 第四步）
#
# ## 为什么配置在容器里生成，而不是做成生成物
#
# 这台机器上**可能没有 node**（tools/membership/gen-node-keys.sh 的设计前提就是
# 「目标机器不需要装 node/npm」）。而配置要的四样东西全都在仓库里：
#
#   Primary 的地址      blockchain/deployment.json 的 failureDomains
#   Primary 的端口      blockchain/deployment.json 的 topology.nodes
#   Primary 的 NodeID   blockchain/nodes/primary-*.identity.json
#   P 链 API            上面两样拼出来
#
# 所以用 jq 现推，和 docker/node/entrypoint.sh 同一个路子。好处是
# **不新增生成物、不动 render 流水线**，`git pull` 就把配置的输入送到了。
#
# ## 为什么必须显式列出两个 Primary
#
# 实测（2026-09-16）：只给 `info-api` 时，聚合器从那个节点的 peer 列表推导引导节点 ——
# 而**节点不在自己的 peer 列表里**，于是只发现了另一个 Primary，连上 50% 权益，
# 报 `failed to connect to a threshold of stake`（门槛 67%）。
# 两个各握 50%，少一个就永远不够 —— 这与研究 V-32 说的是同一件事。
#
# ## 它必须跑在 Primary 所在的那台机器上，并且用 host 网络
#
# 实测（2026-09-16，win-1）：在 Docker Desktop 的 NAT 后面，这个容器能连通
# Primary 的 staking 端口（TCP 可达），但 avalanchego 的**握手建不起来** ——
# 两个 Primary 的 peer 列表里都看不到它。而同一台机器上的 l1-1 容器 P2P 正常，
# 区别是 l1-1 发布了 staking 端口、有可回拨的地址，而聚合器只向外拨。
# 结论：用 `--network host` 跑在 ubuntu-1 或 ubuntu-2 上（Primary 就在那儿），
# P2P 形态与普通节点一致，省掉整类问题。
#
# 用法（在承载 Primary 的机器上）：
#   docker run --rm --network host \
#     -v "$PWD/blockchain:/repo/blockchain:ro" \
#     karmachain/aggregator:local
#
# 退出码：10 依赖或声明缺失
set -eu

EXIT_DEPS=10
REPO="${KARMACHAIN_REPO:-/repo}"
DEPLOYMENT_JSON="${REPO}/blockchain/deployment.json"
NODES_DIR="${REPO}/blockchain/nodes"
API_PORT="${KARMACHAIN_AGGREGATOR_PORT:-8646}"
METRICS_PORT="${KARMACHAIN_AGGREGATOR_METRICS_PORT:-8647}"
LOG_LEVEL="${KARMACHAIN_AGGREGATOR_LOG_LEVEL:-info}"
CONFIG_OUT="${KARMACHAIN_AGGREGATOR_CONFIG:-/tmp/aggregator.json}"

command -v jq >/dev/null 2>&1 || { echo "aggregator: 镜像里没有 jq" >&2; exit ${EXIT_DEPS}; }

[ -f "${DEPLOYMENT_JSON}" ] || {
  echo "aggregator: 找不到 ${DEPLOYMENT_JSON}" >&2
  echo "  把仓库的 blockchain/ 挂进来：-v \"\$PWD/blockchain:/repo/blockchain:ro\"" >&2
  exit ${EXIT_DEPS}
}

DEPLOYMENT="${KARMACHAIN_DEPLOYMENT:-$(jq -er '.topology.activeDeployment' "${DEPLOYMENT_JSON}")}"

# Primary 的 id / httpPort / stakingPort / 所在边界的地址，一次 jq 取齐。
# 取不到就报出来 —— 拿着半份声明去启动，报的会是别的错。
PRIMARIES="$(jq -er --arg dep "${DEPLOYMENT}" '
  [ .topology.nodes[] | select(.role == "primary") ] as $ps
  | ( .topology.deployments[$dep].failureDomains // empty ) as $ds
  | if ($ps | length) == 0 then error("声明里没有 role=primary 的节点") else . end
  | [ $ps[] as $p
      | ( $ds[] | select(.nodes | index($p.id)) ) as $d
      | { id: $p.id, address: $d.address, httpPort: $p.httpPort, stakingPort: $p.stakingPort } ]
  | if length != ($ps | length)
    then error("有 Primary 在 deployments." + $dep + " 的任何故障边界里都找不到")
    else . end
  | .[] | "\(.id) \(.address) \(.httpPort) \(.stakingPort)"
' "${DEPLOYMENT_JSON}")" || { echo "aggregator: 从 ${DEPLOYMENT_JSON} 推导 Primary 失败（形态 ${DEPLOYMENT}）" >&2; exit ${EXIT_DEPS}; }

PEERS=""
PCHAIN_URL=""
COUNT=0
# 每行一个 Primary、字段以空格分隔；把空格换成冒号后按行取值，
# 于是循环体在**当前 shell** 里跑（管道会开子 shell，累加的变量就丢了）。
for line in $(echo "${PRIMARIES}" | tr ' ' ':'); do
  id="$(echo "${line}" | cut -d: -f1)"
  address="$(echo "${line}" | cut -d: -f2)"
  httpPort="$(echo "${line}" | cut -d: -f3)"
  stakingPort="$(echo "${line}" | cut -d: -f4)"
  identity="${NODES_DIR}/${id}.identity.json"
  [ -f "${identity}" ] || {
    echo "aggregator: 找不到 ${identity} —— 少了它就不知道 ${id} 的 NodeID，" >&2
    echo "  而不显式列出两个 Primary 时只能连上 50% 权益（门槛 67%）。" >&2
    exit ${EXIT_DEPS}
  }
  nodeId="$(jq -er '.nodeId' "${identity}")" || {
    echo "aggregator: ${identity} 里没有 nodeId" >&2; exit ${EXIT_DEPS}; }
  PEERS="${PEERS}${PEERS:+,}{\"id\":\"${nodeId}\",\"ip\":\"${address}:${stakingPort}\"}"
  [ -n "${PCHAIN_URL}" ] || PCHAIN_URL="http://${address}:${httpPort}"
  COUNT=$((COUNT + 1))
done

[ "${COUNT}" -ge 2 ] || {
  echo "aggregator: 只推导出 ${COUNT} 个 Primary。" >&2
  echo "  第四步的确认消息要 67% 的 Primary 权重签名，而等权下一个 Primary 只有 50%" >&2
  echo "  —— 少一个就永远聚合不出来（研究 V-32）。" >&2
  exit ${EXIT_DEPS}
}

jq -n \
  --argjson apiPort "${API_PORT}" \
  --argjson metricsPort "${METRICS_PORT}" \
  --arg logLevel "${LOG_LEVEL}" \
  --arg pchain "${PCHAIN_URL}" \
  --argjson peers "[${PEERS}]" \
  '{
     "log-level": $logLevel,
     "api-port": $apiPort,
     "metrics-port": $metricsPort,
     "p-chain-api": { "base-url": $pchain },
     "info-api": { "base-url": $pchain },
     "manually-tracked-peers": $peers
   }' > "${CONFIG_OUT}"

echo "aggregator: 形态 ${DEPLOYMENT}，${COUNT} 个 Primary，API 端口 ${API_PORT}" >&2
jq -c '{ "p-chain-api": ."p-chain-api"."base-url", peers: [."manually-tracked-peers"[].ip] }' "${CONFIG_OUT}" >&2

exec /usr/local/bin/signature-aggregator --config-file "${CONFIG_OUT}"
