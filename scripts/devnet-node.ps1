# scripts/devnet-node.ps1 —— 单节点生命周期控制（功能 002）。与 .sh 版本等价。
# 用法：scripts/devnet-node.ps1 <kill|stop|start|restart|status|wipe> <node-id>
param(
    [Parameter(Mandatory = $true)][ValidateSet('kill', 'stop', 'start', 'restart', 'status', 'wipe')][string]$Action,
    [Parameter(Mandatory = $true)][string]$Node
)
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker

if ($ctx.KARMACHAIN_NODE_IDS.Split(' ') -notcontains $Node) {
    Write-Error "未知节点 '$Node' —— 可选: $($ctx.KARMACHAIN_NODE_IDS)"; exit 10
}
$container = "karmachain-$Node"
$volume    = "karmachain-$Node-data"

switch ($Action) {
    'kill'    { docker kill $container | Out-Null; Write-Host "devnet-node: $Node 已被 SIGKILL 强制终止（未给优雅退出机会）" }
    'stop'    { docker compose -f $ctx.Compose stop $Node | Out-Null; Write-Host "devnet-node: $Node 已停止" }
    'start'   { docker compose -f $ctx.Compose up -d $Node | Out-Null; Write-Host "devnet-node: $Node 已启动" }
    'restart' { docker compose -f $ctx.Compose restart $Node | Out-Null; Write-Host "devnet-node: $Node 已重启" }
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
