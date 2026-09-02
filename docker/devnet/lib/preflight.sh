#!/usr/bin/env bash
# lib/preflight.sh —— 启动前检查（FR-007）。失败时输出可操作信息并按 cli-interface.md 退出：
#   10 = 前置依赖缺失 / 配置不可用 [category: configuration]
#   11 = 端口冲突                  [category: configuration]
# 注意：宿主机端口冲突在 compose 绑定端口时就会失败，由 scripts/devnet-start.* 识别为 11；这里只能检查容器内端口。

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
source "${KARMACHAIN_LIB}/protocol.sh"
source "${KARMACHAIN_LIB}/binaries.sh"

EXIT_DEPS=10
EXIT_PORT=11

pf_fail() { # pf_fail <exit-code> <category> <message...>
  local code="$1" category="$2"; shift 2
  echo "[karmachain] PREFLIGHT FAILED [category: ${category}] $*" >&2
  exit "${code}"
}

preflight_tools() {
  local t missing=()
  for t in jq curl socat ss bc avalanche; do command -v "$t" >/dev/null 2>&1 || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || pf_fail ${EXIT_DEPS} configuration "missing tools in image: ${missing[*]} — rebuild the devnet image (docker compose build devnet)"
}

preflight_protocol() {
  [ -r "${PROTOCOL_FILE}" ] || pf_fail ${EXIT_DEPS} configuration "protocol file not readable at ${PROTOCOL_FILE}; is ./blockchain mounted read-only at /workspace/blockchain?"
  jq -e . "${PROTOCOL_FILE}" >/dev/null 2>&1 || pf_fail ${EXIT_DEPS} configuration "protocol file is not valid JSON: ${PROTOCOL_FILE}"
  [ "$(proto_environment)" = "dev" ] || pf_fail ${EXIT_DEPS} configuration "protocol.json environment must be 'dev' (got $(proto_environment))"
  [ "$(proto_chain_id)" != "$(proto_mainnet_chain_id)" ] || pf_fail ${EXIT_DEPS} configuration "chainId equals reservedMainnetChainId — refusing to impersonate mainnet"
  local genesis="/workspace/blockchain/genesis/karmachain.genesis.json"
  [ -r "${genesis}" ] || pf_fail ${EXIT_DEPS} genesis "genesis file missing: ${genesis} — run 'npm run protocol:render' on the host"
  jq -e --argjson id "$(proto_chain_id)" '.config.chainId == $id' "${genesis}" >/dev/null \
    || pf_fail ${EXIT_DEPS} genesis "genesis chainId != protocol.json chainId — run 'npm run protocol:render' and reset"
  local i n; n="$(proto_validator_count)"
  for ((i = 1; i <= n; i++)); do
    local d; d="/workspace/$(proto_validator_key_dir "$i")"
    [ -r "${d}staker.crt" ] && [ -r "${d}staker.key" ] && [ -r "${d}signer.key" ] \
      || pf_fail ${EXIT_DEPS} configuration "validator key material missing in ${d} (staker.crt / staker.key / signer.key)"
  done
}

preflight_binaries() {
  ensure_cached_binaries || pf_fail ${EXIT_DEPS} configuration "pre-seeded avalanchego/subnet-evm binaries missing — rebuild the devnet image"
  assert_binary_versions_match_protocol || pf_fail ${EXIT_DEPS} configuration "image binary versions do not match protocol.json — rebuild the devnet image"
}

preflight_memory() {
  local total_mb; total_mb=$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo)
  local want_mb="${KARMACHAIN_MIN_MEMORY_MB:-4096}"
  if [ "${total_mb}" -lt "${want_mb}" ]; then
    echo "[karmachain] WARNING: container sees ${total_mb} MB memory; ${want_mb} MB recommended for 7 nodes (Docker Desktop → Settings → Resources)" >&2
  fi
}

# 端口检查：网络未运行时，容器内不应有人占用我们要用的端口
preflight_ports() {
  local ports=() p busy=()
  ports+=("${KARMACHAIN_PROXY_PORT:-$(proto_host_rpc_port)}" 9650 9651 9652 9653)
  for p in $(proto_validator_http_ports | tr ',' ' ') $(proto_validator_staking_ports | tr ',' ' '); do ports+=("$p"); done
  for p in "${ports[@]}"; do
    if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}$"; then busy+=("$p"); fi
  done
  [ ${#busy[@]} -eq 0 ] || pf_fail ${EXIT_PORT} configuration "ports already in use inside the container: ${busy[*]} — is another devnet process running? (scripts/devnet-status, or docker compose down)"
}

preflight_all() {
  preflight_tools
  preflight_protocol
  preflight_binaries
  preflight_memory
  if [ "${1:-}" != "--skip-ports" ]; then preflight_ports; fi
  echo "[karmachain] preflight OK"
}
