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

mkdir -p ./.devnet
{
  printf '{'
  first=1
  for n in ${KARMACHAIN_NODE_IDS}; do
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
      self="$(docker exec "$c" /opt/karmachain/healthcheck.sh --state 2>/dev/null \
              | sed -n 's/.*"state"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' || true)"
    fi
    [ $first -eq 1 ] || printf ','
    first=0
    printf '"%s":{"status":"%s","exitCode":%s,"lastError":"%s","selfState":"%s"}' \
      "$n" "$status" "${code:-0}" "$err" "$self"
  done
  printf '}\n'
} > ./.devnet/containers.json

# 与 devnet-verify 同一模式：接到节点所在的容器网络上。
# 单机形态下节点地址是容器网段（172.28.0.x），不接这个网就一个都探不到；
# 跨机形态下地址是各机器的局域网 IP，容器照样出得去，同一条命令通用。
# MSYS_NO_PATHCONV=1 见 devnet-verify.sh 的说明。
exec env MSYS_NO_PATHCONV=1 docker run --rm   --network karmachain   -v "$(pwd):/workspace"   karmachain/verify:local node tools/inspect/node-status.mjs "$@"
