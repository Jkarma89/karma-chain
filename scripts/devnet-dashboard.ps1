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
# 排除区间之外，且与节点占用的 21650-21669 不重叠。
$port     = if ($env:KARMACHAIN_DASHBOARD_PORT)     { $env:KARMACHAIN_DASHBOARD_PORT }     else { '21680' }
$interval = if ($env:KARMACHAIN_DASHBOARD_INTERVAL) { $env:KARMACHAIN_DASHBOARD_INTERVAL } else { '2' }
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
$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-dashboard: 前置条件未满足（见上）'; exit 10 }

Write-Host "devnet-dashboard: http://localhost:$port  （轮询 ${interval}s，边界 $($ctx.Domain)）"
Write-Host "devnet-dashboard: 对外精简视图 http://localhost:$port/?view=public"
Write-Host 'devnet-dashboard: Ctrl-C 停止'

$serverArgs = @('--port', $port, '--interval', $interval)
if ($deploy) { $serverArgs += @('--deployment', $deploy) }

# -p 让宿主浏览器能连上；--network 让容器能探到节点（单机形态是容器网段，跨机是局域网 IP）
docker run --rm -it `
  --network $network `
  -p "${port}:${port}" `
  -v "$($ctx.Root):/workspace" `
  karmachain/verify:local node tools/dashboard/server.mjs @serverArgs
exit $LASTEXITCODE
