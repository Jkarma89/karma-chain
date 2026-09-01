# scripts/devnet-stop.ps1 —— 停止开发网络并保留链状态（容器收到 SIGTERM → avalanche network stop 保存快照）
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-stop: docker not found'; exit 10 }
docker compose stop devnet
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Write-Host "devnet-stop: stopped (chain state preserved; 'scripts/devnet-start' resumes, 'scripts/devnet-reset' wipes)"
