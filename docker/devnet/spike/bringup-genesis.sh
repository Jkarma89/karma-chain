#!/usr/bin/env bash
# T014/T012 验证：用仓库提交的创世 + 仓库内的开发验证者密钥部署 KarmaChain L1，
# 检查 (a) 创世被 CLI 接受、链 ID / 余额正确；(b) 创世区块哈希（可复现基准）；(c) NodeID 与 blockchain/validators/dev/*/README.md 一致（V-3）；
# (d) 全程无 GitHub 下载（配合宿主 --add-host 屏蔽 github 域名运行）。
# 用法：docker exec -i <container> bash -s [phase] < docker/devnet/spike/bringup-genesis.sh
set -euo pipefail

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
source "${KARMACHAIN_LIB}/avalanche.sh"

NAME="$(proto_blockchain_name)"
GENESIS="/workspace/blockchain/genesis/karmachain.genesis.json"
T0=$(date +%s)
say()  { printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }
note() { printf '[genesis-spike %4ss] %s\n' "$(( $(date +%s) - T0 ))" "$*"; }
rpc()  { curl -s -m 10 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}" "$1"; }

phase_prereq() {
  say prereq
  ensure_cached_binaries
  assert_binary_versions_match_protocol
  [ -r "${GENESIS}" ] || { echo "genesis not found: ${GENESIS}" >&2; exit 1; }
  note "genesis sha256: $(sha256sum "${GENESIS}" | cut -d' ' -f1)"
  note "github reachable? $(curl -s -m 3 -o /dev/null -w '%{http_code}' https://api.github.com || echo blocked)"
  note "cache: $(ls "${AVALANCHE_CLI_HOME}/download-cache" | tr '\n' ' ')  bins: $(ls "${AVALANCHE_CLI_HOME}/bin" | tr '\n' ' ')"
}

phase_up() {
  say "network start + create(--genesis) + deploy(staking keys)"
  av_network_start
  note "network up"
  av_blockchain_create "${NAME}" "${GENESIS}"
  note "create ok (imported genesis)"
  AV_STAKING_KEYS=1 av_blockchain_deploy_local "${NAME}"
  note "deploy ok — total $(( $(date +%s) - T0 ))s"
}

phase_probe() {
  say probe
  local url; url="http://127.0.0.1:$(proto_first_validator_http_port)$(proto_rpc_path)"
  note "rpc (alias): ${url}"
  note "eth_chainId: $(rpc "${url}" eth_chainId | jq -r .result) (want $(proto_chain_id_hex))"
  note "eth_blockNumber: $(rpc "${url}" eth_blockNumber | jq -r .result)"
  note "GENESIS HASH: $(rpc "${url}" eth_getBlockByNumber '["0x0",false]' | jq -r .result.hash)"
  note "genesis timestamp: $(rpc "${url}" eth_getBlockByNumber '["0x0",false]' | jq -r .result.timestamp)  gasLimit: $(rpc "${url}" eth_getBlockByNumber '["0x0",false]' | jq -r .result.gasLimit)"
  local label; for label in $(proto_account_labels); do
    local addr; addr="$(proto_account_address "${label}")"
    note "balance ${label} ${addr}: $(rpc "${url}" eth_getBalance "[\"${addr}\",\"latest\"]" | jq -r .result) (want $(proto_account_balance_wei "${label}" | tr 'A-F' 'a-f'))"
  done
  say "V-3 NodeIDs (want = README, got = live node)"
  local i n; n="$(proto_validator_count)"
  for ((i = 1; i <= n; i++)); do
    local port want got
    port="$(proto_validator_http_port "$i")"
    want="$(grep -oE 'NodeID-[A-Za-z0-9]+' "/workspace/$(proto_validator_key_dir "$i")README.md" | head -1)"
    got="$(rpc "http://127.0.0.1:${port}/ext/info" info.getNodeID | jq -r .result.nodeID)"
    note "node-${i} :${port} want=${want} got=${got} $([ "${want}" = "${got}" ] && echo MATCH || echo MISMATCH)"
  done
  note "downloads during run: $(ls -la "${AVALANCHE_CLI_HOME}/bin/"*/ | grep -vE '^\s*$|^total|^\.|->|/$' | wc -l) real (non-symlink) entries"
  find "${AVALANCHE_CLI_HOME}/bin" -maxdepth 2 -mindepth 2 ! -type l | sed 's/^/  real: /'
}

case "${1:-all}" in
  all) phase_prereq; phase_up; phase_probe ;;
  prereq|up|probe) "phase_$1" ;;
  *) echo "unknown phase $1" >&2; exit 2 ;;
esac
