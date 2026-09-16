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
# ## 跑在哪台机器都行 —— 我一度以为不行，那是误判
#
# 实测（2026-09-16，win-1）：容器能连通 Primary 的 staking 端口（TCP 可达），
# 但 avalanchego 的握手一个都建不起来，两个 Primary 的 peer 列表里都看不到它，
# 日志是 `connectedWeight: 0`，而且**不报任何拨号错误**。
#
# 我当时归因于 Docker Desktop 的 NAT，让人把它搬到 Primary 所在的 Linux 机器上
# 用 `--network host` 跑 —— **结果一模一样**。真正的原因是配置少了
# `allow-private-ips`（下面从节点 flags 推导的那一项）。补上之后，
# 在 win-1 的 NAT 后面照样两个 Primary 秒连、health 变 up。
#
# 留下这段是因为那次误判的形状值得记：TCP 通、无错误日志、换机器无改善 ——
# 三个现象都指向网络，而真凶是一个布尔配置项。
#
# 用法（任意一台能连到 Primary staking 端口的机器）：
#   docker run --rm -p 8646:8646 \
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
PRIVATE_IPS=""
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

  # 允不允许拨私网地址，**取自这个 Primary 自己的启动参数**，不另做判断。
  #
  # 实测（2026-09-16）：少了这一项，聚合器能连通 Primary 的 staking 端口（TCP 可达），
  # 但 avalanchego 的握手一个都建不起来 —— 日志里 `connectedWeight: 0`，
  # 而**不报任何拨号错误**。当时我据此以为是 Docker Desktop 的 NAT，
  # 让人把容器搬到 Primary 所在的机器上用 host 网络跑，结果一模一样。
  # 真正的原因是这一个字段。
  #
  # 为什么读节点的 flags 而不是自己判 RFC1918：节点与聚合器必须对"私网地址能不能用"
  # 有**同一个**答案。自己判就是第二份判断，两份迟早分叉。
  flags="${NODES_DIR}/${DEPLOYMENT}/${id}.flags.json"
  [ -f "${flags}" ] || {
    echo "aggregator: 找不到 ${flags} —— 那里有 network-allow-private-ips，" >&2
    echo "  少了它就不知道这张网允不允许私网地址，而猜错的表现是**静默连不上**。" >&2
    exit ${EXIT_DEPS}
  }
  thisPrivate="$(jq -r '.["network-allow-private-ips"] // "false"' "${flags}")"
  if [ -n "${PRIVATE_IPS}" ] && [ "${PRIVATE_IPS}" != "${thisPrivate}" ]; then
    echo "aggregator: 两个 Primary 的 network-allow-private-ips 不一致" >&2
    echo "  （${PRIVATE_IPS} vs ${thisPrivate}）—— 聚合器只能取一个值，该取哪个要人来定。" >&2
    exit ${EXIT_DEPS}
  fi
  PRIVATE_IPS="${thisPrivate}"
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
  --argjson allowPrivate "${PRIVATE_IPS}" \
  '{
     "log-level": $logLevel,
     "api-port": $apiPort,
     "metrics-port": $metricsPort,
     "allow-private-ips": $allowPrivate,
     "p-chain-api": { "base-url": $pchain },
     "info-api": { "base-url": $pchain },
     "manually-tracked-peers": $peers
   }' > "${CONFIG_OUT}"

echo "aggregator: 形态 ${DEPLOYMENT}，${COUNT} 个 Primary，API 端口 ${API_PORT}" >&2
jq -c '{
  "p-chain-api": ."p-chain-api"."base-url",
  "allow-private-ips": ."allow-private-ips",
  peers: [."manually-tracked-peers"[].ip],
}' "${CONFIG_OUT}" >&2

exec /usr/local/bin/signature-aggregator --config-file "${CONFIG_OUT}"
