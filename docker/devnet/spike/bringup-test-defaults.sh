#!/usr/bin/env bash
# T011 冒烟闸门：用 CLI 自带的 --test-defaults 创世，把 "2 主网节点 + 5 L1 验证者" 真实拉起到 RPC 可用。
# 目的不是交付，而是一次性回答 research.md 验证清单 V-1/V-2/V-4/V-5/V-6/V-8。
# 用法（宿主）：docker compose run --rm --service-ports devnet /opt/karmachain/spike/bringup-test-defaults.sh [phase]
#   phase: all (默认) | prereq | network | create | deploy | probe | stopstart | report
set -euo pipefail

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
source "${KARMACHAIN_LIB}/avalanche.sh"

NAME="${SPIKE_CHAIN_NAME:-kcspike}"
REPORT="${SPIKE_REPORT:-/root/.avalanche-cli/spike-report.txt}"
T0=$(date +%s)

say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
note() { printf '[spike %4ss] %s\n' "$(( $(date +%s) - T0 ))" "$*" | tee -a "${REPORT}"; }
mem_mb() { awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%d/%d MB used/total", (t-a)/1024, t/1024}' /proc/meminfo; }

phase_prereq() {
  say "prereq"
  proto_require
  ensure_cached_binaries
  assert_binary_versions_match_protocol
  note "avalanche $(avalanche --version 2>/dev/null | head -1)"
  note "avalanchego $("$(avalanchego_bin)" --version 2>/dev/null | head -1)"
  note "ipv6 loopback: $(ip -6 addr show lo 2>/dev/null | grep -c '::1' ) (V-1: 1 = enabled)"
  note "memory at start: $(mem_mb)"
}

phase_network() {
  say "network start ($(proto_primary_nodes) primary nodes, avalanchego $(proto_avalanchego_ver))"
  local t=$(date +%s)
  av_network_start 2>&1 | tee -a "${REPORT}"
  note "network start took $(( $(date +%s) - t ))s"
  note "V-2 downloads: $(ls -la "${AVALANCHE_CLI_HOME}/bin/avalanchego" | tail -n +2 | tr -s ' ' | cut -d' ' -f9- | tr '\n' ' ')"
  av_network_status 2>&1 | tee -a "${REPORT}" || true
}

phase_create() {
  say "blockchain create (test-defaults, chainId $(proto_chain_id), token $(proto_token_symbol))"
  av_blockchain_create_test_defaults "${NAME}" 2>&1 | tee -a "${REPORT}"
  note "V-5 create finished without prompts: yes"
  note "V-2 vm cache: $(ls "${AVALANCHE_CLI_HOME}/bin/subnet-evm" | tr '\n' ' ')"
}

phase_deploy() {
  say "blockchain deploy --local ($(proto_validator_count) L1 validators)"
  local t=$(date +%s)
  av_blockchain_deploy_local "${NAME}" 2>&1 | tee -a "${REPORT}"
  note "deploy took $(( $(date +%s) - t ))s  (V-6 total since start: $(( $(date +%s) - T0 ))s)"
  note "memory after deploy: $(mem_mb)"
  note "avalanchego processes: $(pgrep -c -x avalanchego || echo 0)   subnet-evm processes: $(pgrep -c -f 'subnet-evm' || echo 0)"
  note "V-8 listeners: $(ss -ltnp 2>/dev/null | awk 'NR>1{print $4}' | sort -t: -k2 -n | tr '\n' ' ')"
  note "sidecar RPC endpoints: $(av_sidecar_rpc_endpoints "${NAME}" 2>/dev/null | tr '\n' ' ')"
}

rpc() { # rpc <url> <method> [params-json]
  curl -s -m 10 -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1"
}

phase_probe() {
  say "probe RPC"
  local url; url="$(av_sidecar_rpc_endpoints "${NAME}" | head -1)"
  note "eth_chainId @ ${url}: $(rpc "${url}" eth_chainId | jq -r .result)  (want $(proto_chain_id_hex))"
  note "eth_blockNumber: $(rpc "${url}" eth_blockNumber | jq -r .result)"
  local owner; owner="$(proto_account_address "$(proto_owner_label)")"
  note "eth_getBalance(${owner}): $(rpc "${url}" eth_getBalance "[\"${owner}\",\"latest\"]" | jq -r .result)"
  note "info.getNetworkID: $(rpc "http://127.0.0.1:9650/ext/info" info.getNetworkID | jq -r .result.networkID)  (want $(proto_network_id))"
  local p; for p in $(proto_validator_http_ports | tr ',' ' '); do
    note "node :${p} health=$(curl -s -m 5 "http://127.0.0.1:${p}/ext/health" | jq -r .healthy 2>/dev/null || echo n/a) peers=$(rpc "http://127.0.0.1:${p}/ext/info" info.peers | jq -r '.result.numPeers' 2>/dev/null || echo n/a)"
  done
}

phase_stopstart() {
  say "V-4: network stop → start → check L1 still served"
  local url; url="$(av_sidecar_rpc_endpoints "${NAME}" | head -1)"
  local h0; h0="$(rpc "${url}" eth_blockNumber | jq -r .result)"
  av_network_stop 2>&1 | tee -a "${REPORT}"
  note "after stop: avalanchego processes = $(pgrep -c -x avalanchego || echo 0)"
  av_network_start 2>&1 | tee -a "${REPORT}"
  sleep 5
  note "after restart: avalanchego processes = $(pgrep -c -x avalanchego || echo 0)"
  note "V-4 height before=${h0} after=$(rpc "${url}" eth_blockNumber | jq -r .result 2>/dev/null || echo unreachable)"
}

phase_report() {
  say "report (${REPORT})"
  cat "${REPORT}"
}

case "${1:-all}" in
  all) phase_prereq; phase_network; phase_create; phase_deploy; phase_probe; phase_stopstart; phase_report ;;
  prereq|network|create|deploy|probe|stopstart|report) "phase_$1" ;;
  *) echo "unknown phase: $1" >&2; exit 2 ;;
esac
