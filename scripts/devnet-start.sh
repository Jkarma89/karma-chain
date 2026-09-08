#!/usr/bin/env sh
# scripts/devnet-start.sh —— 启动 KarmaChain 开发网络（功能 002）
#
# 薄封装，无业务逻辑：只 compose up，然后等 RPC 应答。
#
# **没有"恢复快照"这条路径。** 每个节点从自己的数据卷恢复，编排不参与其中 ——
# 这正是缺陷 A 的修复方式（研究 R-01）。上一次是否优雅停止，与本次能否启动无关。
#
# 退出码：0 就绪 | 10 前置依赖缺失 | 11 宿主端口冲突 | 12 链数据与声明不一致 | 20 启动失败/超时
set -eu
cd "$(dirname "$0")/.."

# KARMACHAIN_ENV_FILE 只为测试留的接缝：跨机形态的守卫（下方"本机不是拓扑说的那台机器"）
# 只有在 activeDeployment 为多边界时才生效，而把生效形态切到跨机会打断正在跑的单机开发网。
# 有了这个接缝，测试可以指向一份临时生成的 active.env，不必改动唯一事实来源。
ENV_FILE="${KARMACHAIN_ENV_FILE:-./docker/compose/active.env}"
[ -f "$ENV_FILE" ] || { echo "devnet-start: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
COMPOSE="./docker/compose/${KARMACHAIN_DEPLOYMENT}-${DOMAIN}.yml"
TIMEOUT="${KARMACHAIN_STARTUP_TIMEOUT:-300}"
RPC="http://127.0.0.1:${KARMACHAIN_RPC_PORT}${KARMACHAIN_RPC_PATH}"

[ -f "$COMPOSE" ] || {
  echo "devnet-start: 未知的故障边界 '${DOMAIN}' —— 可选：${KARMACHAIN_DOMAINS}" >&2
  echo "  用 KARMACHAIN_DOMAIN=<边界 id> 指定本机要跑哪一个" >&2
  exit 10
}

command -v docker >/dev/null 2>&1 || { echo "devnet-start: docker not found — install Docker Desktop (Windows: WSL2 backend) or Docker Engine + Compose v2" >&2; exit 10; }
docker info >/dev/null 2>&1 || { echo "devnet-start: Docker daemon is not running" >&2; exit 10; }
docker compose version >/dev/null 2>&1 || { echo "devnet-start: 'docker compose' (v2) not available" >&2; exit 10; }

[ -f ./blockchain/chain-identity/karmachain.identity.json ] || {
  echo "devnet-start: 链尚未建立 —— 先运行 'scripts/devnet-bootstrap'" >&2
  echo "  建链是一次性动作：它在 P 链上创建 Subnet 与 Blockchain，并把结果播种进节点卷。" >&2
  exit 10
}


# 制品在、但 P 链上**没有**那条链 ⇒ 卷被 reset 删过（reset 不动仓库里的制品），或从未建链。
#
# 为什么必须专门拦一下：不拦的话这条路径会**等满 300 秒**，然后给出一句"300s 内未就绪" ——
# 毫无指向性，而真正的原因是"链不存在"。这是 T091 的往返测试抓到的。
#
# 判据只能是"问 P 链"，不能看文件系统：空卷上的 avalanchego 会为**它自己那条全新的 P 链**
# 建出 /data/db，所以"db 目录存在"区分不了"已建链"与"全新空链"（实测踩过）。
#
# 只问**本机承载的** Primary（跨机形态下它们只在个别机器上）；本机没有 Primary、
# 或还问不到，就跳过并交给正常的就绪轮询 —— 少一路证据，不误报。
# 验证者的空卷是**合法**的：它们能从 Primary 重新同步（研究 R-15 实测），不该拦。
assert_chain_on_pchain() {
  bid=""
  for n in ${KARMACHAIN_NODE_IDS}; do
    case " ${KARMACHAIN_VALIDATOR_IDS} " in *" ${n} "*) continue ;; esac   # 跳过验证者
    c="karmachain-${n}"
    docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null | grep -q running || continue
    # 端口与链 id 都从容器内已挂载的配置里取，宿主不必解析 JSON（宿主只装 Docker）
    port="$(MSYS_NO_PATHCONV=1 docker exec "$c" jq -r '."http-port"' /config/flags.json 2>/dev/null)" || continue
    bid="$(MSYS_NO_PATHCONV=1 docker exec "$c" jq -r '.blockchainId' /config/karmachain.identity.json 2>/dev/null)" || continue
    [ -n "$port" ] && [ -n "$bid" ] || continue
    # **P 链必须先引导完成**，否则 getBlockchains 的清单是不完整的。
    # 这一步是必需的：崩溃恢复时（docker kill 全部容器后重启）Primary 的 P 链仍在引导，
    # 此刻清单只有 C-Chain / X-Chain，据此判定"链不存在"会把 US1 的恢复路径直接拦死。
    # 实测踩过：50 轮重复崩溃测试第一轮就被这个假阳性打断。
    #
    # 教训：**打在正常路径上的诊断守卫必须保守** —— 拿不准就放行，交给后面的就绪轮询。
    # 原先的判据是"未证明存在即失败"，在慢启动时会反转成误报。
    boot="$(docker exec "$c" curl -s -m 5 -X POST -H 'content-type: application/json' \
             --data '{"jsonrpc":"2.0","id":1,"method":"info.isBootstrapped","params":{"chain":"P"}}' \
             "http://127.0.0.1:${port}/ext/info" 2>/dev/null)" || continue
    echo "$boot" | grep -q '"isBootstrapped":true' || continue   # P 链还在引导 —— 结论未定，放行

    out="$(docker exec "$c" curl -s -m 5 -X POST -H 'content-type: application/json' \
            --data '{"jsonrpc":"2.0","id":1,"method":"platform.getBlockchains","params":{}}' \
            "http://127.0.0.1:${port}/ext/bc/P" 2>/dev/null)" || continue
    [ -n "$out" ] || continue
    if echo "$out" | grep -q "$bid"; then return 0; fi     # 链在 P 链上，一切正常
    echo "devnet-start: FAILED [category: configuration] P 链上没有 ${bid} —— 链尚未建立或已被 reset" >&2
    echo "  Subnet 与 Blockchain 是 P 链上的交易，只存在于 Primary 节点的数据库里；空卷上没有那条链。" >&2
    echo "  仓库里的建链制品还在，但它指向一条这些卷上不存在的链。" >&2
    echo "  依次执行：scripts/devnet-stop  →  scripts/devnet-bootstrap  →  scripts/devnet-start" >&2
    echo "  （必须先 stop：建链要独占那些卷，有节点在跑时 devnet-bootstrap 会以退出码 10 拒绝）" >&2
    return 10
  done
  return 0   # 本机没有 Primary，或都问不到 —— 交给就绪轮询
}

# 跨机形态：本机必须真的是拓扑说的那台机器（V-07 / FR-023）。
#
# 为什么非查不可：节点用 --public-ip 向对等节点通告自己的地址，而容器处在 NAT 后面，
# **看不到宿主的局域网地址**，因此容器内无从校验。配错时节点照常启动、日志无异常，
# 症状表现为对等节点连不上它 —— 也就是 V-07 要避免的"随机连接失败"。
# 把仓库拷到另一台机器却忘了设 KARMACHAIN_DOMAIN，正是最容易踩的一种。
#
# 单边界形态（KARMACHAIN_DOMAIN_COUNT=1）跳过：那时地址是 127.0.0.1，不是网卡地址。
if [ "${KARMACHAIN_DOMAIN_COUNT:-1}" -gt 1 ]; then
  want=""
  for pair in $KARMACHAIN_DOMAIN_ADDRESSES; do
    case "$pair" in "${DOMAIN}="*) want="${pair#*=}";; esac
  done
  # 本机全部 IPv4 地址。必须逐平台用**结构化**的取法：早先图省事对 ipconfig 的输出直接
  # grep 点分四段，结果把子网掩码（255.255.255.0）与默认网关一并当成了"本机地址" ——
  # 掩码只要恰好等于某个声明地址，守卫就会误判通过。
  local_ipv4() {
    if command -v ip >/dev/null 2>&1; then
      ip -4 -o addr show scope global 2>/dev/null | awk '{ split($4, a, "/"); print a[1] }'
    elif command -v ifconfig >/dev/null 2>&1; then
      ifconfig 2>/dev/null | awk '/inet /{ print $2 }' | sed 's/^addr://'
    elif command -v powershell >/dev/null 2>&1; then
      # Git Bash on Windows：ipconfig 的字段名随系统语言变化，Get-NetIPAddress 是结构化的
      powershell -NoProfile -Command '(Get-NetIPAddress -AddressFamily IPv4).IPAddress' 2>/dev/null | tr -d '\r'
    else
      ipconfig 2>/dev/null | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | grep -v '^255\.'
    fi | grep -vE '^(127\.|169\.254\.)' | sort -u
  }
  mine="$(local_ipv4)"
  if [ -n "$want" ] && ! echo "$mine" | grep -qx "$want"; then
    echo "devnet-start: FAILED [category: configuration] 本机不是故障边界 '${DOMAIN}' 声明的那台机器" >&2
    echo "  拓扑声明 ${DOMAIN} 的地址为 ${want}，但本机的 IPv4 地址是：" >&2
    echo "$mine" | sed 's/^/    /' >&2
    echo "  节点会把 ${want} 通告给对等节点，而那不是本机地址 —— 对等节点将连不上它，" >&2
    echo "  且节点自身日志不会报错（容器在 NAT 后，看不到宿主地址）。" >&2
    echo "  三种修正方式，择一：" >&2
    echo "    1. 本机要跑的其实是别的边界 → KARMACHAIN_DOMAIN=<本机对应的边界 id> scripts/devnet-start" >&2
    echo "       可选边界与地址：${KARMACHAIN_DOMAIN_ADDRESSES}" >&2
    echo "    2. 这台机器的地址变了 → KARMACHAIN_ADDRESS_OVERRIDE='${DOMAIN}=<新地址>' npm run node:render" >&2
    echo "    3. 地址应长期改变 → 改 blockchain/protocol.json 的 topology.deployments 后重新渲染" >&2
    exit 13
  fi
fi

chain_id() {
  curl -s -m 5 -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$RPC" 2>/dev/null \
    | sed -n 's/.*"result"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# 幂等：已在运行且 RPC 已应答时直接返回（FR-006）
if [ "$(chain_id)" = "$KARMACHAIN_CHAIN_ID_HEX" ]; then
  echo "devnet-start: 已在运行并正常应答 —— 无需操作"
  exit 0
fi

if ! out="$(docker compose -f "$COMPOSE" up -d 2>&1)"; then
  echo "$out" >&2
  if echo "$out" | grep -qiE "port is already allocated|address already in use|bind: "; then
    echo "devnet-start: FAILED [category: configuration] 宿主端口 ${KARMACHAIN_RPC_PORT} 被占用" >&2
    exit 11
  fi
  echo "devnet-start: FAILED [category: node] docker compose up 失败" >&2
  exit 20
fi

# compose 的 depends_on 已等到 Primary 健康，此刻可以问 P 链了。
# 放在轮询**之前**：链不存在时立刻失败，而不是等满 300 秒给一句"未就绪"。
assert_chain_on_pchain || exit 10

start=$(date +%s)
while :; do
  got="$(chain_id)"
  if [ "$got" = "$KARMACHAIN_CHAIN_ID_HEX" ]; then
    height="$(curl -s -m 5 -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$RPC" 2>/dev/null \
      | sed -n 's/.*"result"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    echo
    echo "KarmaChain is READY   (deployment ${KARMACHAIN_DEPLOYMENT}, failure domain ${DOMAIN}, $(( $(date +%s) - start ))s)"
    echo
    echo "  RPC URL   : ${RPC}"
    echo "  Chain ID  : ${KARMACHAIN_CHAIN_ID_HEX}"
    echo "  Height    : ${height}"
    echo "  Nodes     : ${KARMACHAIN_NODE_IDS}"
    echo "  容错      : ${KARMACHAIN_MAX_OFFLINE_VALIDATORS} 个验证者可离线（共 $(echo "$KARMACHAIN_VALIDATOR_IDS" | wc -w) 个）"
    echo
    echo "  Next: scripts/devnet-status  |  scripts/devnet-logs <node>  |  scripts/devnet-stop"
    exit 0
  fi

  # 任一节点以约定退出码结束 = 校验失败，立刻转达，不必等满超时
  for n in $KARMACHAIN_NODE_IDS; do
    state="$(docker inspect --format '{{.State.Status}}' "karmachain-$n" 2>/dev/null || echo missing)"
    if [ "$state" = "exited" ]; then
      code="$(docker inspect --format '{{.State.ExitCode}}' "karmachain-$n" 2>/dev/null || echo 20)"
      case "$code" in
        10|12)
          docker logs "karmachain-$n" 2>&1 | grep karmachain-node | tail -8 >&2
          echo "devnet-start: 节点 $n 以退出码 $code 结束（见上）" >&2
          exit "$code"
          ;;
      esac
    fi
  done

  if [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then
    docker compose -f "$COMPOSE" ps >&2
    echo "devnet-start: FAILED [category: node] ${TIMEOUT}s 内未就绪（KARMACHAIN_STARTUP_TIMEOUT）" >&2
    exit 20
  fi
  sleep 3
done
