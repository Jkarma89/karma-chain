# scripts/_devnet-common.ps1 —— devnet-*.ps1 的共用部分（功能 002）
# 与 .sh 版本等价的薄封装；业务逻辑一律在生成器与容器入口里，这里只做转调。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-DevnetContext {
    $root = Resolve-Path (Join-Path $PSScriptRoot '..')
    $envFile = Join-Path $root 'docker/compose/active.env'
    if (-not (Test-Path $envFile)) {
        Write-Error "$envFile 不存在 —— 先运行 'npm run node:render'"; exit 10
    }
    $ctx = @{ Root = $root }
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
            $ctx[$Matches[1]] = $Matches[2].Trim('"')
        }
    }
    $domain = if ($env:KARMACHAIN_DOMAIN) { $env:KARMACHAIN_DOMAIN } else { $ctx.KARMACHAIN_DEFAULT_DOMAIN }
    $ctx.Domain  = $domain
    $ctx.Compose = Join-Path $root "docker/compose/$($ctx.KARMACHAIN_DEPLOYMENT)-$domain.yml"
    $ctx.Rpc     = "http://127.0.0.1:$($ctx.KARMACHAIN_RPC_PORT)$($ctx.KARMACHAIN_RPC_PATH)"
    if (-not (Test-Path $ctx.Compose)) {
        Write-Error "未知的故障边界 '$domain' —— 可选：$($ctx.KARMACHAIN_DOMAINS)"; exit 10
    }
    return $ctx
}

<#
.SYNOPSIS
运行一个原生命令，吞掉它的 stderr，并用 $null 表示失败。

.DESCRIPTION
为什么需要这个 helper：`2>$null` **不能可靠地抑制原生命令的 stderr**。
配合 _devnet-common.ps1 顶部的 $ErrorActionPreference='Stop'，docker 写到 stderr 的内容
会变成 NativeCommandError 并打印一大段红字 —— 而调用方本来只是想"探一下，失败就算了"。

这在跨机形态下不是纯噪音：每台机器只承载本边界的节点，而脚本会遍历 active.env 里
**全部** 7 个节点 id 去 docker inspect，于是每轮轮询有 6 个必然失败 ——
不抑制的话启动过程会被 6×N 段报错刷屏，把真正的失败埋掉。
.sh 版本用 `2>/dev/null || echo missing` 兜住，.ps1 此前没有对应处理。

做法：`2>&1` 把 stderr 并进 stdout，**并且**用 try/catch 兜住终止性错误。

为什么 `2>&1` 单独不够（2026-09-08 在 win-2 上实测，这是本 helper 第一版的 bug）：
本文件顶部的 `$ErrorActionPreference='Stop'` 会把"原生命令写了 stderr"升级成
**终止性** NativeCommandError，而它是在脚本块**内部**抛出的 —— 调用点的 `2>&1`
来不及合流，异常直接穿到顶层，红字照样打印、脚本当场中止。

实测症状：`devnet-start.ps1` 在 win-2 上遍历 active.env 里全部 7 个节点 id 去
`docker inspect`，第一个不在本机的 `karmachain-l1-1` 就让整个脚本挂掉：
    docker : error: no such object: karmachain-l1-1
    FullyQualifiedErrorId : NativeCommandError
win-1 上一直没暴露：那台第一次轮询 `eth_chainId` 就命中，`foreach` 那段没执行到。

catch 块必须是空的 —— 本 helper 的语义就是"探一下，失败就算了"，$null 已表达失败。
在这里改 $ErrorActionPreference 是行不通的：脚本块的父作用域是它的**定义处**
（调用方脚本），不是本函数，所以设局部变量对它不可见。
#>
function Invoke-Quiet {
    param([Parameter(Mandatory)][scriptblock]$Command)
    try {
        $out = & $Command 2>&1
        if ($LASTEXITCODE -eq 0) { return $out }
    } catch {
        # 原生命令写了 stderr 而 EAP=Stop 把它升级成异常 —— 那正是"失败"，按 $null 处理。
    }
    return $null
}

<#
.SYNOPSIS
问出**节点所在的容器网络**名，供工具容器（karmachain/verify:local）挂接。

.DESCRIPTION
与 _devnet-common.sh 的 devnet_node_network 等价。网络名不能硬编码，也不能走
`docker compose run --rm verify`：

  * 硬编码 `karmachain` 只在单机形态成立 —— 跨机形态的 lan-*.yml 没有 networks 段，
    容器落在 compose 的隐式默认网络上，名字由项目名派生（实测为 compose_default）。
  * `docker compose run --rm verify`（根目录 docker-compose.yml 的工具服务）会把容器
    落在**工具项目自己**的默认网络上，接不到节点 —— 逐节点检查会全部不可达。
    docker-compose.yml 的注释里已写明这一点，devnet-verify.ps1 此前正是踩了它。

真相在 docker 那边，直接问运行中的 RPC 代理容器。这顺带成了前置检查：代理没在跑
就说明网络没起来，报"先 devnet-start"比报"网络不存在"有指向性。找不到时返回 $null。
#>
function Get-NodeNetwork([string]$domain) {
    $container = "karmachain-rpc-$domain"
    $net = Invoke-Quiet {
        docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' $container
    } | Where-Object { $_ } | Select-Object -First 1
    if (-not $net) {
        Write-Host "找不到运行中的 $container —— 先运行 scripts\devnet-start.ps1" -ForegroundColor Red
        Write-Host '  工具容器要接到节点所在的容器网络上（与第三方相同的位置），因此需要网络已启动。'
        return $null
    }
    return $net
}

# 工具容器内可用的 RPC 地址：走本边界的 nginx 代理，而不是某个验证者 ——
# 代理是对外的唯一入口，验证与查询都应当从与第三方相同的位置发起。
function Get-ContainerRpcUrl($ctx) {
    "http://karmachain-rpc-$($ctx.Domain):$($ctx.KARMACHAIN_RPC_PORT)$($ctx.KARMACHAIN_RPC_PATH)"
}

function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Error 'docker not found — install Docker Desktop (WSL2 backend)'; exit 10
    }
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { Write-Error 'Docker daemon is not running'; exit 10 }
}

function Get-ChainId([string]$rpc) {
    try {
        $body = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
        (Invoke-RestMethod -Uri $rpc -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5).result
    } catch { $null }
}
