# scripts/devnet-logs.ps1 —— 按节点查看日志（薄封装）。默认脱敏 staking 密钥材料（FR-026）。
# 用法：scripts\devnet-logs.ps1 [<node>] [--chain] [--file <name>] [-f] [-n N] [--raw]
#   不带参数时列出可选节点与日志文件。
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-logs: docker not found'; exit 10 }
docker compose exec -T devnet devnet-logs @args
exit $LASTEXITCODE
