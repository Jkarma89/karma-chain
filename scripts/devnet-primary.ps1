# scripts/devnet-primary.ps1 —— Primary 网络验证者集合的入口（功能 005 / US4 / T045）。
# 与 scripts/devnet-primary.sh 等价。
#
# 用法：
#   scripts\devnet-primary.ps1 add --node l1-5 [--days 365] [--stake-avax 1000000] [--dry-run] [--yes]
#
# 退出码（与 tools/membership/exit-codes.mjs 同一套，**不复用 11/12/13/20**）：
#   0 成功 | 10 前置依赖缺失 | 30 前置检查未通过（未动链）
#   31 某一步失败（可重跑） | 32 人工中止
#
# 为什么要有这个入口、为什么不做成 devnet-member 的第四个子命令、
# 以及为什么这里**不需要签名聚合器** —— 三段理由见 .sh 同名文件的文件头。
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_devnet-common.ps1')

$sub = if ($args.Count -gt 0) { $args[0] } else { '' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

if ($sub -in @('', '-h', '--help')) {
  Get-Content $PSCommandPath | Select-Object -Skip 3 -First 6 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}
if ($sub -ne 'add') {
  Write-Host "devnet-primary: 未知子命令 '$sub'（可用：add）"
  exit 10
}

$ctx = Get-DevnetContext; Assert-Docker
if (-not (Assert-VerifyImage)) { Write-Host 'devnet-primary: 前置条件未满足（见上）'; exit 10 }
$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-primary: 前置条件未满足（见上）'; exit 10 }
New-Item -ItemType Directory -Force -Path (Join-Path $ctx.Root '.devnet') | Out-Null

# -i：提交质押之前会问一次（**24 小时不可逆**），交互要能传进去。
docker run --rm -i `
  --network $network `
  -v "$($ctx.Root)/blockchain:/workspace/blockchain:ro" `
  -v "$($ctx.Root)/tools:/workspace/tools:ro" `
  -v "$($ctx.Root)/.devnet:/workspace/.devnet" `
  -e "KARMACHAIN_RPC_URL=$(Get-ContainerRpcUrl $ctx)" `
  karmachain/verify:local node tools/membership/add-primary-validator.mjs @rest
exit $LASTEXITCODE
