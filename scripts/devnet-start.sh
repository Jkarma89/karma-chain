#!/usr/bin/env sh
# scripts/devnet-start.sh —— 启动 KarmaChain 本地开发网络（薄封装，无业务逻辑；契约见 specs/001-*/contracts/cli-interface.md）
# 退出码：0 就绪 | 10 Docker 不可用 | 11 宿主端口冲突 | 12 链数据与 protocol.json 不一致 | 20 启动失败/超时
set -eu
cd "$(dirname "$0")/.."

TIMEOUT="${KARMACHAIN_STARTUP_TIMEOUT:-300}"
READY_MARK="KarmaChain local devnet is READY"

command -v docker >/dev/null 2>&1 || { echo "devnet-start: docker not found — install Docker Desktop (Windows: WSL2 backend) or Docker Engine + Compose v2" >&2; exit 10; }
docker info >/dev/null 2>&1 || { echo "devnet-start: Docker daemon is not running" >&2; exit 10; }
docker compose version >/dev/null 2>&1 || { echo "devnet-start: 'docker compose' (v2) not available" >&2; exit 10; }

# 只看本次启动之后的日志（容器重启后 `compose logs` 仍含上一轮的 READY 标记）
since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
logs() { docker compose logs --no-log-prefix --since "$since" devnet 2>/dev/null; }

# 启动容器；宿主端口被占用时 compose 在绑定阶段失败
if ! out="$(docker compose up -d devnet 2>&1)"; then
  echo "$out" >&2
  if echo "$out" | grep -qiE "port is already allocated|address already in use|bind: "; then
    echo "devnet-start: FAILED [category: configuration] host port ${KARMACHAIN_RPC_PORT:-8545} is already in use — stop the other process or set KARMACHAIN_RPC_PORT in .env" >&2
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
