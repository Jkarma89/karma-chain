#!/usr/bin/env sh
# scripts/devnet-node.sh —— 单节点生命周期控制，用于故障注入（功能 002 / T044）。
#
# 本脚本的存在即 **FR-018**（每个节点 MUST 是可单独启动、停止、重启的运行单元）的落地：
# 001 的单容器形态里做不到这件事 —— 7 个节点是一个容器内的 7 个进程，
# 只能整体起停。一节点一容器之后，故障注入才能精确到单个节点。
#
# 用法：scripts/devnet-node.sh <kill|stop|start|restart|status|wipe> <node-id>
#
#   kill     SIGKILL —— **不给优雅退出机会**，用于验证崩溃自愈（US1/US2）
#   stop     SIGTERM 后停止，节点有机会正常收尾
#   start    启动（容器不存在时创建）
#   restart  stop + start
#   status   该节点的运行/健康状态
#   wipe     删除该节点的数据卷（模拟数据损坏，FR-006）—— 节点会从对等节点重新同步
#
# 002 起每个节点是独立容器，因此直接对容器操作即可；001 时七个节点挤在一个容器里，
# 这条命令得先进容器再按 PID 操作（研究 R-01）。
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-node: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
COMPOSE="./docker/compose/${KARMACHAIN_DEPLOYMENT}-${DOMAIN}.yml"

command -v docker >/dev/null 2>&1 || { echo "devnet-node: docker not found" >&2; exit 10; }

ACTION="${1:-}"
NODE="${2:-}"
[ -n "$ACTION" ] && [ -n "$NODE" ] || {
  echo "用法: scripts/devnet-node.sh <kill|stop|start|restart|status|wipe> <node-id>" >&2
  echo "  节点: ${KARMACHAIN_NODE_IDS}" >&2
  exit 10
}

# ① 拼写检查：这个 id 在**整张网络**里存在吗
case " ${KARMACHAIN_NODE_IDS} " in
  *" ${NODE} "*) ;;
  *) echo "devnet-node: 未知节点 '${NODE}' —— 可选: ${KARMACHAIN_NODE_IDS}" >&2; exit 10 ;;
esac

# ② 它必须由**本机**承载 —— 跨边界的节点在另一台机器上，这里管不着。
#
# 此前只有 ① 而注释写着"节点必须属于本故障边界" ——
# **一条声称存在的检查并不存在**（与 FR-014 那次同形）。
# 后果在**非默认机器**上显形：win-2 上没设 KARMACHAIN_DOMAIN 时边界回落成 win-1，
# 于是 `stop l1-2` 去 lan-win-1.yml 里找 l1-2（那份只定义 l1-1），
# compose 报 `no such service: l1-2` —— 而 .ps1 那版照报"已停止"。
# 2026-09-17 在 win-2 上实地撞到：**l1-2 根本没停，而命令说停了。**
#
# 判据取本机 compose 真正定义的服务，而不是再写一份会过期的清单。
LOCAL_SERVICES="$(docker compose -f "$COMPOSE" config --services 2>/dev/null | tr '\n' ' ')"
case " ${LOCAL_SERVICES} " in
  *" ${NODE} "*) ;;
  *)
    echo "devnet-node: 本机（边界 ${DOMAIN}）不承载节点 '${NODE}'" >&2
    echo "  本机承载: ${LOCAL_SERVICES}" >&2
    if [ -n "${KARMACHAIN_DOMAIN:-}" ]; then
      echo "  当前边界取自 KARMACHAIN_DOMAIN=${DOMAIN} —— 若本机不是它，改成本机的边界 id。" >&2
    else
      echo "  当前边界 '${DOMAIN}' 来自**默认值**（KARMACHAIN_DOMAIN 未设）。" >&2
      echo "  若本机不是 '${DOMAIN}'，先指定本机的边界：" >&2
      echo "    KARMACHAIN_DOMAIN=<本机边界 id> scripts/devnet-node.sh ${ACTION} ${NODE}" >&2
    fi
    exit 10 ;;
esac

CONTAINER="karmachain-${NODE}"
VOLUME="karmachain-${NODE}-data"

case "$ACTION" in
  kill)
    docker kill "$CONTAINER" >/dev/null
    echo "devnet-node: ${NODE} 已被 SIGKILL 强制终止（未给优雅退出机会）"
    ;;
  stop)
    docker compose -f "$COMPOSE" stop "$NODE" >/dev/null
    echo "devnet-node: ${NODE} 已停止"
    ;;
  start)
    docker compose -f "$COMPOSE" up -d "$NODE" >/dev/null
    echo "devnet-node: ${NODE} 已启动"
    ;;
  restart)
    docker compose -f "$COMPOSE" restart "$NODE" >/dev/null
    echo "devnet-node: ${NODE} 已重启"
    ;;
  status)
    state="$(docker inspect --format '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$CONTAINER" 2>/dev/null || echo -)"
    printf '%-12s %-10s %s\n' "$NODE" "$state" "$health"
    ;;
  wipe)
    docker compose -f "$COMPOSE" stop "$NODE" >/dev/null 2>&1 || true
    docker compose -f "$COMPOSE" rm -f "$NODE" >/dev/null 2>&1 || true
    docker volume rm -f "$VOLUME" >/dev/null
    echo "devnet-node: ${NODE} 的数据卷已删除 —— 'start' 后它会从对等节点重新同步"
    echo "  身份不在数据卷里（只读挂载自仓库），因此 NodeID 不变（研究 R-03）"
    ;;
  *)
    echo "devnet-node: 未知动作 '${ACTION}'" >&2
    exit 10
    ;;
esac
