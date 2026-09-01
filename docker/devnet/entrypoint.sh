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

# ---------------------------------------------------------------------------
# 优雅停止：保存快照（FR-003/FR-005），确保不留残余进程
# ---------------------------------------------------------------------------
STOPPING=0
TERM_REQUESTED=0
on_terminate() {
  [ "${STOPPING}" = "1" ] && return
  STOPPING=1
  echo
  log "stopping: saving snapshot and shutting down all nodes ..."
  rt_stop_proxy
  if av_network_is_running; then
    if av_network_stop >/dev/null 2>&1; then
      log "snapshot saved."
    else
      log "WARNING [category: node] 'avalanche network stop' returned an error; killing remaining node processes (next start may need scripts/devnet-reset)"
    fi
  fi
  pkill -x avalanchego 2>/dev/null || true
  pkill -f signature-aggregator 2>/dev/null || true
  log "stopped."
  exit 0
}
# 启动阶段收到 SIGTERM：只记录，等 run 完整结束后再有序停止。
# 否则信号会打断正在执行的命令替换 / CLI 调用，`avalanche network stop` 来不及保存快照，
# 下次恢复时只剩主网节点、L1 节点丢失（T026 实测）。compose 的 stop_grace_period 需覆盖最长启动时间。
request_terminate() {
  TERM_REQUESTED=1
  log "termination requested during startup — will shut down cleanly as soon as startup completes"
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
      rt_wait_for_rpc || exit ${EXIT_START_FAILED}
      rt_write_stamp                                     # T023：链数据的出生证明
      ;;
    partial)
      log "previous start left an incomplete deployment; retrying create + deploy ..."
      av_network_start || { log "FAILED [category: node] 'avalanche network start' failed"; exit ${EXIT_START_FAILED}; }
      first_boot "${name}"
      rt_wait_for_rpc || exit ${EXIT_START_FAILED}
      rt_write_stamp
      ;;
    deployed)
      rt_check_stamp || exit $?                          # FR-021：参数变了必须先 reset（退出 12）
      log "restoring existing devnet from snapshot (chain state is preserved, FR-005) ..."
      av_network_start || { log "FAILED [category: node] 'avalanche network start' (snapshot restore) failed"; exit ${EXIT_START_FAILED}; }
      if ! rt_wait_for_rpc; then
        log "FAILED [category: node] the L1 validators did not come back after restore — the snapshot is probably incomplete (container was killed before 'avalanche network stop' finished). Run scripts/devnet-reset and start again."
        exit ${EXIT_START_FAILED}
      fi
      rt_check_runtime_genesis_hash || exit $?           # T025：恢复后的链必须是同一条链
      ;;
  esac

  # 3) 就绪：起代理 → 摘要
  rt_start_proxy || exit ${EXIT_START_FAILED}
  rt_print_ready_summary
}

case "${1:-run}" in
  run)
    trap request_terminate SIGTERM SIGINT          # 启动期：延迟处理
    run
    if [ "${TERM_REQUESTED}" = "1" ]; then on_terminate; fi
    trap on_terminate SIGTERM SIGINT               # 运行期：立即有序停止
    log "supervising (SIGTERM → snapshot + clean shutdown). Logs: scripts/devnet-logs"
    # 前台守护：保持 PID 1 存活；节点进程由 tmpnet 管理
    while :; do sleep 3600 & wait $! || true; done
    ;;
  *)
    ensure_cached_binaries
    exec "$@"
    ;;
esac
