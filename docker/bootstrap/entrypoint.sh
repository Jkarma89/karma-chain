#!/usr/bin/env bash
# KarmaChain 一次性建链入口（功能 002 / T008）
#
# 只做三件事：起临时的本地网络 → 建链 → 把 CLI 的**原始产出**搬到挂载卷上，然后停网退出。
# 不做任何重塑：把原始产出变成 blockchain/chain-identity/ 制品的是
# tools/protocol/extract-identity.mjs 与 extract-primary-genesis.mjs（Node，可单测）。
# 容器脚本不含业务逻辑 —— 001 已确立的分工。
set -euo pipefail

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
: "${AVALANCHE_CLI_HOME:=/root/.avalanche-cli}"
: "${BOOTSTRAP_OUT:=/workspace/.devnet/bootstrap}"
# 本镜像只建链，不承载运行 —— socat / ss / bc 是运行期工具，刻意未安装
: "${KARMACHAIN_REQUIRED_TOOLS:=jq curl avalanche}"

# shellcheck source=../lib/protocol.sh
source "${KARMACHAIN_LIB}/protocol.sh"
# shellcheck source=../lib/binaries.sh
source "${KARMACHAIN_LIB}/binaries.sh"
# shellcheck source=../lib/avalanche.sh
source "${KARMACHAIN_LIB}/avalanche.sh"
# shellcheck source=../lib/preflight.sh
source "${KARMACHAIN_LIB}/preflight.sh"

EXIT_DEPS=10
EXIT_ARTIFACT_EXISTS=12
EXIT_BOOTSTRAP_FAILED=20

log() { echo "[bootstrap] $*"; }

GENESIS_FILE="${GENESIS_FILE:-/workspace/blockchain/genesis/karmachain.genesis.json}"
IDENTITY_FILE="/workspace/blockchain/chain-identity/karmachain.identity.json"

# ---------------------------------------------------------------------------
# 播种节点卷
#
# 建链的产出**不只是几个 JSON**：Subnet 与 Blockchain 是 P 链上的交易，只存在于节点数据库里。
# 002 的节点若从空卷启动，得到的是一条全新的 P 链 —— 上面从没发生过那两笔交易，L1 也就不存在
# （实测：platform.getSubnets 只返回 Primary Network，/ext/bc/<alias>/rpc 返回 404）。
#
# 因此建链完成后必须把 CLI 那套节点的数据库播种进 002 的卷。二者节点身份相同（同一套 staking
# 密钥），BlockchainID 已实测确定性，数据目录布局兼容。
#
# 匹配方式用**证书 sha256**：CLI 的节点目录以 NodeID 命名，而 NodeID 需要 CB58 才能算出来；
# 改为比对证书本身的摘要，纯 shell 即可，且不依赖任何预生成文件。
# ---------------------------------------------------------------------------
seed_node_volumes() {
  local seed_root="${SEED_ROOT:-/seed}"
  if [ ! -d "${seed_root}" ]; then
    log "no ${seed_root} mounted — skipping volume seeding (仅提取制品)"
    return 0
  fi

  # 我们的节点 id → staking 证书摘要
  local ids=() sums=()
  while IFS=$'\t' read -r id keydir; do
    [ -n "${id}" ] || continue
    local crt="/workspace/${keydir}staker.crt"
    [ -r "${crt}" ] || { log "FAILED [category: configuration] missing ${crt}"; exit ${EXIT_DEPS}; }
    ids+=("${id}")
    sums+=("$(sha256sum "${crt}" | cut -d' ' -f1)")
    # 验证者的 keyDir 在 validators.nodes[]（唯一出处），primary 的在 topology 里自带
  done < <(jq -r '
      .validators.nodes as $v
      | .topology.nodes[] as $n
      | [ $n.id,
          (if $n.role == "primary" then $n.keyDir
           else ($v[] | select(.index == $n.validatorIndex) | .keyDir) end) ]
      | @tsv' "${DEPLOYMENT_FILE}")

  local seeded=0
  # CLI 的节点目录：L1 在 local/<name>-local-node-local-network/NodeID-*，Primary 在 runs/network_*/NodeID-*
  while IFS= read -r nodedir; do
    [ -f "${nodedir}/flags.json" ] || continue
    local got
    got="$(jq -r '."staking-tls-cert-file-content" // empty' "${nodedir}/flags.json" | base64 -d 2>/dev/null | sha256sum | cut -d' ' -f1)"
    [ -n "${got}" ] || continue

    local i=0 matched=""
    for s in "${sums[@]}"; do
      [ "${s}" = "${got}" ] && { matched="${ids[$i]}"; break; }
      i=$((i + 1))
    done
    [ -n "${matched}" ] || { log "  skip $(basename "${nodedir}") — 不属于本拓扑"; continue; }

    local dest="${seed_root}/${matched}"
    mkdir -p "${dest}"
    # 只搬数据：db 与 chainData。CLI 自己的 flags.json / config.json 不搬 —— 002 用生成的那套。
    for sub in db chainData; do
      [ -d "${nodedir}/${sub}" ] || continue
      rm -rf "${dest:?}/${sub}"
      cp -a "${nodedir}/${sub}" "${dest}/${sub}"
    done
    log "  seeded ${matched} <- $(basename "${nodedir}") ($(du -sh "${dest}" 2>/dev/null | cut -f1))"
    seeded=$((seeded + 1))
  done < <(find "${AVALANCHE_CLI_HOME}/local" "${AVALANCHE_CLI_HOME}/runs" -maxdepth 2 -type d -name 'NodeID-*' 2>/dev/null)

  local want=${#ids[@]}
  if [ "${seeded}" -ne "${want}" ]; then
    log "FAILED [category: node] seeded ${seeded} node volumes but topology declares ${want}"
    exit ${EXIT_BOOTSTRAP_FAILED}
  fi
  log "seeded ${seeded}/${want} node volumes — 002 的节点将接管这条已建好的链"
}

main() {
  local name; name="$(proto_blockchain_name)"
  local force=0
  for a in "$@"; do [ "$a" = "--force" ] && force=1; done

  # 建链是一次性动作：已有制品时默认拒绝，避免无意间换掉链身份
  if [ -f "${IDENTITY_FILE}" ] && [ "${force}" = "0" ]; then
    log "FAILED [category: configuration] ${IDENTITY_FILE} already exists."
    log "  重新建链会产生新的 SubnetID / BlockchainID，与现有链数据不再匹配。"
    log "  确实要重建请加 --force，并准备好 scripts/devnet-reset。"
    exit ${EXIT_ARTIFACT_EXISTS}
  fi

  preflight_all --skip-ports || exit ${EXIT_DEPS}
  ensure_cached_binaries

  log "starting a temporary local network ($(proto_primary_nodes) primary nodes) ..."
  av_network_start || { log "FAILED [category: node] 'avalanche network start' failed"; exit ${EXIT_BOOTSTRAP_FAILED}; }

  log "creating blockchain '${name}' from ${GENESIS_FILE} ..."
  av_blockchain_create "${name}" "${GENESIS_FILE}" \
    || { log "FAILED [category: genesis] 'avalanche blockchain create' rejected the genesis or configuration"; exit ${EXIT_BOOTSTRAP_FAILED}; }

  # 链配置必须在 deploy 之前就位：CLI 会把 subnets/<name>/chain.json 写进节点数据库。
  # 建链用默认（修剪）而运行时用归档，等于在修剪模式写过的库上切模式 —— 实测会卡在引导中。
  local chaincfg="/workspace/blockchain/chain-config.json"
  if [ -r "${chaincfg}" ]; then
    cp "${chaincfg}" "${AVALANCHE_CLI_HOME}/subnets/${name}/chain.json"
    log "chain config applied for bootstrap: pruning-enabled=$(jq -r '."pruning-enabled"' "${chaincfg}")"
  else
    log "FAILED [category: configuration] ${chaincfg} missing — run npm run node:render first"
    exit ${EXIT_DEPS}
  fi

  log "deploying L1 with $(proto_validator_count) validators (fixed dev keys) ..."
  AV_STAKING_KEYS=1 av_blockchain_deploy_local "${name}" \
    || { log "FAILED [category: validator] 'avalanche blockchain deploy --local' failed"; exit ${EXIT_BOOTSTRAP_FAILED}; }

  # --- 搬运原始产出（不重塑）---
  mkdir -p "${BOOTSTRAP_OUT}"

  local sidecar="${AVALANCHE_CLI_HOME}/subnets/${name}/sidecar.json"
  [ -f "${sidecar}" ] || { log "FAILED [category: genesis] sidecar not found at ${sidecar}"; exit ${EXIT_BOOTSTRAP_FAILED}; }
  cp "${sidecar}" "${BOOTSTRAP_OUT}/sidecar.json"

  # 任取一个 L1 节点的 flags.json —— Primary Network 创世内联在它的 genesis-file-content 里
  local anyflags
  anyflags="$(find "${AVALANCHE_CLI_HOME}/local" -name flags.json -print -quit 2>/dev/null || true)"
  [ -n "${anyflags}" ] || { log "FAILED [category: node] no node flags.json found under ${AVALANCHE_CLI_HOME}/local"; exit ${EXIT_BOOTSTRAP_FAILED}; }
  cp "${anyflags}" "${BOOTSTRAP_OUT}/node-flags.json"

  log "raw CLI output copied to ${BOOTSTRAP_OUT}: sidecar.json, node-flags.json"

  # 建链完成即停网 —— 本容器不负责运行，运行是 docker/node/ 的事。
  # 必须在拷贝数据库之前干净停止，否则拷到的是写了一半的 LevelDB。
  log "stopping the temporary network ..."
  av_network_stop >/dev/null 2>&1 || log "WARNING: 'avalanche network stop' returned an error (临时网络，无需保留)"
  pkill -x avalanchego 2>/dev/null || true
  sleep 3

  seed_node_volumes

  log "done. 下一步：node tools/protocol/extract-identity.mjs 生成 chain-identity 制品"
}

main "$@"
