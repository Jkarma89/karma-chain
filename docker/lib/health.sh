#!/usr/bin/env bash
# lib/health.sh —— 逐节点健康/共识状态采集（FR-032）。在 devnet 容器内运行，直连 127.0.0.1 无需代理。

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
# shellcheck source=nodes.sh
source "${KARMACHAIN_LIB}/nodes.sh"

HEALTH_TIMEOUT="${KARMACHAIN_HEALTH_TIMEOUT:-6}"

_h_info() { # _h_info <port> <method> [params-json]（Info API 的 params 是对象，默认空对象）
  local port="$1" method="$2" params="${3:-}"
  [ -n "${params}" ] || params='{}'
  curl -s -m "${HEALTH_TIMEOUT}" -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "http://127.0.0.1:${port}/ext/info"
}

_h_eth() { # _h_eth <method>（EVM RPC 的 params 是数组）
  curl -s -m "${HEALTH_TIMEOUT}" -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":[]}" \
    "$(proto_rpc_url_node 1)"
}

# 单节点状态 JSON：{label, role, nodeId, httpPort, running, healthy, bootstrapped, peers, nodeIdMatches}
health_node_json() { # health_node_json <node-json>
  local n="$1" port label role want_id
  port="$(jq -r '.httpPort' <<<"${n}")"
  label="$(jq -r '.label' <<<"${n}")"
  role="$(jq -r '.role' <<<"${n}")"
  want_id="$(jq -r '.nodeId' <<<"${n}")"

  # peers / got_id 初始为空串（不是字面 "null"）：节点停止时不会执行探测，
  # 若初始化成 "null"，jq 的 tonumber 会崩溃、NodeID 也会被误判为 MISMATCH。
  local running=false healthy=false bootstrapped=false peers="" got_id=""
  # 只认节点自己在回环上的监听：同端口上还有一个绑在容器 IP 的 socat 代理（lib/runtime.sh），
  # 若按"任意地址 + 端口"判断，节点停止后会被误判为 running。
  if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qxF "127.0.0.1:${port}"; then running=true; fi

  if [ "${running}" = true ]; then
    local hbody; hbody="$(curl -s -m "${HEALTH_TIMEOUT}" "http://127.0.0.1:${port}/ext/health" 2>/dev/null || true)"
    [ "$(jq -r '.healthy // false' <<<"${hbody}" 2>/dev/null)" = "true" ] && healthy=true
    got_id="$(_h_info "${port}" info.getNodeID | jq -r '.result.nodeID // empty' 2>/dev/null || true)"
    peers="$(_h_info "${port}" info.peers | jq -r '.result.numPeers // empty' 2>/dev/null || true)"
    local chain; chain="$([ "${role}" = "l1-validator" ] && proto_blockchain_name || echo P)"
    [ "$(_h_info "${port}" info.isBootstrapped "{\"chain\":\"${chain}\"}" | jq -r '.result.isBootstrapped // false' 2>/dev/null)" = "true" ] && bootstrapped=true
  fi

  jq -n --arg label "${label}" --arg role "${role}" --arg wantId "${want_id}" \
        --arg gotId "${got_id:-}" --argjson port "${port}" \
        --argjson running "${running}" --argjson healthy "${healthy}" --argjson bootstrapped "${bootstrapped}" \
        --arg peers "${peers:-}" '
    { label: $label, role: $role, httpPort: $port, nodeId: $wantId,
      running: $running, healthy: $healthy, bootstrapped: $bootstrapped,
      peers: (if $peers == "" then null else ($peers | tonumber) end),
      nodeIdMatches: (if $gotId == "" then null else ($gotId == $wantId) end) }'
}

# 全网状态 JSON：{ generatedAt, chainId, blockHeight, nodes: [...], unhealthy: n }
health_all_json() {
  local inv; inv="$(nodes_inventory_json)"
  local nodes_json="[]" n
  while read -r n; do
    [ -n "${n}" ] || continue
    nodes_json="$(jq -c --argjson add "$(health_node_json "${n}")" '. + [$add]' <<<"${nodes_json}")"
  done < <(jq -c '.nodes[]' <<<"${inv}")

  local height_hex chain_id height_dec
  height_hex="$(_h_eth eth_blockNumber | jq -r '.result // empty' 2>/dev/null || true)"
  chain_id="$(_h_eth eth_chainId | jq -r '.result // empty' 2>/dev/null || true)"
  # jq 不能解析十六进制，交给 shell 算术
  height_dec=""
  [ -n "${height_hex}" ] && height_dec="$((height_hex))"

  jq -n --argjson nodes "${nodes_json}" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg height "${height_dec}" --arg chainId "${chain_id}" '
    { generatedAt: $at,
      chainIdHex: (if $chainId == "" then null else $chainId end),
      blockHeight: (if $height == "" then null else ($height | tonumber) end),
      nodes: $nodes,
      unhealthy: ([$nodes[] | select(.healthy != true)] | length) }'
}
