# scripts/devnet-status.ps1 —— 每节点健康/共识状态（薄封装）。
# 退出码：0 全部健康 | 1 存在不健康节点 | 2 网络未运行 | 10 Docker 不可用
# 透传参数，例如：scripts\devnet-status.ps1 --json
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-status: docker not found'; exit 10 }
docker compose exec -T devnet devnet-status @args
exit $LASTEXITCODE
