# scripts/devnet-reset.ps1 —— 从创世重建（功能 002）。
# 它不再是崩溃后的出路 —— 崩溃自愈由节点自身完成（FR-005）。删卷后必须重新 bootstrap。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker
docker compose -f $ctx.Compose down -v --remove-orphans
Write-Host 'devnet-reset: 全部节点卷已删除。'
Write-Host '  下一步：scripts/devnet-bootstrap.ps1  然后  scripts/devnet-start.ps1'
