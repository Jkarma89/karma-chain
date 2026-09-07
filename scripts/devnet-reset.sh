#!/usr/bin/env sh
# scripts/devnet-reset.sh —— 从创世重建（功能 002）
#
# 语义已降级：它**不再是崩溃后的出路**（崩溃自愈由节点自身完成，见 scripts/devnet-start），
# 而是开发者显式要求"丢掉现有链、从头再来"时才用（FR-005）。
#
# 删卷之后链身份也就没了，必须重新 bootstrap —— 因为 Subnet 与 Blockchain 是 P 链上的交易，
# 只存在于节点数据库里（研究 R-04）。
set -eu
cd "$(dirname "$0")/.."

ENV_FILE=./docker/compose/active.env
[ -f "$ENV_FILE" ] || { echo "devnet-reset: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"
COMPOSE="./docker/compose/${KARMACHAIN_DEPLOYMENT}-${DOMAIN}.yml"

command -v docker >/dev/null 2>&1 || { echo "devnet-reset: docker not found" >&2; exit 10; }
docker compose -f "$COMPOSE" down -v --remove-orphans
echo "devnet-reset: 全部节点卷已删除。"
echo "  下一步：scripts/devnet-bootstrap  然后  scripts/devnet-start"
