# scripts/devnet-reset.ps1 —— 重置到创世：删除容器与链数据卷（FR-004）。下次 devnet-start 从创世重新部署。
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-reset: docker not found'; exit 10 }
docker compose down -v --remove-orphans
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "devnet-reset: chain data removed (volume karmachain-devnet-data). 'scripts/devnet-start' will recreate the chain from genesis."
