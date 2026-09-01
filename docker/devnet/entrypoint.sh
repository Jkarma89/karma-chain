#!/usr/bin/env bash
# KarmaChain devnet 容器入口（T008 骨架；启动状态机在 T018/T019/T023/T025 补全）
#
#   entrypoint.sh run          → 启动/恢复开发网络并前台守护（compose 默认 CMD）
#   entrypoint.sh <任意命令>    → 先准备环境（软链二进制），再执行该命令（供冒烟脚本 / 排障使用）
set -euo pipefail

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
# shellcheck source=lib/binaries.sh
source "${KARMACHAIN_LIB}/binaries.sh"

ensure_cached_binaries

case "${1:-run}" in
  run)
    echo "[entrypoint] devnet start/run path is not implemented yet (T018)." >&2
    echo "[entrypoint] use: docker compose run --rm devnet bash   or   ... devnet /opt/karmachain/spike/bringup-test-defaults.sh" >&2
    exit 64
    ;;
  *)
    exec "$@"
    ;;
esac
