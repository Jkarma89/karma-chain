#!/usr/bin/env bash
# lib/avalanche.sh —— Avalanche CLI 的唯一调用点（plan.md Complexity Tracking / research R-12 迁移面）。
# 上层（entrypoint、devnet-* 命令、冒烟脚本）只调用这里的 av_* 函数，不直接执行 `avalanche`。
#
# 标志依据：avalanche-cli v1.9.6 命令参考（research R-01/R-04）。每个函数顶部注明对应的 research 结论。
# 非交互性（V-5）在 T011 冒烟中验证；若仍出现提示，只允许在此文件内补标志并记录原因。

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
# shellcheck source=protocol.sh
source "${KARMACHAIN_LIB}/protocol.sh"
# shellcheck source=binaries.sh
source "${KARMACHAIN_LIB}/binaries.sh"

: "${AVALANCHE_CLI_HOME:=/root/.avalanche-cli}"
# 全局附加标志：不检查更新（离线可复现）；日志级别可由环境覆盖
AV_GLOBAL_FLAGS=(--skip-update-check --log-level "${AVALANCHE_LOG_LEVEL:-ERROR}")

av() { avalanche "$@" "${AV_GLOBAL_FLAGS[@]}"; }

# ---------------------------------------------------------------------------
# 本地 Primary Network（P/C/X 链，Network ID 见 protocol.json avalanche.networkId）—— research R-04
# ---------------------------------------------------------------------------
av_network_start() {
  # --avalanchego-version 固定到 protocol.json 声明的版本，二进制已由 binaries.sh 预置进缓存（V-2）
  av network start \
    --num-nodes "$(proto_primary_nodes)" \
    --avalanchego-version "$(proto_avalanchego_ver)" \
    "$@"
}

av_network_stop()   { av network stop "$@"; }          # 保存快照（默认名 default）
av_network_clean()  { av network clean "$@"; }         # 删除本地网络与快照（重置）
av_network_status() { av network status "$@"; }
av_network_is_running() { av network status >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# 定义链 —— research R-01/R-07
#   av_blockchain_create <name> <genesis-path>          用我们生成的创世（正式路线）
#   av_blockchain_create_test_defaults <name>           CLI 自生成创世（T011 冒烟 / fixture 提取）
# ---------------------------------------------------------------------------
_av_create_common_flags() {
  local owner; owner="$(proto_account_address "$(proto_owner_label)")"
  printf '%s\n' \
    --evm \
    --vm-version "$(proto_subnet_evm_ver)" \
    --evm-token "$(proto_token_symbol)" \
    --proof-of-authority \
    --validator-manager-owner "${owner}" \
    --proxy-contract-owner "${owner}" \
    --icm=false \
    --force
}

av_blockchain_create() {
  local name="$1" genesis="$2"
  local -a flags; mapfile -t flags < <(_av_create_common_flags)
  # 注意：--genesis 与 --evm-chain-id / --*-defaults 互斥（create.go L217）；chainId 已在创世文件内
  av blockchain create "${name}" --genesis "${genesis}" "${flags[@]}" "${@:3}"
}

av_blockchain_create_test_defaults() {
  local name="$1"
  local -a flags; mapfile -t flags < <(_av_create_common_flags)
  av blockchain create "${name}" --test-defaults --evm-chain-id "$(proto_chain_id)" "${flags[@]}" "${@:2}"
}

av_blockchain_describe()          { av blockchain describe "$1"; }
av_blockchain_describe_genesis()  { av blockchain describe "$1" --genesis; }
av_blockchain_delete()            { av blockchain delete "$1" "${@:2}"; }

# ---------------------------------------------------------------------------
# 部署为主权 L1，5 个本机验证者 —— research R-04
#   可选环境变量：AV_STAKING_KEYS=1 使用 protocol.json 声明的开发验证者密钥（T012 之后）
# ---------------------------------------------------------------------------
av_blockchain_deploy_local() {
  local name="$1"
  local -a flags=(
    --local
    --ewoq
    --use-local-machine
    --num-bootstrap-validators "$(proto_validator_count)"
    --http-port "$(proto_validator_http_ports)"
    --staking-port "$(proto_validator_staking_ports)"
    --avalanchego-version "$(proto_avalanchego_ver)"
    --skip-icm-deploy
    --skip-relayer
  )
  if [ "${AV_STAKING_KEYS:-0}" = "1" ]; then
    local n i certs="" tls="" signers=""
    n="$(proto_validator_count)"
    for ((i = 1; i <= n; i++)); do
      local dir; dir="/workspace/$(proto_validator_key_dir "$i")"
      certs+="${certs:+,}${dir}staker.crt"
      tls+="${tls:+,}${dir}staker.key"
      signers+="${signers:+,}${dir}signer.key"
    done
    flags+=(--staking-cert-key-path "${certs}" --staking-tls-key-path "${tls}" --staking-signer-key-path "${signers}")
  fi
  av blockchain deploy "${name}" "${flags[@]}" "${@:2}"
}

# ---------------------------------------------------------------------------
# 机器可读信息：sidecar.json（pkg/models/sidecar.go）
# ---------------------------------------------------------------------------
av_sidecar_path() { printf '%s/subnets/%s/sidecar.json' "${AVALANCHE_CLI_HOME}" "$1"; }
av_sidecar_get()  { jq -er "$2" "$(av_sidecar_path "$1")"; }   # av_sidecar_get <name> '<jq expr>'
av_sidecar_rpc_endpoints() { av_sidecar_get "$1" '.Networks["Local Network"].RPCEndpoints[]'; }
av_sidecar_blockchain_id() { av_sidecar_get "$1" '.Networks["Local Network"].BlockchainID'; }
av_sidecar_subnet_id()     { av_sidecar_get "$1" '.Networks["Local Network"].SubnetID'; }
av_sidecar_vm_owner()      { av_sidecar_get "$1" '.ValidatorManagerOwner // empty'; }
