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
BASE="http://127.0.0.1:${PORT}"

rpc() { # rpc <path> <method> -> stdout(json) / 非零退出表示不可达
  curl -sf -m 4 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "${BASE}$1" 2>/dev/null
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
    if [ "${waited}" -ge "${STALL_AFTER}" ]; then
      state="stalled"; detail="not serving L1 for ${waited}s (>= ${STALL_AFTER}s) — 需要处置"
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
