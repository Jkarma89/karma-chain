#!/usr/bin/env bash
# KarmaChain 节点健康检查（功能 002 / T028）
#
# 判据是**「本节点能否参与 L1 出块」**，不是节点自报的综合健康位。
#
# 为什么（V-08 实测，2026-09-06）：停掉两个 Primary Network 节点后，链 4 笔交易全部 1.0s 确认、
# 高度单调递增，但 5 个 L1 验证者的 /ext/health 全部转为不健康 —— 因为它们带
# partial-sync-primary-network=true，健康判定包含 P 链可达性。
# 若照搬「不健康即重启」，Primary 一挂就会把 5 个工作正常的验证者同时重启，
# 把一次局部故障放大成全链抖动。
#
# 两种情形不得判为不健康：
#   1. catching-up（正在追赶）—— 否则容器会在节点正常恢复时反复重启它，把恢复变成死循环
#   2. P 链不可达但 L1 正常出块 —— 见上
#
# 用法：healthcheck.sh          容器健康检查（退出码 0/1）
#       healthcheck.sh --state  打印 RecoveryState JSON（供 devnet-status 消费）
set -uo pipefail

: "${KARMACHAIN_CONFIG:=/config}"
: "${KARMACHAIN_DATA:=/data}"

FLAGS="${KARMACHAIN_CONFIG}/flags.json"
IDENTITY="${KARMACHAIN_CONFIG}/identity.json"
PROTOCOL="${KARMACHAIN_CONFIG}/protocol.json"
PROGRESS="${KARMACHAIN_DATA}/.health-progress"
# 「引导/追赶中」多久算「卡住」。取值依据：实测单验证者从空卷重新同步约 6s、
# 崩溃后恢复 12–17s，留一个量级的余量。compose 的 start_period 覆盖首次启动。
: "${STALL_AFTER:=300}"

PORT="$(jq -r '."http-port"' "${FLAGS}" 2>/dev/null || echo '')"
ROLE="$(jq -r '.role' "${IDENTITY}" 2>/dev/null || echo '')"
# 必须用 blockchainID，不能用链别名：avalanchego 只在 /ext/bc/<blockchainID> 注册路由，
# 别名路径要靠对外的 nginx 代理重写才通（研究 R-05）。用别名会让健康检查恒为失败 ——
# 节点明明好着，Docker 却报 unhealthy，进而可能被反复重启。
CHAIN_PATH="$(jq -r '.blockchainId' "${KARMACHAIN_CONFIG}/karmachain.identity.json" 2>/dev/null || echo '')"
SUBNET_ID="$(jq -r '.subnetId' "${KARMACHAIN_CONFIG}/karmachain.identity.json" 2>/dev/null || echo '')"
VALIDATOR_COUNT="$(jq -r '.validators.count' "${PROTOCOL}" 2>/dev/null || echo '')"
BASE="http://127.0.0.1:${PORT}"

rpc() { # rpc <path> <method> -> stdout(json) / 非零退出表示不可达
  curl -sf -m 4 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "${BASE}$1" 2>/dev/null
}

# 本节点当前看见多少个**跟踪本 L1 的对等节点**。空字符串表示问不出来（结论未定）。
#
# 为什么用它：两个 Primary 节点只跟踪 Primary 子网（11111…LpoYY），因此按 subnetId
# 过滤出来的恰好是"其余 L1 验证者"。这个信号在**L1 链尚未在本地建立时也可用** ——
# 而那正是跨机分批启动时的处境（P 链还没引导完，节点还不知道有这条链，
# /ext/health 里连 karmachain 这一项都不存在）。
peers_tracking_l1() {
  [ -n "${SUBNET_ID}" ] || return 0
  curl -sf -m 4 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"info.peers","params":{}}' \
    "${BASE}/ext/info" 2>/dev/null \
  | jq -r --arg sid "${SUBNET_ID}" \
      '[.result.peers[]? | select((.trackedSubnets // []) | index($sid))] | length' 2>/dev/null
}

state="unknown"; height=""; detail=""

if [ -z "${PORT}" ]; then
  state="starting"; detail="config not readable yet"
elif ! curl -sf -m 4 "${BASE}/ext/info" -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"info.getNodeID","params":[]}' >/dev/null 2>&1; then
  state="starting"; detail="HTTP API not answering"
elif [ "${ROLE}" = "l1-validator" ]; then
  # 关键判据：本节点是否在服务 L1。能返回高度即说明它参与得了出块 ——
  # 此时 P 链是否可达无关紧要（V-08）。
  resp="$(rpc "/ext/bc/${CHAIN_PATH}/rpc" eth_blockNumber)"
  hex="$(echo "${resp}" | jq -r '.result // empty' 2>/dev/null)"
  if [ -z "${hex}" ]; then
    # 还没开始服务 L1。区分「正在引导/追赶」与「卡住了」——前者要等，后者要处置。
    #
    # 判据用「是否已在服务」而不是「高度是否增长」：本链是无交易不出块的，
    # 空闲时高度本来就不动，拿高度当活性信号会把正常空闲误判成卡死（001 已记录该行为）。
    now="$(date +%s)"
    since="$(cat "${PROGRESS}" 2>/dev/null || echo '')"
    case "${since}" in
      ''|*[!0-9]*) since="${now}"; echo "${since}" > "${PROGRESS}" 2>/dev/null || true ;;
    esac
    waited=$(( now - since ))

    # 在判"卡住"之前先问一句：本节点**本该**有进展吗？
    #
    # 5 个等权验证者的查询门槛是 α/k=75%，只有 ≥4 个连上时 L1 才推得动
    # （推导在 tools/protocol/load.mjs，f ≤ n/4，研究 R-05）。跨机分批启动时先起来的
    # 机器必然连不满 —— 那不是"卡住"，本机也无从处置，报"需要处置"只会把人引错方向。
    #
    # 2026-09-08 跨机首次部署实测：ubuntu-1 单独起来时报
    #   {"state":"stalled","detail":"not serving L1 for 598s (>= 300s) — 需要处置"}
    # 而真正的成因是 ubuntu-2 还没启动，Primary Network 连接权益只有 50%，P 链推不动。
    # 那台机器上没有任何可处置的东西。
    #
    # 判据取**严格保守**的一侧：只有"其余验证者全部在场"时才允许升级为 stalled ——
    # 那时确实没有外部因素拦着，问题就在本机。刻意不引入 0.75 这个数：
    # 它是 load.mjs 的派生规则，在容器里复制一份就成了第二个事实来源（宪法第十六条）。
    # 代价是"本机真坏 + 恰好有别的验证者离线"时不报 stalled，但那时 devnet-status
    # 会同时显示那些节点缺席，指向依然清楚。
    #
    # 这条守卫打在正常路径上，因此沿用既有教训：**拿不准就放行**（问不出对等节点数时
    # 视作有外部因素，停在 bootstrapping）。
    peers="$(peers_tracking_l1)"
    case "${peers}" in ''|*[!0-9]*) peers="" ;; esac
    expected_peers=""
    case "${VALIDATOR_COUNT}" in
      ''|*[!0-9]*) : ;;
      *) expected_peers=$(( VALIDATOR_COUNT - 1 )) ;;
    esac

    if [ -n "${peers}" ] && [ -n "${expected_peers}" ] && [ "${peers}" -lt "${expected_peers}" ]; then
      state="bootstrapping"
      detail="等其余边界：只看见 ${peers}/${expected_peers} 个对等验证者，L1 未达查询门槛（已 ${waited}s）"
    elif [ "${waited}" -ge "${STALL_AFTER}" ] && [ -n "${peers}" ]; then
      state="stalled"
      detail="not serving L1 for ${waited}s (>= ${STALL_AFTER}s)，且 ${peers}/${expected_peers:-?} 个对等验证者已在场 — 需要处置"
    else
      state="bootstrapping"; detail="引导/追赶中，已 ${waited}s"
    fi
  else
    height=$(( hex ))
    rm -f "${PROGRESS}" 2>/dev/null || true   # 已在服务，清掉等待起点
    # 已在服务即为健康 —— 此时 P 链是否可达无关紧要（V-08），
    # 落后于其他节点也无关紧要：追赶中重启只会打断恢复。
    state="healthy"; detail="serving L1 at height ${height}"
  fi
else
  # Primary 节点：能应答 info API 即视为在岗。它不参与 L1 出块，也不计入容错（研究 R-09）。
  state="healthy"; detail="primary node responding"
fi

if [ "${1:-}" = "--state" ]; then
  jq -n --arg state "${state}" --arg role "${ROLE}" --arg detail "${detail}" \
        --arg height "${height}" \
        '{state:$state, role:$role, detail:$detail, height:(if $height=="" then null else ($height|tonumber) end)}'
  exit 0
fi

case "${state}" in
  healthy) exit 0 ;;
  # bootstrapping / catching-up 期间返回不健康，由 compose 的 start_period 兜住；
  # start_period 内的失败不会触发重启，超出后才算真的卡住。
  *) exit 1 ;;
esac
