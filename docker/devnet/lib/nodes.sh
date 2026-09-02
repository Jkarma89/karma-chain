#!/usr/bin/env bash
# lib/nodes.sh —— 枚举本地网络的全部节点（2 个 Primary Network + 5 个 L1 验证者）。
#
# 数据来源是 Avalanche CLI / tmpnet 写在磁盘上的 process.json（含 uri 与 pid），因此不依赖任何
# 硬编码端口；L1 节点再按端口与 protocol.json 的 validators.nodes[] 对齐，得到稳定的 l1-N 标签。
#
# 节点只监听容器内回环（research V-8），verify 容器无法直连，故 runtime.sh 会为每个节点在
# 容器 IP 上起一个同端口 socat 代理，并把本清单写到 .devnet/nodes.json 供验证器使用。

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
# shellcheck source=protocol.sh
source "${KARMACHAIN_LIB}/protocol.sh"

: "${AVALANCHE_CLI_HOME:=/root/.avalanche-cli}"

nodes_container_ip() { hostname -i | awk '{print $1}'; }

# 当前 Primary Network 运行目录（localNetworks.json 指向最新一次 network start）
nodes_primary_dir() {
  local f="${AVALANCHE_CLI_HOME}/localNetworks.json"
  [ -r "${f}" ] && jq -er '.networkDir' "${f}" 2>/dev/null
}

nodes_l1_dir() { printf '%s/local/%s-local-node-local-network' "${AVALANCHE_CLI_HOME}" "$(proto_blockchain_name)"; }

# 从一个节点目录读出 "nodeId port"
_node_entry() {
  local dir="$1" pj="$1/process.json"
  [ -r "${pj}" ] || return 1
  local uri port
  uri="$(jq -er '.uri' "${pj}" 2>/dev/null)" || return 1
  port="${uri##*:}"
  printf '%s %s\n' "$(basename "${dir}")" "${port}"
}

# 完整清单 JSON（stdout）。角色 primary | l1-validator；l1 标签按 protocol.json 的节点序号。
nodes_inventory_json() {
  local ip primary_dir l1_dir
  ip="$(nodes_container_ip)"
  primary_dir="$(nodes_primary_dir || true)"
  l1_dir="$(nodes_l1_dir)"

  {
    # primary-N 按端口升序编号
    local d
    for d in "${primary_dir}"/NodeID-*; do
      [ -d "${d}" ] || continue
      _node_entry "${d}" | awk -v role=primary '{print role" "$1" "$2}'
    done | sort -k3 -n | awk '{printf "%s %s %s %d\n", $1, $2, $3, NR}'

    # l1-N 的序号取自 protocol.json（端口 → validators.nodes[].index），保证与密钥目录一致
    for d in "${l1_dir}"/NodeID-*; do
      [ -d "${d}" ] || continue
      local e nodeid port idx
      e="$(_node_entry "${d}")" || continue
      nodeid="${e%% *}"; port="${e##* }"
      idx="$(proto_get "[.validators.nodes[] | select(.httpPort == ${port}) | .index][0] // empty" 2>/dev/null || true)"
      printf 'l1-validator %s %s %s\n' "${nodeid}" "${port}" "${idx:-0}"
    done | sort -k4 -n
  } | jq -R -s --arg ip "${ip}" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson proxy "$(proto_host_rpc_port)" '
    {
      generatedAt: $at,
      containerIp: $ip,
      proxyPort: $proxy,
      rpcPath: "'"$(proto_rpc_path)"'",
      nodes: (
        split("\n") | map(select(length > 0)) | map(split(" ")) |
        map({
          role: .[0],
          nodeId: .[1],
          httpPort: (.[2] | tonumber),
          index: (.[3] | tonumber),
          label: ((if .[0] == "primary" then "primary-" else "l1-" end) + .[3])
        })
      )
    }'
}

# 所有节点的 HTTP 端口（空格分隔），供代理与检查使用
nodes_http_ports() { nodes_inventory_json | jq -r '.nodes[].httpPort' ; }

nodes_count() { nodes_inventory_json | jq -r '.nodes | length'; }
