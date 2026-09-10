# scripts/devnet-dashboard.ps1 —— 起链状态实时监控面板（功能 003）。
# 与 scripts/devnet-dashboard.sh 等价。
#
# 用法：scripts\devnet-dashboard.ps1 [--port <n>] [--interval <秒>] [--deployment <name>]
# 退出码：0 正常退出 | 10 前置条件未满足 | 其他非零 服务自身启动失败
#
# **面板的退出码不表达链的健康状态。** 它是观察者：观察到"链停了"不构成它自己失败。
#
# 面板端口刻意不在 protocol.json 里 —— 加字段须递增 configVersion，而它在出生证明的
# 六项比对之列，代价是五台机器全链重置。理由见 devnet-dashboard.sh 的同段注释与研究 R-03。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')

# 21680 的依据见 devnet-dashboard.sh：在 Windows 动态端口范围（实测 1024-15000）与
# 排除区间之外，且与 protocol.json 里的节点端口区段不重叠。
$port     = if ($env:KARMACHAIN_DASHBOARD_PORT)     { $env:KARMACHAIN_DASHBOARD_PORT }     else { '21680' }
# 默认 5 秒（2026-09-10 从 2 改为 5）。上限仍是 6 —— 理由见 .sh 的同段注释。
$interval = if ($env:KARMACHAIN_DASHBOARD_INTERVAL) { $env:KARMACHAIN_DASHBOARD_INTERVAL } else { '5' }
$deploy   = ''

for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        '--port'       { $port     = $args[++$i] }
        '--interval'   { $interval = $args[++$i] }
        '--deployment' { $deploy   = $args[++$i] }
        '-h'           { Get-Content $PSCommandPath | Select-Object -Skip 1 -First 5 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
        '--help'       { Get-Content $PSCommandPath | Select-Object -Skip 1 -First 5 | ForEach-Object { $_ -replace '^# ?', '' }; exit 0 }
        default        { Write-Host "devnet-dashboard: 未知参数 '$($args[$i])'"; exit 2 }
    }
}

$ctx = Get-DevnetContext; Assert-Docker

# 网络名由公共件推导，**不能写死** —— 002 在这里踩过两次（devnet-verify 与 devnet-status
# 各中一次）：`--network karmachain` 只是单机形态渲染出的网络，跨机形态必然失败。
# 工具镜像是本地构建的：不存在时 docker 报的那句 pull access denied 指向错误方向。
if (-not (Assert-VerifyImage)) { Write-Host 'devnet-dashboard: 前置条件未满足（见上）'; exit 10 }

$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-dashboard: 前置条件未满足（见上）'; exit 10 }

Write-Host "devnet-dashboard: http://localhost:$port  （轮询 ${interval}s，边界 $($ctx.Domain)）"
Write-Host "devnet-dashboard: 对外精简视图 http://localhost:$port/?view=public"
Write-Host 'devnet-dashboard: Ctrl-C 停止'

$serverArgs = @('--port', $port, '--interval', $interval)
if ($deploy) { $serverArgs += @('--deployment', $deploy) }

# 参数**整体构造成一个数组再一次性 splat**，不在命令行里内联条件 splat。
#
# 原先写的是 `docker run --rm @tty ... `（$tty 为空数组时展开成"什么都没有"），
# 实测在原生命令调用里它反而塞进了一个**空参数**，docker 把那个空串当成镜像名，
# 于是报 `docker: invalid reference format`。2026-09-10 冒烟测试抓到 ——
# 这个错在 .sh 那边不存在（sh 的 $TTY 为空时不产生参数），所以两版必须分别验。
#
# `-t` 只在 stdin 确实是终端时才加：非交互调用下 docker 会报
# `cannot attach stdin to a TTY-enabled container because stdin is not a terminal`。
# 不加 -t 时 docker CLI 的 sig-proxy 仍会把 Ctrl-C 转成 SIGTERM 送进容器。
$dockerArgs = @('run', '--rm')
if (-not [Console]::IsInputRedirected) { $dockerArgs += '-t' }
# -p 让宿主浏览器能连上；--network 让容器能探到节点（单机形态是容器网段，跨机是局域网 IP）
# 人工探活要走**对外的 RPC 入口**（本边界的 nginx 代理），而容器内的 127.0.0.1
# 是容器自己 —— 那儿没有代理。必须把容器内可用的地址传进去，
# 与既有 devnet-verify.ps1 / devnet-contracts.ps1 同一姿势。理由见 .sh 的同段注释。
$dockerArgs += @(
    '--network', $network,
    '-p', "${port}:${port}",
    '-e', "KARMACHAIN_RPC_URL=$(Get-ContainerRpcUrl $ctx)",
    '-v', "$($ctx.Root):/workspace",
    'karmachain/verify:local',
    'node', 'tools/dashboard/server.mjs'
) + $serverArgs

docker @dockerArgs
exit $LASTEXITCODE
