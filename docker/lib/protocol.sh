#!/usr/bin/env bash
# lib/protocol.sh —— 容器内读取 blockchain/protocol.json（唯一事实来源，宪法第十六条）的唯一入口。
# 任何容器内脚本需要链参数时必须调用这里的函数，禁止写死数值（FR-017）。

: "${PROTOCOL_FILE:=/workspace/blockchain/protocol.json}"
# 部署描述（功能 005）：机器、地址、端口、故障边界。**它不进出生证明（stamp）** ——
# 改它不需要重置链。JS 侧的对应物是 tools/protocol/load.mjs 的 DEFAULT_DEPLOYMENT_PATH。
: "${DEPLOYMENT_FILE:=/workspace/blockchain/deployment.json}"

proto_file() { printf '%s' "${PROTOCOL_FILE}"; }

proto_require() {
  [ -r "${PROTOCOL_FILE}" ] || { echo "protocol file not found: ${PROTOCOL_FILE} (is ./blockchain mounted at /workspace/blockchain?)" >&2; return 1; }
  command -v jq >/dev/null || { echo "jq is required" >&2; return 1; }
}

# 通用取值：proto_get '.chain.chainId'
proto_get() { proto_require && jq -er "$1" "${PROTOCOL_FILE}"; }

# 从**部署描述**取值。与 proto_get 分开，是为了让"这个值住在哪一侧"在调用处就看得见 ——
# 混用会让人以为改端口也要递增 configVersion（那正是 005 要纠正的那个分类错误）。
deploy_require() {
  [ -r "${DEPLOYMENT_FILE}" ] || { echo "deployment file not readable at ${DEPLOYMENT_FILE}" >&2; return 1; }
}
deploy_get() { deploy_require && jq -er "$1" "${DEPLOYMENT_FILE}"; }

# --- 常用字段 ---
proto_name()              { proto_get '.name'; }
proto_environment()       { proto_get '.environment'; }
proto_config_version()    { proto_get '.configVersion'; }
proto_chain_id()          { proto_get '.chain.chainId'; }
proto_mainnet_chain_id()  { proto_get '.chain.reservedMainnetChainId'; }
proto_blockchain_name()   { proto_get '.chain.blockchainName'; }
proto_network_id()        { proto_get '.avalanche.networkId'; }
proto_avalanchego_ver()   { proto_get '.avalanche.avalanchegoVersion'; }
proto_subnet_evm_ver()    { proto_get '.avalanche.subnetEvmVersion'; }
proto_token_name()        { proto_get '.nativeToken.name'; }
proto_token_symbol()      { proto_get '.nativeToken.symbol'; }
proto_token_decimals()    { proto_get '.nativeToken.decimals'; }
proto_block_mode()        { proto_get '.blockProduction.mode'; }
proto_primary_nodes()     { deploy_get '.primaryNetwork.nodeCount'; }
proto_validator_count()   { deploy_get '.validators.count'; }
proto_validator_mgmt()    { proto_get '.validators.management'; }
proto_host_rpc_port()     { deploy_get '.endpoints.hostRpcPort'; }
proto_rpc_path()          { deploy_get '.endpoints.rpcPath'; }

# 验证者端口列表（逗号分隔，供 CLI --http-port / --staking-port）
proto_validator_http_ports()    { deploy_get '[.validators.nodes[].httpPort] | map(tostring) | join(",")'; }
proto_validator_staking_ports() { deploy_get '[.validators.nodes[].stakingPort] | map(tostring) | join(",")'; }
proto_validator_http_port()     { deploy_get ".validators.nodes[] | select(.index == $1) | .httpPort"; }   # $1 = index
proto_validator_key_dir()       { deploy_get ".validators.nodes[] | select(.index == $1) | .keyDir"; }
proto_first_validator_http_port() { deploy_get '.validators.nodes[0].httpPort'; }

# 开发账户
proto_owner_label()       { proto_get '.validators.ownerAccount'; }
proto_account_address()   { proto_get ".devAccounts[] | select(.label == \"$1\") | .address"; }   # $1 = label
proto_owner_address()     { proto_account_address "$(proto_owner_label)"; }
proto_account_labels()    { proto_get '.devAccounts[].label'; }
proto_account_balance_wei(){ proto_get ".devAccounts[] | select(.label == \"$1\") | .balanceWei"; }

# 派生值（与 tools/protocol/load.mjs derive() 保持一致）
proto_chain_id_hex()      { printf '0x%x' "$(proto_chain_id)"; }
proto_rpc_url_host()      { printf 'http://127.0.0.1:%s%s' "$(proto_host_rpc_port)" "$(proto_rpc_path)"; }
proto_rpc_url_node()      { printf 'http://127.0.0.1:%s%s' "$(proto_validator_http_port "${1:-1}")" "$(proto_rpc_path)"; }
proto_total_nodes()       { echo $(( $(proto_primary_nodes) + $(proto_validator_count) )); }
