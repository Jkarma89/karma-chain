# scripts/devnet-stop.ps1 —— 停止开发网络（功能 002）。不保存任何东西：002 没有快照机制。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker
docker compose -f $ctx.Compose stop
Write-Host "devnet-stop: 已停止（链状态在各节点卷内；devnet-start.ps1 继续，devnet-reset.ps1 清空）"
