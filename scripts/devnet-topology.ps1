# scripts/devnet-topology.ps1 —— 校验并展示拓扑（功能 002 / US5）。
# 与 scripts/devnet-topology.sh 等价。
#
# 用法：scripts\devnet-topology.ps1 [--deployment <name>] [--json] [--protocol <path>]
# 退出码：0 拓扑合法 | 10 声明缺失或不可读 | 13 拓扑违反容错约束
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-topology: docker not found'; exit 10 }
docker compose run --rm verify node tools/protocol/validate-topology.mjs @args
exit $LASTEXITCODE
