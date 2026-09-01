#!/usr/bin/env bash
# lib/runtime.sh —— 运行期辅助：链状态探测、RPC 就绪等待、socat 代理、READY 摘要（FR-008）。

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
source "${KARMACHAIN_LIB}/avalanche.sh"

: "${KARMACHAIN_PROXY_PORT:=8545}"          # 容器内对外监听端口（compose 映射到宿主 KARMACHAIN_RPC_PORT）
: "${KARMACHAIN_STARTUP_TIMEOUT:=300}"      # 秒（SC-001）
PROXY_PID_FILE="/run/karmachain-proxy.pid"

log() { printf '[karmachain] %s\n' "$*"; }

rt_rpc() { # rt_rpc <url> <method> [params-json]
  curl -s -m 10 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1"
}

# --- 链状态（data-model §7 状态机）---
# absent   : 卷内没有本链的 sidecar（从未部署）
# deployed : sidecar 有 BlockchainID（已部署，可能已停止）
# partial  : 有 sidecar 但无 BlockchainID（create 成功 deploy 未完成）
rt_chain_state() {
  local name; name="$(proto_blockchain_name)"
  local sc; sc="$(av_sidecar_path "${name}")"
  [ -f "${sc}" ] || { echo absent; return; }
  local bid; bid="$(jq -r '.Networks["Local Network"].BlockchainID // empty' "${sc}" 2>/dev/null)"
  [ -n "${bid}" ] && echo deployed || echo partial
}

rt_node_rpc_url() { proto_rpc_url_node 1; }   # L1 节点 1 上的别名 RPC

# 等待 L1 RPC 通过别名可用且 chainId 正确
rt_wait_for_rpc() {
  local url deadline want got
  url="$(rt_node_rpc_url)"; want="$(proto_chain_id_hex)"
  deadline=$(( $(date +%s) + KARMACHAIN_STARTUP_TIMEOUT ))
  while [ "$(date +%s)" -lt "${deadline}" ]; do
    got="$(rt_rpc "${url}" eth_chainId 2>/dev/null | jq -r '.result // empty' 2>/dev/null || true)"
    if [ "${got}" = "${want}" ]; then return 0; fi
    sleep 2
  done
  log "FAILED [category: rpc] L1 RPC at ${url} did not report chainId ${want} within ${KARMACHAIN_STARTUP_TIMEOUT}s (last: '${got:-none}')"
  return 1
}

# --- socat 代理：0.0.0.0:<proxy-port> → 127.0.0.1:<L1 node 1 http-port>（research V-8：节点只监听回环）---
rt_start_proxy() {
  rt_stop_proxy
  local target; target="$(proto_first_validator_http_port)"
  socat -d -lf /root/.avalanche-cli/karmachain-proxy.log \
    TCP-LISTEN:"${KARMACHAIN_PROXY_PORT}",fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:"${target}" &
  echo $! > "${PROXY_PID_FILE}"
  sleep 0.5
  kill -0 "$(cat "${PROXY_PID_FILE}")" 2>/dev/null || { log "FAILED [category: configuration] socat proxy on :${KARMACHAIN_PROXY_PORT} did not start"; return 1; }
  # 经代理探测一次（容器内走 127.0.0.1:<proxy-port>）
  local want got; want="$(proto_chain_id_hex)"
  got="$(rt_rpc "http://127.0.0.1:${KARMACHAIN_PROXY_PORT}$(proto_rpc_path)" eth_chainId | jq -r '.result // empty')"
  [ "${got}" = "${want}" ] || { log "FAILED [category: rpc] proxy check returned '${got}' (want ${want})"; return 1; }
}

rt_stop_proxy() {
  if [ -f "${PROXY_PID_FILE}" ]; then
    kill "$(cat "${PROXY_PID_FILE}")" 2>/dev/null || true
    rm -f "${PROXY_PID_FILE}"
  fi
  pkill -x socat 2>/dev/null || true
}

# --- 余额格式化：hex wei → 整数代币（bc 处理大整数）---
rt_wei_hex_to_tokens() {
  local hex="${1#0x}"; local dec="$(proto_token_decimals)"
  echo "ibase=16; $(echo "${hex}" | tr 'a-f' 'A-F')" | bc | { read -r wei; echo "${wei} / 10^${dec}" | BC_LINE_LENGTH=0 bc; }
}

# --- READY 摘要（contracts/cli-interface.md 格式；数值全部经 protocol.sh，FR-008/FR-023）---
rt_print_ready_summary() {
  local host_port="${KARMACHAIN_HOST_RPC_PORT:-$(proto_host_rpc_port)}"
  local rpc_host="http://127.0.0.1:${host_port}$(proto_rpc_path)"
  local node_url; node_url="$(rt_node_rpc_url)"
  local height; height="$(rt_rpc "${node_url}" eth_blockNumber | jq -r '.result')"
  cat <<EOF

KarmaChain local devnet is READY  (environment: $(proto_environment) — DEVELOPMENT ONLY)

  RPC URL      : ${rpc_host}
  WS URL       : ws://127.0.0.1:${host_port}$(proto_rpc_path | sed 's#/rpc$#/ws#')
  Chain ID     : $(proto_chain_id)   (Network ID $(proto_network_id); mainnet $(proto_mainnet_chain_id) is RESERVED, not this network)
  Native token : $(proto_token_name) ($(proto_token_symbol), $(proto_token_decimals) decimals)
  Validators   : $(proto_validator_count) L1 validators ($(proto_validator_mgmt)) + $(proto_primary_nodes) primary-network nodes
  Block mode   : $(proto_block_mode) (blocks are produced only when there are transactions)
  Block height : $((height))

  Dev accounts (publicly known keys — NEVER use outside this local network; keys in blockchain/accounts/dev-accounts.json):
EOF
  local label addr bal
  for label in $(proto_account_labels); do
    addr="$(proto_account_address "${label}")"
    bal="$(rt_rpc "${node_url}" eth_getBalance "[\"${addr}\",\"latest\"]" | jq -r '.result')"
    printf '    %-10s %s   %s %s\n' "${label}" "${addr}" "$(rt_wei_hex_to_tokens "${bal}")" "$(proto_token_symbol)"
  done
  cat <<EOF

  Next: scripts/devnet-verify  |  scripts/devnet-status  |  scripts/devnet-logs  |  scripts/devnet-stop

EOF
}
