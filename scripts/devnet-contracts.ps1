# scripts/devnet-contracts.ps1 —— 列出链上所有合约（创世内置 + 运行期部署）。
#
# 用法：scripts\devnet-contracts.ps1 [--json] [--from <block>] [--no-probe]
# 退出码：0 成功 | 1 链不可达 | 10 Docker 不可用
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-contracts: docker not found'; exit 10 }
docker compose run --rm verify node tools/inspect/list-contracts.mjs @args
exit $LASTEXITCODE
