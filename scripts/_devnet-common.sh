#!/usr/bin/env sh
# scripts/_devnet-common.sh —— devnet-*.sh 的共用部分（功能 002）
#
# 与 _devnet-common.ps1 对应。只放**多个脚本都需要且容易写错**的那几段；
# 各脚本自己的 `set -eu` / `cd` / 读 active.env 保持原样，不做无谓重构。
#
# 本文件是被 `.` source 的库，不是可执行入口 —— 因此保持 644，且不需要同名 .ps1 配对。

# 起一个工具容器（karmachain/verify:local）来访问链时，必须把它接到**节点所在的容器网络**上。
#
# 为什么不能硬编码网络名：单机形态的 local-local.yml 渲染出一个名为 karmachain 的网络，
# 而跨机形态的 lan-*.yml 没有 networks 段 —— 容器落在 compose 的隐式默认网络上，
# 名字由项目名派生（实测为 compose_default），生成器无从预知。
# 2026-09-08 实测：写死 `--network karmachain` 的 devnet-verify 在跨机形态下必然失败。
#
# 也不能走 `docker compose run --rm verify`（根目录 docker-compose.yml 里的工具服务）：
# 那样容器落在**工具项目自己**的默认网络上，接不到节点 —— 逐节点检查会全部不可达。
# 这一点 docker-compose.yml 的注释里已写明，devnet-verify.ps1 此前正是踩了这个。
#
# 真相在 docker 那边，直接问运行中的 RPC 代理容器。这顺带成了前置检查：
# 代理没在跑就说明网络没起来，报"先 devnet-start"比报"网络不存在"有指向性。
#
# 用法：NETWORK="$(devnet_node_network "$DOMAIN")" || exit 10
devnet_node_network() {
  _dnn_container="karmachain-rpc-$1"
  _dnn_net="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}
{{end}}' "$_dnn_container" 2>/dev/null | sed '/^$/d' | head -n 1)"
  if [ -z "$_dnn_net" ]; then
    echo "找不到运行中的 $_dnn_container —— 先运行 scripts/devnet-start" >&2
    echo "  工具容器要接到节点所在的容器网络上（与第三方相同的位置），因此需要网络已启动。" >&2
    # 在**非默认**机器上最常见的成因其实不是"没启动"，而是没设 KARMACHAIN_DOMAIN ——
    # 于是边界回落到默认值，脚本去找一个本机根本不存在的容器。
    # 原先的提示会把人引向"再跑一次 devnet-start"，而那解决不了问题。
    # 2026-09-10 在 win-2 上撞到（默认边界是 win-1）。
    if [ -n "${KARMACHAIN_DOMAIN:-}" ]; then
      echo "  当前边界取自 KARMACHAIN_DOMAIN=$1。若这台机器承载的不是它，请改成本机的边界 id。" >&2
    else
      echo "  当前边界 '$1' 来自默认值（KARMACHAIN_DOMAIN 未设）。" >&2
      echo "  **若本机不是 '$1'**，需要先指定本机的故障边界，例如：" >&2
      echo "    KARMACHAIN_DOMAIN=<本机边界 id> scripts/devnet-dashboard.sh" >&2
    fi
    return 1
  fi
  printf '%s\n' "$_dnn_net"
}

# 工具镜像必须在**本机**存在 —— 它是本地构建的，从不推到任何 registry。
#
# 为什么需要这个检查：`karmachain/verify:local` 不存在时 docker 会去尝试 pull，
# 然后报 `pull access denied for karmachain/verify, repository does not exist or
# may require 'docker login'` —— **那句话指向完全错误的方向**（看起来像权限/登录
# 问题，实际只是本机没建过）。2026-09-10 在 win-2 上撞到。
#
# 这是 002 遗留的缺口，不只影响面板：devnet-verify / devnet-status / devnet-contracts
# 也都直接 `docker run` 它，而**没有任何脚本或部署步骤构建它**——
# 跨机部署文档只写了构建**节点**镜像（docker/compose/<deployment>-<domain>.yml）。
# 于是在任何"没人跑过这几个命令"的机器上，四个命令会一起给出同一句误导性报错。
#
# 用法：devnet_require_verify_image || exit 10
devnet_require_verify_image() {
    if docker image inspect karmachain/verify:local >/dev/null 2>&1; then
        return 0
    fi
    echo "本机没有工具镜像 karmachain/verify:local —— 它是**本地构建**的，不在任何 registry 上。" >&2
    echo "  先建一次（每台机器各建一次，之后改代码无需重建 —— 源码是运行时挂载的）：" >&2
    echo "" >&2
    echo "    docker compose --profile verify build verify" >&2
    echo "" >&2
    echo "  若 docker 报 'pull access denied … may require docker login'，那句话是误导的：" >&2
    echo "  不是权限问题，就是本机还没建过这个镜像。" >&2
    return 1
}

# 工具容器内可用的 RPC 地址：走本边界的 nginx 代理，而不是某个验证者 ——
# 代理是对外的唯一入口，验证与查询都应当从与第三方相同的位置发起。
# 需要 active.env 已 source（用到 KARMACHAIN_RPC_PORT / KARMACHAIN_RPC_PATH）。
devnet_container_rpc_url() {
  printf 'http://karmachain-rpc-%s:%s%s\n' "$1" "${KARMACHAIN_RPC_PORT}" "${KARMACHAIN_RPC_PATH}"
}
