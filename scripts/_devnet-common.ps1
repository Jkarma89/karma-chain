# scripts/_devnet-common.ps1 —— devnet-*.ps1 的共用部分（功能 002）
# 与 .sh 版本等价的薄封装；业务逻辑一律在生成器与容器入口里，这里只做转调。
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-DevnetContext {
    $root = Resolve-Path (Join-Path $PSScriptRoot '..')
    # KARMACHAIN_ENV_FILE 只为测试留的接缝，与 devnet-start.sh 的同名接缝对应
    # （此前只有 .sh 有，两版因此不等价 —— .ps1 的分支无从测试）：
    # 跨机形态的守卫只在多边界时生效，而把生效形态切过去会打断正在跑的开发网。
    $envFile = if ($env:KARMACHAIN_ENV_FILE) { $env:KARMACHAIN_ENV_FILE }
               else { Join-Path $root 'docker/compose/active.env' }
    if (-not (Test-Path $envFile)) {
        Write-Error "$envFile 不存在 —— 先运行 scripts\devnet-render.ps1"; exit 10
    }
    $ctx = @{ Root = $root }
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^([A-Z][A-Z0-9_]*)=(.*)$') {
            $ctx[$Matches[1]] = $Matches[2].Trim('"')
        }
    }
    $domain = if ($env:KARMACHAIN_DOMAIN) { $env:KARMACHAIN_DOMAIN } else { $ctx.KARMACHAIN_DEFAULT_DOMAIN }
    $ctx.Domain  = $domain
    $ctx.Compose = Join-Path $root "docker/compose/$($ctx.KARMACHAIN_DEPLOYMENT)-$domain.yml"
    $ctx.Rpc     = "http://127.0.0.1:$($ctx.KARMACHAIN_RPC_PORT)$($ctx.KARMACHAIN_RPC_PATH)"
    if (-not (Test-Path $ctx.Compose)) {
        Write-Error "未知的故障边界 '$domain' —— 可选：$($ctx.KARMACHAIN_DOMAINS)"; exit 10
    }
    return $ctx
}

<#
.SYNOPSIS
运行一个原生命令，吞掉它的 stderr，并用 $null 表示失败。

.DESCRIPTION
为什么需要这个 helper：`2>$null` **不能可靠地抑制原生命令的 stderr**。
配合 _devnet-common.ps1 顶部的 $ErrorActionPreference='Stop'，docker 写到 stderr 的内容
会变成 NativeCommandError 并打印一大段红字 —— 而调用方本来只是想"探一下，失败就算了"。

这在跨机形态下不是纯噪音：每台机器只承载本边界的节点，而脚本会遍历 active.env 里
**全部** 7 个节点 id 去 docker inspect，于是每轮轮询有 6 个必然失败 ——
不抑制的话启动过程会被 6×N 段报错刷屏，把真正的失败埋掉。
.sh 版本用 `2>/dev/null || echo missing` 兜住，.ps1 此前没有对应处理。

做法：`2>&1` 把 stderr 并进 stdout，**并且**用 try/catch 兜住终止性错误。

为什么 `2>&1` 单独不够（2026-09-08 在 win-2 上实测，这是本 helper 第一版的 bug）：
本文件顶部的 `$ErrorActionPreference='Stop'` 会把"原生命令写了 stderr"升级成
**终止性** NativeCommandError，而它是在脚本块**内部**抛出的 —— 调用点的 `2>&1`
来不及合流，异常直接穿到顶层，红字照样打印、脚本当场中止。

实测症状：`devnet-start.ps1` 在 win-2 上遍历 active.env 里全部 7 个节点 id 去
`docker inspect`，第一个不在本机的 `karmachain-l1-1` 就让整个脚本挂掉：
    docker : error: no such object: karmachain-l1-1
    FullyQualifiedErrorId : NativeCommandError
win-1 上一直没暴露：那台第一次轮询 `eth_chainId` 就命中，`foreach` 那段没执行到。

catch 块必须是空的 —— 本 helper 的语义就是"探一下，失败就算了"，$null 已表达失败。
在这里改 $ErrorActionPreference 是行不通的：脚本块的父作用域是它的**定义处**
（调用方脚本），不是本函数，所以设局部变量对它不可见。
#>
function Invoke-Quiet {
    param([Parameter(Mandatory)][scriptblock]$Command)
    try {
        $out = & $Command 2>&1
        if ($LASTEXITCODE -eq 0) { return $out }
    } catch {
        # 原生命令写了 stderr 而 EAP=Stop 把它升级成异常 —— 那正是"失败"，按 $null 处理。
    }
    return $null
}

<#
.SYNOPSIS
问出**节点所在的容器网络**名，供工具容器（karmachain/verify:local）挂接。

.DESCRIPTION
与 _devnet-common.sh 的 devnet_node_network 等价。网络名不能硬编码，也不能走
`docker compose run --rm verify`：

  * 硬编码 `karmachain` 只在单机形态成立 —— 跨机形态的 lan-*.yml 没有 networks 段，
    容器落在 compose 的隐式默认网络上，名字由项目名派生（实测为 compose_default）。
  * `docker compose run --rm verify`（根目录 docker-compose.yml 的工具服务）会把容器
    落在**工具项目自己**的默认网络上，接不到节点 —— 逐节点检查会全部不可达。
    docker-compose.yml 的注释里已写明这一点，devnet-verify.ps1 此前正是踩了它。

真相在 docker 那边，直接问运行中的 RPC 代理容器。这顺带成了前置检查：代理没在跑
就说明网络没起来，报"先 devnet-start"比报"网络不存在"有指向性。找不到时返回 $null。
#>
function Get-NodeNetwork([string]$domain) {
    $container = "karmachain-rpc-$domain"
    $net = Invoke-Quiet {
        docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{println}}{{end}}' $container
    } | Where-Object { $_ } | Select-Object -First 1
    if (-not $net) {
        Write-Host "找不到运行中的 $container —— 先运行 scripts\devnet-start.ps1" -ForegroundColor Red
        Write-Host '  工具容器要接到节点所在的容器网络上（与第三方相同的位置），因此需要网络已启动。'
        # 在**非默认**机器上最常见的成因其实不是"没启动"，而是没设 KARMACHAIN_DOMAIN ——
        # 于是 $domain 回落到默认边界，脚本去找一个本机根本不存在的容器。
        # 原先的提示会把人引向"再跑一次 devnet-start"，而那解决不了问题。
        # 2026-09-10 在 win-2 上撞到（默认边界是 win-1）。
        if ($domain -eq $env:KARMACHAIN_DOMAIN) {
            Write-Host "  当前边界取自 KARMACHAIN_DOMAIN=$domain。若这台机器承载的不是它，请改成本机的边界 id。"
        } else {
            Write-Host "  当前边界 '$domain' 来自默认值（KARMACHAIN_DOMAIN 未设）。" -ForegroundColor Yellow
            Write-Host "  **若本机不是 '$domain'**，需要先指定本机的故障边界，例如：" -ForegroundColor Yellow
            Write-Host "    `$env:KARMACHAIN_DOMAIN='<本机边界 id>'" -ForegroundColor Yellow
        }
        return $null
    }
    return $net
}

# 工具容器内可用的 RPC 地址：走本边界的 nginx 代理，而不是某个验证者 ——
# 代理是对外的唯一入口，验证与查询都应当从与第三方相同的位置发起。
# 工具镜像必须在**本机**存在 —— 它是本地构建的，从不推到任何 registry。
# 理由与那句误导性报错见 _devnet-common.sh 的同段注释（2026-09-10 在 win-2 上撞到）。
#
# 用法：if (-not (Assert-VerifyImage)) { exit 10 }
function Assert-VerifyImage {
    if (Invoke-Quiet { docker image inspect karmachain/verify:local }) { return $true }
    Write-Host '本机没有工具镜像 karmachain/verify:local —— 它是**本地构建**的，不在任何 registry 上。' -ForegroundColor Red
    Write-Host '  先建一次（每台机器各建一次，之后改代码无需重建 —— 源码是运行时挂载的）：'
    Write-Host ''
    Write-Host '    docker compose --profile verify build verify' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "  若 docker 报 'pull access denied … may require docker login'，那句话是误导的："
    Write-Host '  不是权限问题，就是本机还没建过这个镜像。'
    return $false
}

function Get-ContainerRpcUrl($ctx) {
    "http://karmachain-rpc-$($ctx.Domain):$($ctx.KARMACHAIN_RPC_PORT)$($ctx.KARMACHAIN_RPC_PATH)"
}

# "连不上守护进程"与"没权限跟它说话"是两件事，报同一句话会把人引错方向。
#
# 2026-09-09 实测（devnet-start.sh 的同一处）：在 ubuntu-1 上不加 sudo 跑，
# 得到「Docker daemon is not running」—— 而那台机器上 Docker 正常、两个节点都 healthy。
# 运维方按字面去查守护进程，白费时间；真正要做的只是 sudo 或加入 docker 组。
#
# Windows 上权限这条基本不出现（Docker Desktop 以当前用户身份跑），但**把 docker 自己的
# 错误输出打出来**在这边同样有价值：Docker Desktop 没启动是头号成因（ADR-0006），
# 而它的原文（`error during connect: ... 系统找不到指定的文件`）比一句概括有用得多。
function Assert-Docker {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        Write-Error 'docker not found — install Docker Desktop (WSL2 backend)'; exit 10
    }
    # 直接在调用点合流 stderr 是可行的（与 Invoke-Quiet 不同 —— 那里的问题出在
    # 脚本块边界上，见该函数的说明）。
    $out = docker info 2>&1
    if ($LASTEXITCODE -eq 0) { return }

    $text = ($out | Out-String)
    if ($text -match 'permission denied|Permission denied') {
        Write-Host '没有权限访问 Docker 守护进程（守护进程本身可能是正常的）' -ForegroundColor Red
        Write-Host '  Linux 上：sudo，或 sudo usermod -aG docker $USER 后重新登录。'
        Write-Host '  本机上请**统一**用一种方式 —— 一会儿 sudo 一会儿不 sudo，'
        Write-Host '  会让 docker 上下文与 ~/.docker 配置分属两个用户，出现「容器/卷找不到」的错觉。'
        exit 10
    }
    Write-Host '连不上 Docker 守护进程 —— 它没在运行？' -ForegroundColor Red
    Write-Host '  Windows 上最常见的原因是 Docker Desktop 没启动（ADR-0006：容器随用户会话启动）。'
    Write-Host '  docker info 的输出：'
    ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 5) |
        ForEach-Object { Write-Host "    $($_.TrimEnd())" }
    exit 10
}

function Get-ChainId([string]$rpc) {
    try {
        $body = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
        (Invoke-RestMethod -Uri $rpc -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 5).result
    } catch { $null }
}
