# scripts/devnet-node.ps1 —— 单节点生命周期控制（功能 002）。与 .sh 版本等价。
# 用法：scripts/devnet-node.ps1 <kill|stop|start|restart|status|wipe> <node-id>
#
# 退出码：0 动作已生效 | 10 前置依赖缺失 / 用法错误 | 20 **动作没有生效**
#
# 20 是 2026-09-17 加的（005 研究 V-36）：`restart l1-1` 打印了「已重启」，
# 而容器的 StartedAt **一字未变** —— compose 自己退出 0，所以只看退出码拦不住。
# 所以每个改状态的动作现在都**事后核对容器状态**，核不过就报 20。
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
    param([string[]]$ComposeArgs)
    docker compose -f $ctx.Compose @ComposeArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "devnet-node: **没有执行成功** —— docker compose $($ComposeArgs -join ' ') 退出码 $LASTEXITCODE"
        Write-Host '  上面 docker 的输出说明了原因。不要把这次当成已生效。'
        exit 10
    }
}

# 事后判定用的两个读数 —— 与 .sh 的 container_state / container_started 同义。
function Get-ContainerState {
    param([string]$Name)
    $v = Invoke-Quiet { docker inspect --format '{{.State.Status}}' $Name }
    if ($LASTEXITCODE -ne 0 -or -not $v) { return 'missing' }
    return "$v".Trim()
}
function Get-ContainerStarted {
    param([string]$Name)
    $v = Invoke-Quiet { docker inspect --format '{{.State.StartedAt}}' $Name }
    if ($LASTEXITCODE -ne 0 -or -not $v) { return '' }
    return "$v".Trim()
}

# 动作没有生效 —— 统一的报法（见头部对退出码 20 的说明）。与 .sh 的 not_effective 同义。
function Exit-NotEffective {
    param([string]$Why)
    Write-Host "devnet-node: **$Node 的 '$Action' 没有生效** —— $Why"
    Write-Host '  docker 命令自己退出 0，但容器状态说它什么都没发生。'
    Write-Host "  不要把这次当成已生效。先跑 'status $Node' 看它现在是什么状态。"
    exit 20
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
        if ((Get-ContainerState $container) -eq 'running') { Exit-NotEffective '它还是 running' }
        Write-Host "devnet-node: $Node 已被 SIGKILL 强制终止（未给优雅退出机会）"
    }
    'stop'    {
        Invoke-NodeCompose @('stop', $Node)
        if ((Get-ContainerState $container) -eq 'running') { Exit-NotEffective '它还是 running' }
        Write-Host "devnet-node: $Node 已停止"
    }
    'start'   {
        # start 的判据是**终态**而不是"时刻变了"：对已经在跑的节点，
        # up -d 什么都不做是**对的**，"已启动"那句话依然为真。
        Invoke-NodeCompose @('up', '-d', $Node)
        $state = Get-ContainerState $container
        if ($state -ne 'running') { Exit-NotEffective "它现在是 $state，不是 running" }
        Write-Host "devnet-node: $Node 已启动"
    }
    'restart' {
        # restart 的判据**必须是时刻变了**。这正是 V-36 那条假成功：
        # 终态照旧 running，只有 StartedAt 能区分"重启过"与"压根没动"。
        $before = Get-ContainerStarted $container
        Invoke-NodeCompose @('restart', $Node)
        $after = Get-ContainerStarted $container
        if (-not $after) { Exit-NotEffective '重启后读不到容器状态' }
        if ($after -eq $before) { Exit-NotEffective "StartedAt 还是 $before —— 进程没有被重新拉起" }
        $state = Get-ContainerState $container
        if ($state -ne 'running') { Exit-NotEffective "重启后它是 $state，不是 running" }
        Write-Host "devnet-node: $Node 已重启（StartedAt $before → $after）"
    }
    'status'  {
        $state  = Invoke-Quiet { docker inspect --format '{{.State.Status}}' $container }
        $health = Invoke-Quiet { docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' $container }
        '{0,-12} {1,-10} {2}' -f $Node, $state, $health
    }
    'wipe'    {
        Invoke-Quiet { docker compose -f $ctx.Compose stop $Node } | Out-Null
        Invoke-Quiet { docker compose -f $ctx.Compose rm -f $Node } | Out-Null
        Invoke-Quiet { docker volume rm -f $volume } | Out-Null
        # **卷真的没了吗** —— 与 .sh 同一段理由。wipe 是最不该报假成功的一个：
        # 假成功之后 start 会把带着原数据的节点拉回来，秒级追平，
        # 于是想观察的引导窗口根本不存在，而人会以为是"没观察到"。
        Invoke-Quiet { docker volume inspect $volume } | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Host "devnet-node: **$Node 的数据卷没有被删除** —— 它还在（$volume）"
            Write-Host '  多半是还有容器占着它。先 stop 那个容器，或 docker ps -a 看谁在用。'
            Write-Host '  不要把这次当成已生效：数据还在，节点起来后不会重新同步。'
            exit 20
        }
        Write-Host "devnet-node: $Node 的数据卷已删除（已核实它确实不存在了）—— 'start' 后它会从对等节点重新同步"
        Write-Host '  身份不在数据卷里（只读挂载自仓库），因此 NodeID 不变（研究 R-03）'
    }
}
