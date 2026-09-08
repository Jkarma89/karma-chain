# scripts/devnet-logs.ps1 —— 按节点查看日志（功能 002 / US6、FR-031）。
# 与 scripts/devnet-logs.sh 等价；脱敏理由见 .sh 版本的说明。
#
# 用法：scripts\devnet-logs.ps1 [<node>] [--chain] [--stdout] [--file <name>] [-f] [-n N] [--raw]
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

$node = ''; $file = ''; $follow = $false; $lines = 200; $raw = $false; $useStdout = $false
for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
        '-f'       { $follow = $true }
        '--follow' { $follow = $true }
        '--raw'    { $raw = $true }
        '--chain'  { $file = 'karmachain.log' }
        '--stdout' { $useStdout = $true }
        '--file'   { $i++; $file = $args[$i] }
        '-n'       { $i++; $lines = [int]$args[$i] }
        default    { if ($args[$i] -notlike '-*') { $node = $args[$i] } else { Write-Error "未知选项 $($args[$i])"; exit 10 } }
    }
}

if (-not $node) {
    Write-Host "可选节点：$($ctx.KARMACHAIN_NODE_IDS)"
    Write-Host ''
    foreach ($n in $ctx.KARMACHAIN_NODE_IDS.Split(' ')) {
        $ls = Invoke-Quiet { docker exec "karmachain-$n" ls -1 /data/logs }
        if ($ls) { Write-Host '日志文件：'; $ls | ForEach-Object { Write-Host "  $_" }; break }
    }
    Write-Host ''
    Write-Host '示例：scripts\devnet-logs.ps1 l1-1 --chain -n 50'
    exit 0
}

$c = "karmachain-$node"
docker inspect $c *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Error "容器 $c 不存在 —— 本机是否承载该节点？可选：$($ctx.KARMACHAIN_NODE_IDS)`n  跨机形态下每台机器只跑本边界的节点"
    exit 10
}

function Redact { process { if ($raw) { $_ } else { $_ -replace '("[a-zA-Z-]*[Cc]ontent"\s*:\s*")[^"]{8,}"', '$1<已脱敏>"' } } }

if ($useStdout) {
    if ($follow) { docker logs -f --tail $lines $c 2>&1 | Redact } else { docker logs --tail $lines $c 2>&1 | Redact }
    exit 0
}
if (-not $file) { $file = 'main.log' }
if ($follow) { docker exec $c tail -f -n $lines "/data/logs/$file" 2>&1 | Redact }
else { docker exec $c tail -n $lines "/data/logs/$file" 2>&1 | Redact }
