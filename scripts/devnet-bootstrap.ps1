# scripts/devnet-bootstrap.ps1 —— 一次性建链（功能 002）。仓库中唯一用到 Avalanche CLI 的地方。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Error '需要 Node（提取制品）'; exit 10 }

$running = docker ps --format '{{.Names}}' | Where-Object { $_ -like 'karmachain-*' }
# 退出码 10（前置条件未满足），不是 11 —— 契约里 11 专指宿主端口冲突
if ($running) { Write-Error '仍有节点在运行 —— 先执行 scripts/devnet-stop.ps1'; exit 10 }

$bootstrap = Join-Path $ctx.Root 'docker/compose/bootstrap.yml'
docker compose -f $bootstrap run --rm bootstrap @args
if ($LASTEXITCODE -ne 0) { Write-Error '建链失败'; exit 20 }

Push-Location $ctx.Root
try {
    node tools/protocol/extract-identity.mjs        .devnet/bootstrap/sidecar.json    --out blockchain/chain-identity/karmachain.identity.json
    node tools/protocol/extract-primary-genesis.mjs .devnet/bootstrap/node-flags.json --out blockchain/chain-identity/primary-network.genesis.json
    npm run --silent node:render | Out-Null
} finally { Pop-Location }
Write-Host ''
Write-Host 'devnet-bootstrap: 完成。下一步：scripts/devnet-start.ps1'
