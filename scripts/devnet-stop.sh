#!/usr/bin/env sh
# scripts/devnet-stop.sh —— 停止开发网络（功能 002）
#
# **不保存任何东西。** 002 没有快照机制，因为链状态本来就在每个节点自己的数据卷里 ——
# 停止是否优雅，与下次能否启动无关（研究 R-01 / R-06）。
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-stop: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
COMPOSE="./docker/compose/${KARMACHAIN_DEPLOYMENT}-${DOMAIN}.yml"

command -v docker >/dev/null 2>&1 || { echo "devnet-stop: docker not found" >&2; exit 10; }
docker compose -f "$COMPOSE" stop
echo "devnet-stop: 已停止（链状态在各节点卷内；'scripts/devnet-start' 继续，'scripts/devnet-reset' 清空）"
