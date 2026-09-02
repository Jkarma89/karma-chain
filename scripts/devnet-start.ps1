# scripts/devnet-start.ps1 —— 启动 KarmaChain 本地开发网络（薄封装，无业务逻辑；契约见 specs/001-*/contracts/cli-interface.md）
# 退出码：0 就绪 | 10 Docker 不可用 | 11 宿主端口冲突 | 12 链数据与 protocol.json 不一致 | 20 启动失败/超时
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# 默认值优先级：shell 环境 > .env（用户覆盖） > blockchain/compose.env（由 protocol.json 生成，npm run protocol:render）
function Import-EnvDefaults([string]$path) {
  if (-not (Test-Path $path)) { return }
  foreach ($line in Get-Content $path) {
    if ($line -match '^\s*($|#)') { continue }
    $k, $v = $line -split '=', 2
    if (-not (Get-Item "env:$k" -ErrorAction SilentlyContinue)) { Set-Item "env:$k" $v }
  }
}
Import-EnvDefaults '.env'
Import-EnvDefaults 'blockchain/compose.env'
if (-not $env:KARMACHAIN_RPC_PORT) { Write-Error "blockchain/compose.env missing or incomplete — run 'npm run protocol:render'"; exit 10 }
$timeout = [int]$env:KARMACHAIN_STARTUP_TIMEOUT
$hostPort = $env:KARMACHAIN_RPC_PORT
$readyMark = 'KarmaChain local devnet is READY'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error 'devnet-start: docker not found — install Docker Desktop (WSL2 backend)'; exit 10
}
docker info *> $null; if ($LASTEXITCODE -ne 0) { Write-Error 'devnet-start: Docker daemon is not running'; exit 10 }
docker compose version *> $null; if ($LASTEXITCODE -ne 0) { Write-Error "devnet-start: 'docker compose' (v2) not available"; exit 10 }

# 只看本次启动之后的日志（容器重启后 `compose logs` 仍含上一轮的 READY 标记）
$since = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
function Get-DevnetLogs { (docker compose logs --no-log-prefix --since $since devnet 2>$null) -join "`n" }

$out = docker compose up -d devnet 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  Write-Host $out
  if ($out -match 'port is already allocated|address already in use|bind: ') {
    Write-Error "devnet-start: FAILED [category: configuration] host port $hostPort is already in use — stop the other process or set KARMACHAIN_RPC_PORT in .env"; exit 11
  }
  Write-Error 'devnet-start: FAILED [category: node] docker compose up failed'; exit 20
}

$sw = [Diagnostics.Stopwatch]::StartNew()
while ($true) {
  $logs = Get-DevnetLogs
  if ($logs -match [regex]::Escape($readyMark)) {
    $idx = $logs.IndexOf($readyMark)
    Write-Host $logs.Substring($idx)
    exit 0
  }
  $state = docker inspect --format '{{.State.Status}}' karmachain-devnet 2>$null
  if ($state -eq 'exited' -or $state -eq 'dead') {
    $code = [int](docker inspect --format '{{.State.ExitCode}}' karmachain-devnet 2>$null)
    ($logs -split "`n" | Select-Object -Last 30) | ForEach-Object { Write-Host $_ }
    Write-Error "devnet-start: container exited with code $code (see scripts/devnet-logs)"
    if ($code -in 10, 11, 12, 20) { exit $code } else { exit 20 }
  }
  if ($sw.Elapsed.TotalSeconds -ge $timeout) {
    ($logs -split "`n" | Select-Object -Last 30) | ForEach-Object { Write-Host $_ }
    Write-Error "devnet-start: FAILED [category: node] not READY within ${timeout}s (KARMACHAIN_STARTUP_TIMEOUT)"; exit 20
  }
  Start-Sleep -Seconds 2
}
