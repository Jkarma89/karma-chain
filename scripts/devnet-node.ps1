# scripts/devnet-node.ps1 —— 单节点生命周期控制，用于故障注入（薄封装）。
# 用法：scripts\devnet-node.ps1 <pause|resume|stop|start|status> <node>
#   pause/resume 用 SIGSTOP/SIGCONT，完全可逆，推荐用于故障演练。
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-node: docker not found'; exit 10 }
docker compose exec -T devnet devnet-node @args
exit $LASTEXITCODE
