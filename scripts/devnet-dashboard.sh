#!/usr/bin/env sh
# scripts/devnet-dashboard.sh —— 起链状态实时监控面板（功能 003）。
#
# 用法：scripts/devnet-dashboard.sh [--port <n>] [--interval <秒>] [--deployment <name>]
# 退出码：0 正常退出（收到终止信号）| 10 前置条件未满足 | 其他非零 服务自身启动失败
#
# **面板的退出码不表达链的健康状态。** 它是观察者：观察到"链停了"不构成它自己失败 ——
# 那是 /api/snapshot 的内容。混淆两者会让"面板进程活着吗"与"链活着吗"无法分辨。
#
# 与 devnet-status 同一模式：判定交给容器内的工具，宿主只负责采集容器级事实并起容器。
# 容器载体是既有的 karmachain/verify:local —— README 承诺"宿主唯一前置依赖是 Docker"，
# 因此不能要求宿主装 Node（Ubuntu 机器上很可能没有）。研究 R-02。
#
# 面板端口**刻意不在 protocol.json 里**：项目约定"任何字段变更须递增 configVersion"，
# 而 configVersion 在出生证明的六项比对之列 —— 加一个字段就等于七个节点退出码 12
# 拒绝启动、五台机器全链重置。它本非协议参数（链上与跨组件契约都不依赖它），
# 与既有 KARMACHAIN_CONTAINER_RPC_PORT / KARMACHAIN_ADDRESS_OVERRIDE 同类。研究 R-03。
set -eu
cd "$(dirname "$0")/.."

# 21680 的依据（002 研究 R-08 的教训：Hyper-V 会从动态端口范围切走整段端口，
# 节点端口因此从 96xx 迁到 216xx）：win-1 动态范围实测 1024-15000，21680 在其外；
# 15000-29999 区间内的排除项只有两个孤立端口；且与 protocol.json 里的节点端口区段不重叠。
PORT="${KARMACHAIN_DASHBOARD_PORT:-21680}"
# 默认 5 秒（2026-09-10 按使用反馈从 2 改为 5）。上限仍是 6 秒 ——
# 发现时延 ≈ 间隔 + 一轮探测最坏耗时(4s) 必须 ≤ 10 秒（FR-018）。
INTERVAL="${KARMACHAIN_DASHBOARD_INTERVAL:-5}"
DEPLOY=''

while [ $# -gt 0 ]; do
  case "$1" in
    --port)       PORT="${2:?--port 需要一个值}"; shift 2 ;;
    --interval)   INTERVAL="${2:?--interval 需要一个值}"; shift 2 ;;
    --deployment) DEPLOY="${2:?--deployment 需要一个值}"; shift 2 ;;
    -h|--help)
      sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "devnet-dashboard: 未知参数 '$1'" >&2; exit 2 ;;
  esac
done

ENV_FILE="${KARMACHAIN_ENV_FILE:-./docker/compose/active.env}"
[ -f "$ENV_FILE" ] || { echo "devnet-dashboard: $ENV_FILE 不存在 —— 先运行 'npm run node:render'" >&2; exit 10; }
# shellcheck source=../docker/compose/active.env
. "$ENV_FILE"

command -v docker >/dev/null 2>&1 || { echo "devnet-dashboard: docker not found" >&2; exit 10; }

# shellcheck source=./_devnet-common.sh
. "$(dirname "$0")/_devnet-common.sh"
DOMAIN="${KARMACHAIN_DOMAIN:-$KARMACHAIN_DEFAULT_DOMAIN}"

# 网络名由公共件推导，**不能写死** —— 002 在这里踩过两次（devnet-verify 与 devnet-status
# 各中一次）：`--network karmachain` 只是单机形态渲染出的网络，跨机形态必然失败。
# 工具镜像是本地构建的：不存在时 docker 会去 pull 并报一句指向错误方向的
# "pull access denied … may require docker login"。理由见 _devnet-common.sh。
devnet_require_verify_image || { echo "devnet-dashboard: 前置条件未满足（见上）" >&2; exit 10; }

NETWORK="$(devnet_node_network "$DOMAIN")" || { echo "devnet-dashboard: 前置条件未满足（见上）" >&2; exit 10; }

echo "devnet-dashboard: http://localhost:${PORT}  （轮询 ${INTERVAL}s，边界 ${DOMAIN}）"
echo "devnet-dashboard: 对外精简视图 http://localhost:${PORT}/?view=public"
echo "devnet-dashboard: Ctrl-C 停止"

set -- --port "$PORT" --interval "$INTERVAL"
[ -z "$DEPLOY" ] || set -- "$@" --deployment "$DEPLOY"

# `-t` 只在 stdin 确实是终端时才加。**不能无条件写 `-it`**：非交互调用（后台启动、
# CI、`sh script > log 2>&1 &`）下 docker 会直接失败并报
# `cannot attach stdin to a TTY-enabled container because stdin is not a terminal`
# —— 人手工敲命令时看不出这个问题，2026-09-10 的冒烟测试才抓到。
# 不加 `-t` 时 docker CLI 的 sig-proxy 仍会把 Ctrl-C 转成 SIGTERM 送进容器，
# 服务的 shutdown 钩子照常生效。
TTY=''
[ -t 0 ] && TTY='-t'

# -p 让宿主浏览器能连上；--network 让容器能探到节点（单机形态是容器网段，跨机是局域网 IP）。
# MSYS_NO_PATHCONV=1 见 _devnet-common.sh 的说明。
# shellcheck disable=SC2086  # $TTY 为空时必须不产生空参数
# 人工探活要走**对外的 RPC 入口**（本边界的 nginx 代理），而容器内的 127.0.0.1
# 是容器自己 —— 那儿没有代理。因此必须把容器内可用的地址传进去，
# 与既有 devnet-verify / devnet-contracts 同一姿势（那两个脚本早就在传了）。
#
# 2026-09-10 实测漏了这一步的后果：面板起得来、快照正常（探测走的是各节点的
# 局域网地址，不经代理），**唯独点"立即探活"报 `HTTP request failed`** ——
# 而集成测试在宿主上跑，那里回环地址加对外 RPC 端口恰好就是代理容器发布出来的入口，
# 于是测试全绿、真实部署失败。（端口号不写在注释里 —— 它的唯一出处是 protocol.json。）
exec env MSYS_NO_PATHCONV=1 docker run --rm $TTY \
  --network "$NETWORK" \
  -p "${PORT}:${PORT}" \
  -e KARMACHAIN_RPC_URL="$(devnet_container_rpc_url "$DOMAIN")" \
  -v "$(pwd):/workspace" \
  karmachain/verify:local node tools/dashboard/server.mjs "$@"
