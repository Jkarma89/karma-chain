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
