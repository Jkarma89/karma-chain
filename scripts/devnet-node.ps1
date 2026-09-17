# scripts/devnet-node.ps1 —— 单节点生命周期控制（功能 002）。与 .sh 版本等价。
# 用法：scripts/devnet-node.ps1 <kill|stop|start|restart|status|wipe> <node-id>
param(
    [Parameter(Mandatory = $true)][ValidateSet('kill', 'stop', 'start', 'restart', 'status', 'wipe')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Node
)
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

# ① 拼写检查：这个 id 在**整张网络**里存在吗
if ($ctx.KARMACHAIN_NODE_IDS.Split(' ') -notcontains $Node) {
    Write-Error "未知节点 '$Node' —— 可选: $($ctx.KARMACHAIN_NODE_IDS)"; exit 10
}

# ② 它必须由**本机**承载。理由与 .sh 同一段注释 ——
# 2026-09-17 在 win-2 上实地撞到：没设 KARMACHAIN_DOMAIN，边界回落成 win-1，
# `stop l1-2` 去 lan-win-1.yml 里找 l1-2，compose 报 no such service，
# **而本脚本照报"已停止"**。l1-2 根本没停。
$localServices = @(Invoke-Quiet { docker compose -f $ctx.Compose config --services }
    | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object { $_.ToString().Trim() })
if ($localServices -notcontains $Node) {
    Write-Host "devnet-node: 本机（边界 $($ctx.Domain)）不承载节点 '$Node'"
    Write-Host "  本机承载: $($localServices -join ' ')"
    if ($env:KARMACHAIN_DOMAIN) {
        Write-Host "  当前边界取自 KARMACHAIN_DOMAIN=$($ctx.Domain) —— 若本机不是它，改成本机的边界 id。"
    } else {
        Write-Host "  当前边界 '$($ctx.Domain)' 来自**默认值**（KARMACHAIN_DOMAIN 未设）。"
        Write-Host "  若本机不是 '$($ctx.Domain)'，先指定本机的边界："
        Write-Host "    `$env:KARMACHAIN_DOMAIN='<本机边界 id>'; .\scripts\devnet-node.ps1 $Action $Node"
    }
    exit 10
}

# 跑一条 compose 子命令，**失败就说失败** —— 此前成功消息是无条件打印的，
# 于是 compose 报错（如 no such service）之后仍然输出"已停止"。
# .sh 那版靠 `set -eu` 天然不会（命令失败即中止），两版因此在**失败路径上并不等价**，
# 而 FR-017 要的正是等价。更糟的是它恰好落在两台 Windows 机器上 ——
# 按 ADR-0006 那两台要人工介入恢复，假成功正好出现在有人手动操作的地方。
function Invoke-NodeCompose {
    param([string[]]$Args, [string]$OkMessage)
    docker compose -f $ctx.Compose @Args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "devnet-node: **没有执行成功** —— docker compose $($Args -join ' ') 退出码 $LASTEXITCODE"
        Write-Host '  上面 docker 的输出说明了原因。不要把这次当成已生效。'
        exit 10
    }
    Write-Host $OkMessage
}

$container = "karmachain-$Node"
$volume    = "karmachain-$Node-data"

switch ($Action) {
    'kill'    {
        docker kill $container | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "devnet-node: **没有执行成功** —— docker kill $container 退出码 $LASTEXITCODE"
            exit 10
        }
        Write-Host "devnet-node: $Node 已被 SIGKILL 强制终止（未给优雅退出机会）"
    }
    'stop'    { Invoke-NodeCompose @('stop', $Node)    "devnet-node: $Node 已停止" }
    'start'   { Invoke-NodeCompose @('up', '-d', $Node) "devnet-node: $Node 已启动" }
    'restart' { Invoke-NodeCompose @('restart', $Node) "devnet-node: $Node 已重启" }
    'status'  {
        $state  = Invoke-Quiet { docker inspect --format '{{.State.Status}}' $container }
        $health = Invoke-Quiet { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' $container }
        '{0,-12} {1,-10} {2}' -f $Node, $state, $health
    }
    'wipe'    {
        Invoke-Quiet { docker compose -f $ctx.Compose stop $Node } | Out-Null
        Invoke-Quiet { docker compose -f $ctx.Compose rm -f $Node } | Out-Null
        docker volume rm -f $volume | Out-Null
        Write-Host "devnet-node: $Node 的数据卷已删除 —— 'start' 后它会从对等节点重新同步"
        Write-Host '  身份不在数据卷里（只读挂载自仓库），因此 NodeID 不变（研究 R-03）'
    }
}
