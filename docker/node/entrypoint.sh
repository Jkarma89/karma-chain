#!/usr/bin/env bash
# KarmaChain 节点入口（功能 002 / T025–T027）
#
# 只做两件事：校验 → exec avalanchego。
# **不含重试、快照、状态判断等编排行为** —— 进程存活归容器运行时，崩溃恢复归 avalanchego
# 自身的数据库，缺块补齐归共识协议（contracts/node-runtime.md）。
#
# 这正是缺陷 A 的修复方式：不是把编排做得更可靠，而是让它不再是恢复路径的必经环节。
set -euo pipefail

: "${AVALANCHEGO_BIN:=/avalanchego/build/avalanchego}"
: "${SUBNET_EVM_BIN:=/opt/subnet-evm/subnet-evm}"
: "${KARMACHAIN_CONFIG:=/config}"
: "${KARMACHAIN_KEYS:=/keys}"
: "${KARMACHAIN_DATA:=/data}"
: "${KARMACHAIN_PLUGINS:=/plugins}"

# 退出码沿用 001 的语义（specs/001-…/contracts/cli-interface.md）
EXIT_DEPS=10          # 前置依赖缺失
EXIT_MISMATCH=12      # 链数据 / 制品与声明不一致

FLAGS="${KARMACHAIN_CONFIG}/flags.json"
IDENTITY="${KARMACHAIN_CONFIG}/identity.json"
CHAIN_IDENTITY="${KARMACHAIN_CONFIG}/karmachain.identity.json"
PROTOCOL="${KARMACHAIN_CONFIG}/protocol.json"
GENESIS="${KARMACHAIN_CONFIG}/karmachain.genesis.json"
GENESIS_HASH_FILE="${KARMACHAIN_CONFIG}/karmachain.genesis.hash"
STAMP="${KARMACHAIN_DATA}/karmachain.stamp.json"

log()  { echo "[karmachain-node] $*"; }
fail() { log "FAILED [category: $1] $2"; exit "$3"; }

# --- T026：启动期校验 -------------------------------------------------------
# 全部在 exec 之前完成，且都是秒级判断。目的是把「制品与密钥来自不同两次建链」这类错误
# 拦在这里，而不是让它表现为几分钟后难以诊断的「连不上」（FR-017）。

check_files() {
  for f in "${FLAGS}" "${IDENTITY}" "${CHAIN_IDENTITY}" "${PROTOCOL}" "${GENESIS}"; do
    [ -r "$f" ] || fail configuration "required config file missing or unreadable: $f" ${EXIT_DEPS}
  done
  for f in staker.crt staker.key signer.key; do
    [ -r "${KARMACHAIN_KEYS}/$f" ] \
      || fail configuration "identity material missing or unreadable: ${KARMACHAIN_KEYS}/$f" ${EXIT_DEPS}
  done
}

# 密钥完整性：与渲染期派生身份时用的那份逐字节相同才算同源。
# 重活（NodeID / BLS 公钥派生）在渲染期由 Node 完成并被 identity-crosscheck.test 证明正确；
# 运行期只需一次 sha256 比对 —— 文件只要不同，摘要必然不同。
check_key_material() {
  local mismatches=()
  local pairs=("staker.crt:certSha256" "staker.key:keySha256" "signer.key:signerSha256")
  for pair in "${pairs[@]}"; do
    local file="${pair%%:*}" field="${pair##*:}"
    local want got
    want="$(jq -r ".${field}" "${IDENTITY}")"
    got="$(sha256sum "${KARMACHAIN_KEYS}/${file}" | cut -d' ' -f1)"
    [ "${want}" = "${got}" ] || mismatches+=("${file}: expected ${want:0:12}…, got ${got:0:12}…")
  done
  if [ ${#mismatches[@]} -gt 0 ]; then
    log "the mounted identity material does not match the one used to derive this node's identity:"
    for m in "${mismatches[@]}"; do log "  - ${m}"; done
    fail validator "identity material mismatch — the artifact and the keys come from different bootstraps" ${EXIT_MISMATCH}
  fi
  log "identity OK ($(jq -r .nodeId "${IDENTITY}"))"
}

# 制品与协议参数必须同源
check_artifact_compat() {
  local mismatches=()
  local a b
  a="$(jq -r .vmVersion "${CHAIN_IDENTITY}")"; b="$(jq -r .avalanche.subnetEvmVersion "${PROTOCOL}")"
  [ "$a" = "$b" ] || mismatches+=("vmVersion: artifact ${a}, protocol.json ${b}")
  a="$(jq -r .rpcVersion "${CHAIN_IDENTITY}")"; b="$(jq -r .avalanche.rpcChainVmProtocol "${PROTOCOL}")"
  [ "$a" = "$b" ] || mismatches+=("rpcVersion: artifact ${a}, protocol.json ${b}")
  a="$(jq -r .networkId "${CHAIN_IDENTITY}")"; b="$(jq -r .avalanche.networkId "${PROTOCOL}")"
  [ "$a" = "$b" ] || mismatches+=("networkId: artifact ${a}, protocol.json ${b}")
  if [ ${#mismatches[@]} -gt 0 ]; then
    for m in "${mismatches[@]}"; do log "  - ${m}"; done
    fail configuration "chain-identity artifact does not match protocol.json" ${EXIT_MISMATCH}
  fi
}

# --- T027：出生证明（stamp）------------------------------------------------
# 由 001 的 docker/lib/runtime.sh 迁移而来，从「整个卷一个 stamp」下沉到「每个节点自己的卷一个」。
# 好处：某个节点的卷是旧的，只拒绝那一个节点，而不是整套。001 FR-021 的语义不变（FR-026）。

stamp_fields() {
  jq -n \
    --arg configVersion   "$(jq -r .configVersion "${PROTOCOL}")" \
    --argjson chainId     "$(jq -r .chain.chainId "${PROTOCOL}")" \
    --argjson networkId   "$(jq -r .avalanche.networkId "${PROTOCOL}")" \
    --arg blockchainName  "$(jq -r .chain.blockchainName "${PROTOCOL}")" \
    --arg genesisSha256   "$(sha256sum "${GENESIS}" | cut -d' ' -f1)" \
    --arg genesisBlockHash "$([ -r "${GENESIS_HASH_FILE}" ] && tr -d '[:space:]' < "${GENESIS_HASH_FILE}" || echo '')" \
    '$ARGS.named'
}

check_or_write_stamp() {
  local want; want="$(stamp_fields)"

  if [ ! -f "${STAMP}" ]; then
    # 卷是空的（首次启动或刚被 reset）—— 写出生证明
    echo "${want}" > "${STAMP}"
    log "stamp written: configVersion $(echo "${want}" | jq -r .configVersion), chainId $(echo "${want}" | jq -r .chainId)"
    return 0
  fi

  local mismatches=()
  for k in configVersion chainId networkId blockchainName genesisSha256 genesisBlockHash; do
    local a b
    a="$(echo "${want}" | jq -r ".${k}")"
    b="$(jq -r ".${k} // \"\"" "${STAMP}")"
    [ "$a" = "$b" ] || mismatches+=("${k}: chain data ${b}, protocol.json ${a}")
  done

  if [ ${#mismatches[@]} -gt 0 ]; then
    log "this node's data was created with different protocol parameters:"
    for m in "${mismatches[@]}"; do log "  - ${m}"; done
    log "  运行 scripts/devnet-reset 从创世重建，或把参数改回去。"
    fail configuration "protocol parameters changed since this node's data was created" ${EXIT_MISMATCH}
  fi
  log "stamp OK (configVersion $(echo "${want}" | jq -r .configVersion))"
}

# --- 插件：文件名必须等于 VM ID（由链名派生，见 tools/verify/lib/identity.mjs）---
link_plugin() {
  local vm_id; vm_id="$(jq -r .vmId "${IDENTITY}")"
  [ -n "${vm_id}" ] && [ "${vm_id}" != "null" ] || fail configuration "identity.json has no vmId" ${EXIT_DEPS}
  mkdir -p "${KARMACHAIN_PLUGINS}"
  ln -sf "${SUBNET_EVM_BIN}" "${KARMACHAIN_PLUGINS}/${vm_id}"
}

main() {
  check_files
  check_key_material
  check_artifact_compat
  mkdir -p "${KARMACHAIN_DATA}"
  check_or_write_stamp

  # T038（FR-033）：识别崩溃恢复并明确告知，而不是静默继续
  if [ -d "${KARMACHAIN_DATA}/db" ]; then
    log "existing chain data found — recovering from this node's own volume (no snapshot involved)"
  else
    log "empty volume — this node will sync from its peers"
  fi

  if [ "$(jq -r .role "${IDENTITY}")" = "l1-validator" ]; then
    link_plugin
  fi

  log "starting avalanchego with ${FLAGS}"
  exec "${AVALANCHEGO_BIN}" --config-file "${FLAGS}"
}

main "$@"
