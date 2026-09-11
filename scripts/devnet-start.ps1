# scripts/devnet-start.ps1 —— 启动 KarmaChain 开发网络（功能 002）
# 与 scripts/devnet-start.sh 等价。没有"恢复快照"路径：节点各自从数据卷恢复（研究 R-01）。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

$identity = Join-Path $ctx.Root 'blockchain/chain-identity/karmachain.identity.json'
# --- 配置格式检查（功能 005 / T020 / FR-008）---------------------------------
# 与 devnet-start.sh 等价。五台机器靠 git pull 同步，而 pull 会失败、会被跳过、
# 会停在旧提交上。「这台机器还在读旧格式」有两种样子，两种都要指名道姓报出来。
if (-not (Test-Path './blockchain/deployment.json')) {
    Write-Error 'blockchain/deployment.json 不存在 —— 这台机器还在读旧格式。功能 005 把部署描述从 protocol.json 切了出来；本机的仓库停在分家之前。修法：git pull（生成物已提交，本机不需要 node/npm）'
    exit 10
}
if (Select-String -Path './blockchain/protocol.json' -Pattern '"topology"' -Quiet) {
    Write-Error 'blockchain/protocol.json 里仍有 topology —— 半新半旧。两个文件都在，但协议参数文件是分家前的版本；取值会从哪一份来取决于读取路径，而两份可以不一致。修法：git status 看是否有本地改动挡住了 pull'
    exit 10
}

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

# 挂载新鲜度：容器里看到的配置文件，与宿主上的那份是否还是同一内容。
# 与 devnet-start.sh 的 warn_stale_mounts 等价，理由见那里的长注释。要点：
# Docker 对**单文件** bind mount 绑的是 inode，而 git pull／重新渲染是原子替换（rename），
# 于是容器仍指向旧 inode —— restart 与 up -d 都无效，只有重建容器才重新解析挂载。
#
# **这个坑只在 Linux 宿主上存在。** Docker Desktop（本脚本的运行环境）按**路径**解析，
# 替换立刻可见，因此这段在 Windows 上几乎永远不会报警。保留它有两个理由：
#   1. 契约要求 .ps1 与 .sh 等价，行为不该按平台分叉；
#   2. Docker Desktop 的文件共享后端换过好几次实现，不该假定它永远按路径解析。
# 也正因为 Windows 上不存在该 bug，这段**无法在 win-1 上反向验证** —— 改宿主文件时
# 容器里那份会同步变化，两个哈希一起动，测不出不一致。它的验证只能在 Linux 宿主上做。
function Warn-StaleMounts($ctx) {
    # 归并成"哪些节点 × 哪些文件"，而不是逐条列出笛卡尔积 —— 单机形态下 7 个节点全在本机，
    # 逐条会打出 28 行，而 protocol/genesis/identity 是所有节点共用的，逐节点重复没有信息量。
    # 与 devnet-start.sh 的输出形状保持一致。
    $staleNodes = [System.Collections.Generic.List[string]]::new()
    $staleFiles = [System.Collections.Generic.List[string]]::new()
    $staleRpc = $false
    $checks = @(
        @{ Host = 'blockchain/protocol.json';                          Inside = '/config/protocol.json' },
        @{ Host = 'blockchain/genesis/karmachain.genesis.json';        Inside = '/config/karmachain.genesis.json' },
        @{ Host = 'blockchain/chain-identity/karmachain.identity.json'; Inside = '/config/karmachain.identity.json' }
    )
    foreach ($n in $ctx.KARMACHAIN_NODE_IDS.Split(' ')) {
        $c = "karmachain-$n"
        if ((Invoke-Quiet { docker inspect --format '{{.State.Status}}' $c }) -ne 'running') { continue }
        $perNode = $checks + @{
            Host   = "blockchain/nodes/$($ctx.KARMACHAIN_DEPLOYMENT)/$n.flags.json"
            Inside = '/config/flags.json'
        }
        foreach ($chk in $perNode) {
            $hostPath = Join-Path $ctx.Root $chk.Host
            if (-not (Test-Path $hostPath)) { continue }
            $hh = (Get-FileHash -Algorithm MD5 -Path $hostPath).Hash.ToLower()
            $out = Invoke-Quiet { docker exec $c md5sum $chk.Inside }
            if (-not $out) { continue }            # 取不到就跳过，少一路证据不误报
            $ch = ($out -join ' ').Trim().Split(' ')[0].ToLower()
            if ($hh -ne $ch) {
                if ($staleNodes -notcontains $n) { $staleNodes.Add($n) }
                if ($staleFiles -notcontains $chk.Inside) { $staleFiles.Add($chk.Inside) }
            }
        }
    }
    $rpcC = "karmachain-rpc-$($ctx.Domain)"
    $rpcH = Join-Path $ctx.Root "blockchain/nodes/$($ctx.KARMACHAIN_DEPLOYMENT)/rpc-proxy.conf"
    if ((Invoke-Quiet { docker inspect --format '{{.State.Status}}' $rpcC }) -eq 'running' -and (Test-Path $rpcH)) {
        $hh = (Get-FileHash -Algorithm MD5 -Path $rpcH).Hash.ToLower()
        $out = Invoke-Quiet { docker exec $rpcC md5sum /etc/nginx/conf.d/karmachain.conf }
        if ($out) {
            $ch = ($out -join ' ').Trim().Split(' ')[0].ToLower()
            if ($hh -ne $ch) { $staleRpc = $true }
        }
    }
    if ($staleNodes.Count -eq 0 -and -not $staleRpc) { return }

    Write-Host ''
    Write-Host 'devnet-start: 警告 —— 容器内的配置文件与宿主上的**不是同一份**：' -ForegroundColor Yellow
    if ($staleNodes.Count -gt 0) {
        Write-Host "    节点：$($staleNodes -join ' ')"
        Write-Host "    文件：$($staleFiles -join ' ')"
    }
    if ($staleRpc) { Write-Host '    rpc: /etc/nginx/conf.d/karmachain.conf' }
    Write-Host ''
    Write-Host '  成因：Docker 对单文件 bind mount 绑的是 inode，而 git pull／重新渲染是原子替换'
    Write-Host '  （写临时文件 + rename），inode 变了，容器仍指向旧的那个。restart 与 up -d 都无效。'
    Write-Host ''
    # 后果按类别说 —— 两者严重程度差得远，混成一句话会让人对真正严重的那种脱敏。
    if ($staleNodes.Count -gt 0) {
        Write-Host '  节点配置陈旧的后果：节点正带着**旧参数**在跑。这是宪法第十五条要防的「半新半旧」，'
        Write-Host '  而出生证明守卫比的是卷里的 stamp 与容器内的 protocol.json —— 两边都旧时它看不出来。'
        Write-Host "  修法：docker compose -f $($ctx.Compose) up -d --force-recreate"
    }
    if ($staleRpc) {
        Write-Host '  代理配置陈旧的后果：只影响本机的 RPC 入口行为（超时、故障转移这些），不影响节点与共识。'
        Write-Host "  修法：docker compose -f $($ctx.Compose) up -d --force-recreate rpc"
    }
    Write-Host ''
}

# 必须在幂等分支**之前** —— 否则"已在运行"时直接 exit 0，而那恰好是最需要提醒的情形：
# git pull 之后跑一次 devnet-start，它说"无需操作"，你就以为新配置生效了。
Warn-StaleMounts $ctx

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
        $state = Invoke-Quiet { docker inspect --format '{{.State.Status}}' "karmachain-$n" }
        if ($state -eq 'exited') {
            $code = [int](Invoke-Quiet { docker inspect --format '{{.State.ExitCode}}' "karmachain-$n" })
            if ($code -in 10, 12) {
                # 取末尾即可：判据是"最近一次启动为何失败"。不加 --tail 会读整个日志，
                # 而节点反复重启后那可能很大（测试侧同类问题见 1c73d3b）。
                docker logs --tail 2000 "karmachain-$n" 2>&1 | Select-String 'karmachain-node' | Select-Object -Last 8
                Write-Error "节点 $n 以退出码 $code 结束"; exit $code
            }
        }
    }
    if ($sw.Elapsed.TotalSeconds -ge $timeout) {
        docker compose -f $ctx.Compose ps
        Write-Host "devnet-start: FAILED [category: node] ${timeout}s 内未就绪（KARMACHAIN_STARTUP_TIMEOUT）" -ForegroundColor Red

        # "未就绪"本身不指向任何原因。转达**本机节点自己的判断** —— healthcheck --state
        # 已经能区分"等其余边界"与"本机卡住"，在这里重算一遍就是第二份逻辑。
        foreach ($n in $ctx.KARMACHAIN_NODE_IDS.Split(' ')) {
            $c = "karmachain-$n"
            if ((Invoke-Quiet { docker inspect --format '{{.State.Status}}' $c }) -ne 'running') { continue }
            # 刻意**不**在容器里嵌一段 jq 程序：PowerShell 传原生参数时会重写嵌套引号
            # （PS 5.1 尤其不可靠），实测那样这几行会静默不打印。PowerShell 自带
            # ConvertFrom-Json，在宿主侧解析更简单也更稳。
            $raw = Invoke-Quiet { docker exec $c /opt/karmachain/healthcheck.sh --state }
            if (-not $raw) { continue }
            try {
                $st = ($raw -join "`n") | ConvertFrom-Json
                Write-Host "  ${n}: $($st.state) — $($st.detail)"
            } catch {
                # --state 输出不是合法 JSON —— 转达失败不该让本已失败的启动更难看
            }
        }

        # 跨机分批启动时**先起来的机器必然超时**，这不是故障。2026-09-08 首次跨机部署时
        # 前 3 台都撞了这一下，而当时只有一句"300s 内未就绪"，毫无指向性。
        if ([int]$ctx.KARMACHAIN_DOMAIN_COUNT -gt 1) {
            $nVal = @($ctx.KARMACHAIN_VALIDATOR_IDS.Split(' ') | Where-Object { $_ }).Count
            $minOnline = $nVal - [int]$ctx.KARMACHAIN_MAX_OFFLINE_VALIDATORS
            Write-Host ''
            Write-Host "  跨机形态：L1 有 $nVal 个等权验证者，发起查询需已连接权重 >= 75%，"
            Write-Host "  因此至少 $minOnline 个验证者在线，链才推得动、RPC 才会应答。"
            Write-Host '  分批启动时先起来的机器必然走到这里 —— 把其余边界起完，再对本机重跑一次'
            Write-Host '  scripts\devnet-start.ps1 即可（它是幂等的，容器还在就只接着轮询）。'
            Write-Host "  各边界：$($ctx.KARMACHAIN_DOMAIN_ADDRESSES)"
        }
        exit 20
    }
    Start-Sleep -Seconds 3
}
