#!/usr/bin/env sh
# scripts/devnet-start.sh —— 启动 KarmaChain 本地开发网络（薄封装，无业务逻辑；契约见 specs/001-*/contracts/cli-interface.md）
# 退出码：0 就绪 | 10 Docker 不可用 | 11 宿主端口冲突 | 12 链数据与 protocol.json 不一致 | 20 启动失败/超时
set -eu
cd "$(dirname "$0")/.."

# 默认值优先级：shell 环境 > .env（用户覆盖） > blockchain/compose.env（由 protocol.json 生成）。
# 仅在变量尚未设置时赋值，因此不会覆盖用户在 shell 或 .env 中的显式设置。
load_env_defaults() {
  [ -f "$1" ] || return 0
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    eval "current=\${$k:-}"
    if [ -z "$current" ]; then eval "$k=\$v"; export "$k"; fi
  done < "$1"
}
load_env_defaults ./.env
load_env_defaults ./blockchain/compose.env
: "${KARMACHAIN_RPC_PORT:?blockchain/compose.env missing or incomplete — run 'npm run protocol:render'}"
TIMEOUT="${KARMACHAIN_STARTUP_TIMEOUT}"
READY_MARK="KarmaChain local devnet is READY"

command -v docker >/dev/null 2>&1 || { echo "devnet-start: docker not found — install Docker Desktop (Windows: WSL2 backend) or Docker Engine + Compose v2" >&2; exit 10; }
docker info >/dev/null 2>&1 || { echo "devnet-start: Docker daemon is not running" >&2; exit 10; }
docker compose version >/dev/null 2>&1 || { echo "devnet-start: 'docker compose' (v2) not available" >&2; exit 10; }

# 幂等快路径：容器已在运行且 RPC 已应答时，`docker compose up -d` 是空操作，entrypoint 不会再打印
# READY 标记，若直接进入等待循环就会一直等到超时。此时回放上一次的摘要并退出 0（FR-006）。
rpc_answers() {
  port="${KARMACHAIN_RPC_PORT}"
  path="$(sed -n 's/.*"rpcPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ./blockchain/protocol.json | head -1)"
  [ -n "$path" ] || path=/
  curl -s -m 5 -o /dev/null -X POST -H 'content-type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
    "http://127.0.0.1:${port}${path}" 2>/dev/null
}
if [ "$(docker inspect --format '{{.State.Status}}' karmachain-devnet 2>/dev/null || echo missing)" = "running" ] && rpc_answers; then
  all_logs="$(docker compose logs --no-log-prefix devnet 2>/dev/null)"
  echo "$all_logs" | sed -n "/$READY_MARK/,\$p" | tail -30
  echo "devnet-start: already running and answering RPC — nothing to do (summary above is from the last start)"
  exit 0
fi

# 只看本次启动之后的日志（容器重启后 `compose logs` 仍含上一轮的 READY 标记）
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
logs() { docker compose logs --no-log-prefix --since "$since" devnet 2>/dev/null; }

# 启动容器；宿主端口被占用时 compose 在绑定阶段失败
if ! out="$(docker compose up -d devnet 2>&1)"; then
  echo "$out" >&2
  if echo "$out" | grep -qiE "port is already allocated|address already in use|bind: "; then
    echo "devnet-start: FAILED [category: configuration] host port ${KARMACHAIN_RPC_PORT} is already in use — stop the other process or set KARMACHAIN_RPC_PORT in .env" >&2
    exit 11
  fi
  echo "devnet-start: FAILED [category: node] docker compose up failed" >&2
  exit 20
fi

# 等待 READY 标记或容器退出
start=$(date +%s)
while :; do
  if logs | grep -q "$READY_MARK"; then
    logs | sed -n "/$READY_MARK/,\$p"
    exit 0
  fi
  state="$(docker inspect --format '{{.State.Status}}' karmachain-devnet 2>/dev/null || echo missing)"
  if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
    code="$(docker inspect --format '{{.State.ExitCode}}' karmachain-devnet 2>/dev/null || echo 20)"
    logs | tail -30 >&2
    echo "devnet-start: container exited with code $code (see scripts/devnet-logs)" >&2
    case "$code" in 10|11|12|20) exit "$code" ;; *) exit 20 ;; esac
  fi
  if [ $(( $(date +%s) - start )) -ge "$TIMEOUT" ]; then
    logs | tail -30 >&2
    echo "devnet-start: FAILED [category: node] not READY within ${TIMEOUT}s (KARMACHAIN_STARTUP_TIMEOUT)" >&2
    exit 20
  fi
  sleep 2
done
