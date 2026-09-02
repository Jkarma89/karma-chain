#!/usr/bin/env bash
# lib/runtime.sh —— 运行期辅助：链状态探测、RPC 就绪等待、socat 代理、READY 摘要（FR-008）。

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
source "${KARMACHAIN_LIB}/avalanche.sh"
# shellcheck source=nodes.sh
source "${KARMACHAIN_LIB}/nodes.sh"

: "${KARMACHAIN_PROXY_PORT:=$(proto_host_rpc_port)}"   # 容器内对外监听端口；默认取 protocol.json（compose 会显式传入，与映射右侧一致）
: "${KARMACHAIN_STARTUP_TIMEOUT:=300}"      # 秒（SC-001）
PROXY_PID_FILE="/run/karmachain-proxy.pid"
GENESIS_FILE="${GENESIS_FILE:-/workspace/blockchain/genesis/karmachain.genesis.json}"
STAMP_FILE="${AVALANCHE_CLI_HOME}/karmachain.stamp.json"   # data-model §7：卷内链数据的"出生证明"
EXIT_STAMP_MISMATCH=12

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

# --- stamp（FR-021 / T023）：记录链数据是由哪份 protocol.json + 创世产生的 ---
rt_genesis_sha256()      { sha256sum "${GENESIS_FILE}" | cut -d' ' -f1; }
rt_runtime_genesis_hash(){ rt_rpc "$(rt_node_rpc_url)" eth_getBlockByNumber '["0x0",false]' | jq -r '.result.hash // empty'; }

rt_write_stamp() {
  jq -n \
    --arg configVersion "$(proto_config_version)" \
    --argjson chainId "$(proto_chain_id)" \
    --argjson networkId "$(proto_network_id)" \
    --arg blockchainName "$(proto_blockchain_name)" \
    --arg genesisSha256 "$(rt_genesis_sha256)" \
    --arg genesisBlockHash "$(rt_runtime_genesis_hash)" \
    --arg avalanchegoVersion "$(proto_avalanchego_ver)" \
    --arg subnetEvmVersion "$(proto_subnet_evm_ver)" \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '$ARGS.named' > "${STAMP_FILE}"
  log "stamp written: configVersion $(jq -r .configVersion "${STAMP_FILE}"), chainId $(jq -r .chainId "${STAMP_FILE}"), genesis block $(jq -r .genesisBlockHash "${STAMP_FILE}")"
}

# 卷内链数据必须与当前 protocol.json / 创世一致；否则拒绝启动并提示 reset（退出 12）
rt_check_stamp() {
  if [ ! -f "${STAMP_FILE}" ]; then
    log "FAILED [category: configuration] chain data exists but ${STAMP_FILE} is missing (created by an older version?) — run scripts/devnet-reset and start again"
    return ${EXIT_STAMP_MISMATCH}
  fi
  local mismatches=()
  local want got
  want="$(proto_config_version)";  got="$(jq -r .configVersion "${STAMP_FILE}")";  [ "${want}" = "${got}" ] || mismatches+=("configVersion: chain data ${got}, protocol.json ${want}")
  want="$(proto_chain_id)";        got="$(jq -r .chainId "${STAMP_FILE}")";        [ "${want}" = "${got}" ] || mismatches+=("chainId: chain data ${got}, protocol.json ${want}")
  want="$(proto_network_id)";      got="$(jq -r .networkId "${STAMP_FILE}")";      [ "${want}" = "${got}" ] || mismatches+=("networkId: chain data ${got}, protocol.json ${want}")
  want="$(proto_blockchain_name)"; got="$(jq -r .blockchainName "${STAMP_FILE}")"; [ "${want}" = "${got}" ] || mismatches+=("blockchainName: chain data ${got}, protocol.json ${want}")
  want="$(rt_genesis_sha256)";     got="$(jq -r .genesisSha256 "${STAMP_FILE}")";  [ "${want}" = "${got}" ] || mismatches+=("genesis file sha256 changed since the chain was created (${got:0:12}… → ${want:0:12}…)")
  if [ ${#mismatches[@]} -gt 0 ]; then
    log "FAILED [category: configuration] existing chain data does not match the current protocol configuration:"
    local m; for m in "${mismatches[@]}"; do log "  - ${m}"; done
    log "  → this is a protocol change (constitution Art. 15). Run scripts/devnet-reset to wipe the chain, then start again."
    return ${EXIT_STAMP_MISMATCH}
  fi
  log "stamp OK (configVersion $(proto_config_version), chainId $(proto_chain_id))"
}

# 恢复后：运行中的创世区块哈希必须等于首次部署时记录的值（卷损坏 / 错卷检测）
rt_check_runtime_genesis_hash() {
  local want got; want="$(jq -r .genesisBlockHash "${STAMP_FILE}")"; got="$(rt_runtime_genesis_hash)"
  if [ -n "${want}" ] && [ "${want}" != "${got}" ]; then
    log "FAILED [category: genesis] running chain genesis hash ${got} != recorded ${want} — chain data is corrupt or from another network; run scripts/devnet-reset"
    return ${EXIT_STAMP_MISMATCH}
  fi
}

# --- socat 代理（research V-8：avalanchego 固定只监听 127.0.0.1，不可配置）---
#   ① 0.0.0.0:<proxy-port> → L1 节点 1 —— 对宿主与 compose 网络暴露的主 RPC 端点
#   ② <容器 IP>:<node-port> → 127.0.0.1:<node-port>（每个节点一个，端口号不变）
#      绑定容器 IP 而非 0.0.0.0，才能与节点自己的 127.0.0.1:<同端口> 并存；
#      不映射到宿主，仅 compose 网络内可达，供 verify 容器逐节点做健康/共识检查。
PROXY_LOG=/root/.avalanche-cli/karmachain-proxy.log

_rt_spawn_proxy() { # _rt_spawn_proxy <bind-ip> <listen-port> <target-port>
  socat -d -lf "${PROXY_LOG}" TCP-LISTEN:"$2",fork,reuseaddr,bind="$1" TCP:127.0.0.1:"$3" &
  echo $! >> "${PROXY_PID_FILE}"
}

rt_start_proxy() {
  rt_stop_proxy
  : > "${PROXY_PID_FILE}"

  # ① 主 RPC 端点
  _rt_spawn_proxy 0.0.0.0 "${KARMACHAIN_PROXY_PORT}" "$(proto_first_validator_http_port)"

  sleep 1
  local main_pid; main_pid="$(head -1 "${PROXY_PID_FILE}")"
  kill -0 "${main_pid}" 2>/dev/null || { log "FAILED [category: configuration] the main RPC proxy on :${KARMACHAIN_PROXY_PORT} did not start (see ${PROXY_LOG})"; return 1; }

  # 经主端点探测一次 —— 这是 FR-008 承诺的端点，必须可用
  local want got; want="$(proto_chain_id_hex)"
  got="$(rt_rpc "http://127.0.0.1:${KARMACHAIN_PROXY_PORT}$(proto_rpc_path)" eth_chainId | jq -r '.result // empty')"
  [ "${got}" = "${want}" ] || { log "FAILED [category: rpc] proxy check returned '${got}' (want ${want})"; return 1; }

  # ② 每节点直通（供 verify 容器做 /ext/health、/ext/info 检查）。
  # 尽力而为：失败只影响 devnet-verify 的 node/validator 两项（会降级为 SKIP），不该让整个网络启动失败。
  local ip port started=0 failed=0
  ip="$(nodes_container_ip)"
  if [ -z "${ip}" ]; then
    log "WARNING could not determine the container IP — per-node proxies skipped; 'devnet-verify' will SKIP node/validator checks"
  else
    for port in $(nodes_http_ports); do
      _rt_spawn_proxy "${ip}" "${port}" "${port}"
      local pid; pid="$(tail -1 "${PROXY_PID_FILE}")"
      sleep 0.2
      if kill -0 "${pid}" 2>/dev/null; then started=$((started + 1)); else failed=$((failed + 1)); fi
    done
    [ "${failed}" -eq 0 ] || log "WARNING ${failed} per-node proxy/proxies failed to bind on ${ip} (see ${PROXY_LOG}) — node-level checks will be incomplete"
  fi
  log "proxies up: :${KARMACHAIN_PROXY_PORT} (main) + ${started} per-node${ip:+ on ${ip}}"
}

rt_stop_proxy() {
  if [ -f "${PROXY_PID_FILE}" ]; then
    local pid; while read -r pid; do kill "${pid}" 2>/dev/null || true; done < "${PROXY_PID_FILE}"
    rm -f "${PROXY_PID_FILE}"
  fi
  pkill -x socat 2>/dev/null || true
}

# 节点清单写给验证器（.devnet/ 由 compose 双向挂载；FR-032 / T033 的数据源）
rt_write_node_inventory() {
  local out="${KARMACHAIN_SHARED_DIR:-/workspace/.devnet}/nodes.json"
  mkdir -p "$(dirname "${out}")" 2>/dev/null || true
  if nodes_inventory_json > "${out}.tmp" 2>/dev/null && [ -s "${out}.tmp" ]; then
    mv "${out}.tmp" "${out}"
    log "node inventory written: ${out} ($(jq -r '.nodes | length' "${out}") nodes)"
  else
    rm -f "${out}.tmp"
    log "WARNING could not write node inventory to ${out} (is ./.devnet mounted?) — per-node checks will degrade"
  fi
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
  Genesis hash : $(rt_runtime_genesis_hash)

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
