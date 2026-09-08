# scripts/devnet-status.ps1 —— 逐节点报告恢复状态、高度、peers、所属故障边界（功能 002 / US6）。
# 与 scripts/devnet-status.sh 等价。
#
# 用法：scripts\devnet-status.ps1 [--json] [--deployment <name>] [--sample-seconds <n>]
# 退出码：0 无须处置的节点 | 1 存在须处置的节点 | 10 Docker 不可用
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

# 宿主侧采集容器级事实（容器内没有 docker 可用）；采集不到就降级为纯网络判定
$facts = @{}
foreach ($n in $ctx.KARMACHAIN_NODE_IDS.Split(' ')) {
    $c = "karmachain-$n"
    $status = Invoke-Quiet { docker inspect --format '{{.State.Status}}' $c }
    if (-not $status) { continue }
    $code = Invoke-Quiet { docker inspect --format '{{.State.ExitCode}}' $c }
    $err = (docker logs --tail 40 $c 2>&1 | Select-String 'karmachain-node' | Select-Object -Last 1 | ForEach-Object { $_.Line })
    if ($err) { $err = ($err -replace '[\\"]', ' ') ; if ($err.Length -gt 160) { $err = $err.Substring(0, 160) } }
    $self = ''
    if ($status -eq 'running') {
        $json = Invoke-Quiet { docker exec $c /opt/karmachain/healthcheck.sh --state }
        if ($json) { try { $self = ($json | ConvertFrom-Json).state } catch { $self = '' } }
    }
    $facts[$n] = @{ status = $status; exitCode = [int]$code; lastError = "$err"; selfState = "$self" }
}
New-Item -ItemType Directory -Force (Join-Path $ctx.Root '.devnet') | Out-Null
($facts | ConvertTo-Json -Depth 4 -Compress) | Set-Content -Path (Join-Path $ctx.Root '.devnet/containers.json') -Encoding UTF8

# 与 devnet-verify 同一模式：接到节点所在的容器网络上（理由见 .sh 版本）
docker run --rm --network karmachain -v "$($ctx.Root):/workspace" karmachain/verify:local node tools/inspect/node-status.mjs @args
exit $LASTEXITCODE
