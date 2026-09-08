#!/usr/bin/env sh
# scripts/devnet-logs.sh —— 按节点查看日志（功能 002 / US6、FR-031）。
#
# 用法：scripts/devnet-logs.sh [<node>] [--chain] [--stdout] [--file <name>] [-f] [-n N] [--raw]
#   <node>        节点 id（见 devnet-topology）；省略则列出可选节点与日志文件
#   --chain       看 L1 链的日志（karmachain.log），默认是节点自身的 main.log
#   --stdout      看容器 stdout（docker logs）—— 入口脚本的启动期校验输出在这里
#   --file <name> 指定 /data/logs/ 下的文件名
#   -f            跟随
#   -n <N>        末尾 N 行（默认 200）
#   --raw         不脱敏
#
# 关于脱敏（FR-026）：001 时 CLI 用 `--staking-tls-key-file-content` 把私钥**内联**成启动标志，
# avalanchego 会把全部标志写进 main.log —— 私钥因此进了日志，脱敏是必需的。
# 002 改为传**文件路径**（研究 R-03），实测 main.log 中该类字段零命中，暴露点从构成上消失。
# 但默认脱敏保留：链配置等将来仍可能带敏感值，且 --raw 让需要时能显式关掉（纵深防御）。
set -eu
cd "$(dirname "$0")/.."

# Git Bash 会把容器内的绝对路径当本地路径转换（/data/logs → C:/Program Files/Git/data/logs），
# 于是 docker exec 全部失败。整脚本导出一次即可；该变量在其他 shell 上是无害的未知变量。
MSYS_NO_PATHCONV=1
export MSYS_NO_PATHCONV

ENV_FILE="${KARMACHAIN_ENV_FILE:-./docker/compose/active.env}"
[ -f "$ENV_FILE" ] || { echo "devnet-logs: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"
command -v docker >/dev/null 2>&1 || { echo "devnet-logs: docker not found" >&2; exit 10; }

NODE=""; FILE=""; FOLLOW=0; LINES=200; RAW=0; STDOUT=0
while [ $# -gt 0 ]; do
  case "$1" in
    -f|--follow) FOLLOW=1 ;;
    --raw) RAW=1 ;;
    --chain) FILE="karmachain.log" ;;
    --stdout) STDOUT=1 ;;
    --file) shift; FILE="${1:-}" ;;
    -n) shift; LINES="${1:-200}" ;;
    -*) echo "devnet-logs: 未知选项 $1" >&2; exit 10 ;;
    *) NODE="$1" ;;
  esac
  shift
done

if [ -z "$NODE" ]; then
  echo "可选节点：${KARMACHAIN_NODE_IDS}"
  echo
  echo "日志文件（以 ${KARMACHAIN_DEFAULT_DOMAIN} 边界上第一个在运行的节点为例）："
  for n in ${KARMACHAIN_NODE_IDS}; do
    if docker exec "karmachain-${n}" ls /data/logs >/dev/null 2>&1; then
      docker exec "karmachain-${n}" ls -1 /data/logs | sed 's/^/  /'
      break
    fi
  done
  echo
  echo "示例：scripts/devnet-logs.sh l1-1 --chain -n 50"
  echo "      scripts/devnet-logs.sh l1-1 --stdout        # 启动期校验的输出在容器 stdout"
  exit 0
fi

C="karmachain-${NODE}"
docker inspect "$C" >/dev/null 2>&1 || {
  echo "devnet-logs: 容器 $C 不存在 —— 本机是否承载该节点？可选：${KARMACHAIN_NODE_IDS}" >&2
  echo "  跨机形态下每台机器只跑本边界的节点，别的节点要到它所在的机器上看" >&2
  exit 10
}

# 脱敏：屏蔽任何 *-content 字段与 signerKeyContent 的值。作用于流，因此对 -f 同样生效。
redact() {
  if [ "$RAW" -eq 1 ]; then cat
  else sed -E 's/("[a-zA-Z-]*[Cc]ontent"[[:space:]]*:[[:space:]]*")[^"]{8,}"/\1<已脱敏>"/g'
  fi
}

if [ "$STDOUT" -eq 1 ]; then
  if [ "$FOLLOW" -eq 1 ]; then docker logs -f --tail "$LINES" "$C" 2>&1 | redact
  else docker logs --tail "$LINES" "$C" 2>&1 | redact; fi
  exit 0
fi

: "${FILE:=main.log}"
if [ "$FOLLOW" -eq 1 ]; then
  docker exec "$C" tail -f -n "$LINES" "/data/logs/${FILE}" 2>&1 | redact
else
  docker exec "$C" tail -n "$LINES" "/data/logs/${FILE}" 2>&1 | redact
fi
