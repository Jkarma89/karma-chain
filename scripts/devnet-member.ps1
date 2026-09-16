# scripts/devnet-member.ps1 —— 成员管理入口：看 / 加 / 退（功能 005 / US2 / US3、FR-017）。
# 与 scripts/devnet-member.sh 等价。
#
# 用法：
#   scripts\devnet-member.ps1 status
#   scripts\devnet-member.ps1 add    --node-id NodeID-… [--yes]
#   scripts\devnet-member.ps1 remove --node-id NodeID-… [--emergency] [--yes]
#
# 退出码（与 tools/membership/exit-codes.mjs 同一套，**不复用 11/12/13/20**）：
#   0 成功 | 10 前置依赖缺失 | 30 前置检查未通过（未动链）
#   31 某一步失败（可重跑） | 32 人工中止 | 33 只读报告发现漂移
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '_devnet-common.ps1')

$sub = if ($args.Count -gt 0) { $args[0] } else { '' }
$rest = if ($args.Count -gt 1) { $args[1..($args.Count - 1)] } else { @() }

$tools = @{ status = 'tools/membership/member-set.mjs';
            add    = 'tools/membership/add-validator.mjs';
            remove = 'tools/membership/remove-validator.mjs' }

if ($sub -in @('', '-h', '--help')) {
  Get-Content $PSCommandPath | Select-Object -Skip 3 -First 6 | ForEach-Object { $_ -replace '^# ?', '' }
  exit 0
}
if (-not $tools.ContainsKey($sub)) {
  Write-Host "devnet-member: 未知子命令 '$sub'（可用：status / add / remove）"
  exit 10
}

$ctx = Get-DevnetContext; Assert-Docker
if (-not (Assert-VerifyImage)) { Write-Host 'devnet-member: 前置条件未满足（见上）'; exit 10 }
$network = Get-NodeNetwork $ctx.Domain
if (-not $network) { Write-Host 'devnet-member: 前置条件未满足（见上）'; exit 10 }
New-Item -ItemType Directory -Force -Path (Join-Path $ctx.Root '.devnet') | Out-Null

# 聚合器：只有 add / remove 的第二步需要。它按文档发布在**宿主**的 8646 上，
# 而本工具跑在容器里 —— 宿主的 127.0.0.1 不是它的 127.0.0.1。理由见 .sh 同段注释。
$aggArgs = @()
if ($sub -ne 'status') {
  if ($env:KARMACHAIN_AGGREGATOR_URL) {
    $aggArgs = @('-e', "KARMACHAIN_AGGREGATOR_URL=$($env:KARMACHAIN_AGGREGATOR_URL)")
  } else {
    # 用 Invoke-Quiet 而不是 2>$null —— 后者抑制原生命令 stderr 不可靠
    # （tests/unit/powershell-portability.test.mjs 守着这一条）。
    $aggNets = @(Invoke-Quiet {
      docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' karmachain-aggregator
    } | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object { $_.ToString().Trim() })
    if ($aggNets.Count -eq 0) {
      Write-Host 'devnet-member: 找不到运行中的 karmachain-aggregator'
      Write-Host '  第二步（收集验证者签名）需要它。起法见 docs/devnet.md §11.2 第③步；'
      Write-Host '  它在别的机器上时，用 KARMACHAIN_AGGREGATOR_URL 指过去。'
      exit 10
    }
    if ($aggNets -notcontains $network) {
      Write-Host "devnet-member: karmachain-aggregator 不在节点网络 '$network' 上"
      Write-Host "  它现在接在：$($aggNets -join ' ')"
      Write-Host '  工具容器按**容器名**连它，因此两者要在同一个网络里。接上去：'
      Write-Host "    docker network connect $network karmachain-aggregator"
      Write-Host '  或者用 KARMACHAIN_AGGREGATOR_URL 指向一个本容器能到的地址。'
      exit 10
    }
    $aggArgs = @('-e', 'KARMACHAIN_AGGREGATOR_URL=http://karmachain-aggregator:8646')
  }
}

# -i：加入与退出在每个危险动作前会问一次，交互要能传进去。
# 挂载集合与 devnet-verify 一致；blockchain/ 仍只读 —— 成员变更不写仓库。
docker run --rm -i `
  --network $network `
  -v "$($ctx.Root)/blockchain:/workspace/blockchain:ro" `
  -v "$($ctx.Root)/tools:/workspace/tools:ro" `
  -v "$($ctx.Root)/.devnet:/workspace/.devnet" `
  -e "KARMACHAIN_RPC_URL=$(Get-ContainerRpcUrl $ctx)" `
  @aggArgs `
  karmachain/verify:local node $tools[$sub] @rest
exit $LASTEXITCODE
