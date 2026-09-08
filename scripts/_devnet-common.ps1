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

做法：`2>&1` 把 stderr 并进 stdout（因此不会泄漏到控制台），再用退出码判断是否采用输出。
#>
function Invoke-Quiet {
    param([Parameter(Mandatory)][scriptblock]$Command)
    $out = & $Command 2>&1
    if ($LASTEXITCODE -eq 0) { return $out }
    return $null
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
