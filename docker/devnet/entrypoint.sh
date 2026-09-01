#!/usr/bin/env bash
# KarmaChain devnet 容器入口 —— 启动状态机（tasks T018/T019；T023/T025 在阶段 4 补 stamp 与恢复校验）
#
#   entrypoint.sh run          → 启动/恢复开发网络，打印 READY 摘要，前台守护；SIGTERM → 保存快照后退出（compose 默认 CMD）
#   entrypoint.sh <命令...>     → 准备环境后执行任意命令（排障 / 冒烟脚本）
#
# 退出码（contracts/cli-interface.md）：0 就绪 | 10 依赖缺失 | 11 端口冲突 | 12 链数据与 protocol.json 不一致 | 20 启动失败/超时
set -euo pipefail

: "${KARMACHAIN_LIB:=/opt/karmachain/lib}"
source "${KARMACHAIN_LIB}/runtime.sh"     # 亦引入 avalanche.sh / protocol.sh / binaries.sh
source "${KARMACHAIN_LIB}/preflight.sh"

EXIT_START_FAILED=20
GENESIS_FILE="/workspace/blockchain/genesis/karmachain.genesis.json"

# ---------------------------------------------------------------------------
# 优雅停止：保存快照（FR-003/FR-005），确保不留残余进程
# ---------------------------------------------------------------------------
STOPPING=0
on_terminate() {
  [ "${STOPPING}" = "1" ] && return
  STOPPING=1
  echo
  log "stopping: saving snapshot and shutting down all nodes ..."
  rt_stop_proxy
  if av_network_is_running; then
    av_network_stop >/dev/null 2>&1 || log "WARNING: 'avalanche network stop' returned an error; killing remaining node processes"
  fi
  pkill -x avalanchego 2>/dev/null || true
  pkill -f signature-aggregator 2>/dev/null || true
  log "stopped."
  exit 0
}

first_boot() {
  local name="$1"
  log "first start: creating blockchain '${name}' from ${GENESIS_FILE} ..."
  av_blockchain_create "${name}" "${GENESIS_FILE}" \
    || { log "FAILED [category: genesis] 'avalanche blockchain create' rejected the genesis or configuration"; exit ${EXIT_START_FAILED}; }
  log "deploying L1 with $(proto_validator_count) local validators (fixed dev keys) ..."
  AV_STAKING_KEYS=1 av_blockchain_deploy_local "${name}" \
    || { log "FAILED [category: validator] 'avalanche blockchain deploy --local' failed"; exit ${EXIT_START_FAILED}; }
}

run() {
  local name; name="$(proto_blockchain_name)"

  # 1) 幂等：网络已在运行（同一容器内重复调用）→ 只报告，不再起第二套（FR-006 / T019）
  if av_network_is_running; then
    preflight_all --skip-ports
    log "devnet is already running — nothing to do (FR-006)"
    rt_start_proxy || exit ${EXIT_START_FAILED}
    rt_print_ready_summary
    return
  fi

  preflight_all

  # 2) 按卷内状态选择路径（data-model §7）
  local state; state="$(rt_chain_state)"
  case "${state}" in
    absent)
      log "starting local primary network ($(proto_primary_nodes) nodes, avalanchego $(proto_avalanchego_ver)) ..."
      av_network_start || { log "FAILED [category: node] 'avalanche network start' failed"; exit ${EXIT_START_FAILED}; }
      first_boot "${name}"
      ;;
    partial)
      log "previous start left an incomplete deployment; retrying create + deploy ..."
      av_network_start || { log "FAILED [category: node] 'avalanche network start' failed"; exit ${EXIT_START_FAILED}; }
      first_boot "${name}"
      ;;
    deployed)
      log "restoring existing devnet from snapshot (chain state is preserved, FR-005) ..."
      av_network_start || { log "FAILED [category: node] 'avalanche network start' (snapshot restore) failed"; exit ${EXIT_START_FAILED}; }
      ;;
  esac

  # 3) 就绪：别名 RPC 上 chainId 正确 → 起代理 → 摘要
  rt_wait_for_rpc || exit ${EXIT_START_FAILED}
  rt_start_proxy || exit ${EXIT_START_FAILED}
  rt_print_ready_summary
}

case "${1:-run}" in
  run)
    trap on_terminate SIGTERM SIGINT
    run
    log "supervising (SIGTERM → snapshot + clean shutdown). Logs: scripts/devnet-logs"
    # 前台守护：保持 PID 1 存活；节点进程由 tmpnet 管理
    while :; do sleep 3600 & wait $! || true; done
    ;;
  *)
    ensure_cached_binaries
    exec "$@"
    ;;
esac
