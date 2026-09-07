# scripts/devnet-start.ps1 —— 启动 KarmaChain 开发网络（功能 002）
# 与 scripts/devnet-start.sh 等价。没有"恢复快照"路径：节点各自从数据卷恢复（研究 R-01）。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

$identity = Join-Path $ctx.Root 'blockchain/chain-identity/karmachain.identity.json'
if (-not (Test-Path $identity)) {
    Write-Error "链尚未建立 —— 先运行 scripts/devnet-bootstrap.ps1"; exit 10
}

# 跨机形态：本机必须真的是拓扑说的那台机器（V-07 / FR-023）。
# 与 devnet-start.sh 同一判据 —— 容器在 NAT 后看不到宿主地址，配错时节点照常启动、
# 日志无异常，症状只表现为对等节点连不上它。单边界形态跳过（地址是 127.0.0.1）。
if ([int]$ctx.KARMACHAIN_DOMAIN_COUNT -gt 1) {
    $want = ($ctx.KARMACHAIN_DOMAIN_ADDRESSES -split ' ' |
        Where-Object { $_ -like "$($ctx.Domain)=*" } |
        ForEach-Object { $_.Split('=', 2)[1] } | Select-Object -First 1)
    $mine = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' } | ForEach-Object IPAddress)
    if ($want -and ($mine -notcontains $want)) {
        Write-Host "devnet-start: FAILED [category: configuration] 本机不是故障边界 '$($ctx.Domain)' 声明的那台机器" -ForegroundColor Red
        Write-Host "  拓扑声明 $($ctx.Domain) 的地址为 $want，但本机的 IPv4 地址是："
        $mine | ForEach-Object { Write-Host "    $_" }
        Write-Host "  节点会把 $want 通告给对等节点，而那不是本机地址 —— 对等节点将连不上它，"
        Write-Host '  且节点自身日志不会报错（容器在 NAT 后，看不到宿主地址）。'
        Write-Host '  三种修正方式，择一：'
        Write-Host '    1. 本机要跑的其实是别的边界 → $env:KARMACHAIN_DOMAIN=''<本机对应的边界 id>''; scripts/devnet-start.ps1'
        Write-Host "       可选边界与地址：$($ctx.KARMACHAIN_DOMAIN_ADDRESSES)"
        Write-Host "    2. 这台机器的地址变了 → `$env:KARMACHAIN_ADDRESS_OVERRIDE='$($ctx.Domain)=<新地址>'; npm run node:render"
        Write-Host '    3. 地址应长期改变 → 改 blockchain/protocol.json 的 topology.deployments 后重新渲染'
        exit 13
    }
}

if ((Get-ChainId $ctx.Rpc) -eq $ctx.KARMACHAIN_CHAIN_ID_HEX) {
    Write-Host 'devnet-start: 已在运行并正常应答 —— 无需操作'; exit 0
}

docker compose -f $ctx.Compose up -d
if ($LASTEXITCODE -ne 0) { Write-Error 'docker compose up 失败'; exit 20 }

$timeout = if ($env:KARMACHAIN_STARTUP_TIMEOUT) { [int]$env:KARMACHAIN_STARTUP_TIMEOUT } else { 300 }
$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
    if ((Get-ChainId $ctx.Rpc) -eq $ctx.KARMACHAIN_CHAIN_ID_HEX) {
        $h = try {
            $b = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
            (Invoke-RestMethod -Uri $ctx.Rpc -Method Post -ContentType 'application/json' -Body $b -TimeoutSec 5).result
        } catch { '?' }
        Write-Host ''
        Write-Host "KarmaChain is READY   (deployment $($ctx.KARMACHAIN_DEPLOYMENT), failure domain $($ctx.Domain), $([int]$sw.Elapsed.TotalSeconds)s)"
        Write-Host ''
        Write-Host "  RPC URL   : $($ctx.Rpc)"
        Write-Host "  Chain ID  : $($ctx.KARMACHAIN_CHAIN_ID_HEX)"
        Write-Host "  Height    : $h"
        Write-Host "  Nodes     : $($ctx.KARMACHAIN_NODE_IDS)"
        Write-Host "  容错      : $($ctx.KARMACHAIN_MAX_OFFLINE_VALIDATORS) 个验证者可离线"
        Write-Host ''
        Write-Host '  Next: scripts/devnet-status.ps1  |  scripts/devnet-stop.ps1'
        exit 0
    }
    foreach ($n in $ctx.KARMACHAIN_NODE_IDS.Split(' ')) {
        $state = docker inspect --format '{{.State.Status}}' "karmachain-$n" 2>$null
        if ($state -eq 'exited') {
            $code = [int](docker inspect --format '{{.State.ExitCode}}' "karmachain-$n" 2>$null)
            if ($code -in 10, 12) {
                docker logs "karmachain-$n" 2>&1 | Select-String 'karmachain-node' | Select-Object -Last 8
                Write-Error "节点 $n 以退出码 $code 结束"; exit $code
            }
        }
    }
    if ($sw.Elapsed.TotalSeconds -ge $timeout) {
        docker compose -f $ctx.Compose ps
        Write-Error "${timeout}s 内未就绪"; exit 20
    }
    Start-Sleep -Seconds 3
}
