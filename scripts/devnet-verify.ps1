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
# 工具镜像是本地构建的：不存在时 docker 报的那句 pull access denied 指向错误方向。
if (-not (Assert-VerifyImage)) { Write-Host 'devnet-verify: 前置条件未满足（见上）'; exit 10 }

$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-verify: 前置条件未满足（见上）'; exit 10 }

New-Item -ItemType Directory -Force (Join-Path $ctx.Root '.devnet') | Out-Null

# 挂载**按子目录**，不整仓覆盖 /workspace —— 整仓挂载会盖掉镜像里的 node_modules，
# 在宿主没跑过 npm ci 的机器上报 Cannot find package 'ajv'。
# 理由与那三个路径的取舍见 _devnet-common.sh / devnet-verify.sh 的同段注释。
docker run --rm `
  --network $network `
  -v "$($ctx.Root)/blockchain:/workspace/blockchain:ro" `
  -v "$($ctx.Root)/tools:/workspace/tools:ro" `
  -v "$($ctx.Root)/.devnet:/workspace/.devnet" `
  -e "KARMACHAIN_RPC_URL=$(Get-ContainerRpcUrl $ctx)" `
  karmachain/verify:local npm run verify -- @args
exit $LASTEXITCODE
