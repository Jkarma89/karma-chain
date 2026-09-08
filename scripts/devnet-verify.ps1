# scripts/devnet-verify.ps1 —— 对运行中的开发网络执行 14 项自动化验证（薄封装）。
#
# 与 scripts/devnet-verify.sh 等价。此前这个 .ps1 与 .sh 版**完全不等价**：它跑的是
# `docker compose run --rm verify`，而任何 compose 文件里都没有 verify 服务
# （2026-09-08 实测报 `no such service: verify`）—— 也就是说它整体失效，而契约
# （001 cli-interface.md）要求两版等价。现在改为与 .sh 同一条 docker run。
#
# 退出码：0 全部通过 | 1 任一失败 | 10 前置依赖缺失
# 透传参数，例如：scripts\devnet-verify.ps1 --quick
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

New-Item -ItemType Directory -Force -Path (Join-Path $ctx.Root '.devnet') | Out-Null

# 网络名与容器内 RPC 地址都由公共件推导 —— 不能硬编码，也不能走 docker compose run，
# 理由见 _devnet-common.ps1 的 Get-NodeNetwork。
$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-verify: 前置条件未满足（见上）'; exit 10 }

docker run --rm `
  --network $network `
  -v "$($ctx.Root):/workspace" `
  -e "KARMACHAIN_RPC_URL=$(Get-ContainerRpcUrl $ctx)" `
  karmachain/verify:local npm run verify -- @args
exit $LASTEXITCODE
