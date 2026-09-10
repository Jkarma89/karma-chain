# scripts/devnet-contracts.ps1 —— 列出链上所有合约（创世内置 + 运行期部署）。
#
# 与 scripts/devnet-contracts.sh 等价。
# 用法：scripts\devnet-contracts.ps1 [--json] [--from <block>] [--no-probe]
# 退出码：0 成功 | 1 链不可达 | 10 前置依赖缺失
#
# 此前这里是 `docker compose run --rm verify …`，它把容器落在**工具项目自己**的默认网络上，
# 接不到节点 —— 2026-09-08 在跨机形态下实测：容器内连 127.0.0.1 上的宿主 RPC 端口（那是容器自己），
# ECONNREFUSED。现在与 devnet-verify 走完全同一条路径。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

# 工具镜像是本地构建的：不存在时 docker 报的那句 pull access denied 指向错误方向。
if (-not (Assert-VerifyImage)) { Write-Host 'devnet-contracts: 前置条件未满足（见上）'; exit 10 }

$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-contracts: 前置条件未满足（见上）'; exit 10 }

docker run --rm `
  --network $network `
  -v "$($ctx.Root):/workspace" `
  -e "KARMACHAIN_RPC_URL=$(Get-ContainerRpcUrl $ctx)" `
  karmachain/verify:local node tools/inspect/list-contracts.mjs @args
exit $LASTEXITCODE
