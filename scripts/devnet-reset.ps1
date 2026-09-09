# scripts/devnet-reset.ps1 —— 从创世重建（功能 002）。
# 它不再是崩溃后的出路 —— 崩溃自愈由节点自身完成（FR-005）。删卷后必须重新 bootstrap。
. (Join-Path $PSScriptRoot '_devnet-common.ps1')
$ctx = Get-DevnetContext; Assert-Docker
docker compose -f $ctx.Compose down -v --remove-orphans

# `down -v` **只删 compose 自己创建的卷**。跨机部署时那两个 Primary 卷是手工
# `docker volume create` 出来再导入数据的（docs/devnet.md 9.3 第 3 步），compose 不认它们 ——
# 于是 reset 会删掉验证者卷却留下 Primary 卷，而本脚本却宣称"全部节点卷已删除"。
# 后果不只是措辞不实：重新建链后节点会碰上一份旧的 P 链数据。
# 因此按名字再补删一遍；不存在的卷会失败，忽略即可（本机只有本边界那几个）。
$removedExtra = @()
foreach ($n in $ctx.KARMACHAIN_NODE_IDS.Split(' ')) {
    $v = "karmachain-$n-data"
    if ($null -ne (Invoke-Quiet { docker volume rm $v })) { $removedExtra += $v }
}
if ($removedExtra.Count -gt 0) {
    Write-Host "devnet-reset: 另外删除了非 compose 创建的卷：$($removedExtra -join ' ')"
}

Write-Host 'devnet-reset: 全部节点卷已删除。'
Write-Host '  下一步：scripts/devnet-bootstrap.ps1  然后  scripts/devnet-start.ps1'
