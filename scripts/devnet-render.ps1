# scripts/devnet-render.ps1 —— 由唯一事实来源重新生成全部派生物（功能 002 / US5、FR-027）。
# 与 scripts/devnet-render.sh 等价。
#
# 用法：scripts\devnet-render.ps1 [--check]
# 退出码：0 一致或已生成 | 1 存在漂移 | 10 Docker 不可用
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-render: docker not found'; exit 10 }
docker compose run --rm render node tools/protocol/render-all.mjs @args
exit $LASTEXITCODE
