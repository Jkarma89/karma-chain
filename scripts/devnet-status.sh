#!/usr/bin/env sh
# scripts/devnet-status.sh —— 逐节点报告恢复状态、高度、peers、所属故障边界（功能 002 / US6）。
#
# 用法：scripts/devnet-status.sh [--json] [--deployment <name>] [--sample-seconds <n>]
# 退出码：0 无须处置的节点 | 1 存在须处置的节点 | 10 Docker 不可用
#
# 三条硬性要求见 specs/002-resilient-validator-network/contracts/cli-interface.md：
# catching-up 与故障可区分（带进度）、边界缺席与节点故障可区分、显示在线数与容错上限的关系。
#
# 本脚本先在**宿主**上采集容器级事实（是否退出、退出码、健康检查自报的状态），
# 写入 .devnet/containers.json，再把判定交给容器内的工具。
# 为什么分两步：判定要能覆盖**其他机器**上的节点，那只能靠网络探测；
# 而"容器为什么退出"只有本机的 docker 知道，容器内没有 docker 可用（宿主也只装 Docker）。
# 采集不到就降级为纯网络判定 —— 少一路证据，不报错。
set -eu
cd "$(dirname "$0")/.."

ENV_FILE="${KARMACHAIN_ENV_FILE:-./docker/compose/active.env}"
[ -f "$ENV_FILE" ] || { echo "devnet-status: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

command -v docker >/dev/null 2>&1 || { echo "devnet-status: docker not found" >&2; exit 10; }

# shellcheck source=./_devnet-common.sh
. "$(dirname "$0")/_devnet-common.sh"
DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
COMPOSE="./docker/compose/${KARMACHAIN_DEPLOYMENT}-${DOMAIN}.yml"

# 只采集**本边界**声明的那几个节点的容器事实 —— 判据取自本机的 compose 文件。
#
# 为什么不能对全部 KARMACHAIN_NODE_IDS 都 docker inspect（原先的写法）：
# 容器名（karmachain-<node>）在整个部署里是全局唯一的，但**同名容器可能在本机残留**
# —— 例如切换部署形态后旧形态的容器没清掉。那时本机会拿这些陈旧容器的事实去描述
# **远端**节点，而 node-status 的"容器事实优先于网络推断"规则会照它下判断。
#
# 2026-09-09 实测：win-1 上残留了 local 形态的 karmachain-primary-1／-2（它们按拓扑
# 属于 ubuntu-1／ubuntu-2），于是 devnet-status 把远端好着的两个 Primary 报成
# `stopped —— 容器已退出（码 137）`。远端节点的容器事实，本机根本无从知道，
# 唯一正确的做法是不去猜。
LOCAL_SERVICES=" $(docker compose -f "$COMPOSE" config --services 2>/dev/null | tr '\n' ' ') "

mkdir -p ./.devnet
# collectedAt 让消费方能判断这份事实是否新鲜。**不是可选的**：本文件在每次运行前重写，
# 但直接调用 tools/inspect/node-status.mjs 时不会 —— 一份过期文件会把"本机主动停止"
# 误判成"整域缺席"。node-status 对无时间戳或超期的文件降级为纯网络判定。
{
  printf '{"collectedAt":%s,"nodes":{' "$(date +%s)"
  first=1
  for n in ${KARMACHAIN_NODE_IDS}; do
    # 不属于本边界就跳过 —— 同名的本地残留容器不能用来描述远端节点（见上）
    case "$LOCAL_SERVICES" in *" $n "*) ;; *) continue ;; esac
    c="karmachain-${n}"
    status="$(docker inspect --format '{{.State.Status}}' "$c" 2>/dev/null || echo '')"
    [ -n "$status" ] || continue
    code="$(docker inspect --format '{{.State.ExitCode}}' "$c" 2>/dev/null || echo 0)"
    # 最后一行 karmachain-node 前缀的日志：入口的失败原因就在那里
    err="$(docker logs --tail 40 "$c" 2>&1 | grep -a 'karmachain-node' | tail -1 \
           | sed 's/[\\"]/ /g; s/[[:cntrl:]]//g' | cut -c1-160 || true)"
    # 容器内的健康检查自报状态：它持有 stalled 的超时窗口，网络探测算不出来
    self=''
    if [ "$status" = "running" ]; then
      # MSYS_NO_PATHCONV=1 是必需的：Git Bash 会把 /opt/... 当成本地路径改写，
      # docker exec 于是失败，而 `2>/dev/null || true` 把它**静默吞掉** ——
      # 症状是 selfState 恒为空，也就是 Windows 宿主上永远拿不到容器自报的 stalled，
      # 而那个状态只有容器判得出来（它持有超时窗口）。2026-09-09 实测发现。
      self="$(env MSYS_NO_PATHCONV=1 docker exec "$c" /opt/karmachain/healthcheck.sh --state 2>/dev/null \
              | sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
    fi
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s":{"status":"%s","exitCode":%s,"lastError":"%s","selfState":"%s"}' \
      "$n" "$status" "${code:-0}" "$err" "$self"
  done
  printf '}}\n'
} > ./.devnet/containers.json

# 与 devnet-verify 同一模式：接到节点所在的容器网络上。
# 单机形态下节点地址是容器网段（172.28.0.x），不接这个网就一个都探不到；
# 跨机形态下地址是各机器的局域网 IP，容器照样出得去，同一条命令通用。
#
# 网络名由公共件推导，**不能写死** —— 此前这里是 `--network karmachain`，
# 那是单机形态才渲染出的网络，跨机形态下这条命令必然失败（与 devnet-verify 同一缺陷，
# 2026-09-09 才发现漏改了本文件）。MSYS_NO_PATHCONV=1 见 _devnet-common.sh 的说明。
# 工具镜像是本地构建的：不存在时 docker 会去 pull 并报一句指向错误方向的
# "pull access denied … may require docker login"。理由见 _devnet-common.sh。
devnet_require_verify_image || { echo "devnet-status: 前置条件未满足（见上）" >&2; exit 10; }

NETWORK="$(devnet_node_network "$DOMAIN")" || { echo "devnet-status: 前置条件未满足（见上）" >&2; exit 10; }

exec env MSYS_NO_PATHCONV=1 docker run --rm \
  --network "$NETWORK" \
  -v "$(pwd):/workspace" \
  karmachain/verify:local node tools/inspect/node-status.mjs "$@"
