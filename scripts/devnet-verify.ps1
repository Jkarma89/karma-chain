# scripts/devnet-verify.ps1 —— 对运行中的开发网络执行 13 项自动化验证（薄封装）。
# 退出码：0 全部通过 | 1 任一失败 | 10 Docker 不可用（契约见 specs/001-*/contracts/cli-interface.md）
# 透传参数，例如：scripts\devnet-verify.ps1 --quick
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'devnet-verify: docker not found'; exit 10 }
New-Item -ItemType Directory -Force -Path '.devnet' | Out-Null
docker compose run --rm verify npm run verify -- @args
exit $LASTEXITCODE
