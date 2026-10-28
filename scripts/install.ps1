# watching-bot 一键安装(Windows):Node 直跑 + 登录自启计划任务。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -ApiKey sk-... -PanelToken mypass
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -SkipService -NoStart
param(
    [string]$ApiKey = "",
    [string]$PanelToken = "",
    [switch]$SkipService,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$TaskName = "watching-bot"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }

function Get-EnvValue([string]$name) {
    if (-not (Test-Path .env)) { return "" }
    $line = Get-Content .env | Where-Object { $_ -match "^$([regex]::Escape($name))=" } | Select-Object -Last 1
    if (-not $line) { return "" }
    return ($line -replace "^$([regex]::Escape($name))=", "").Trim()
}

function Set-EnvValue([string]$name, [string]$value) {
    $lines = @()
    if (Test-Path .env) { $lines = @(Get-Content .env) }
    $pattern = "^$([regex]::Escape($name))="
    $found = $false
    $next = foreach ($line in $lines) {
        if ($line -match $pattern) {
            $found = $true
            "$name=$value"
        } else {
            $line
        }
    }
    if (-not $found) { $next = @($next) + @("$name=$value") }
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines((Join-Path $Root ".env"), [string[]]$next, $utf8)
}

function Stop-ServiceProcess {
    $pidFile = Join-Path $Root "data\service.pid"
    if (-not (Test-Path $pidFile)) { return }
    $servicePid = (Get-Content $pidFile -Raw).Trim()
    if ($servicePid -notmatch "^\d+$") { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; return }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid" -ErrorAction SilentlyContinue
    if ($proc -and ($proc.CommandLine -like "*src/index.ts*" -or $proc.CommandLine -like "*service-run*")) {
        & taskkill /PID $servicePid /T /F 2>$null | Out-Null
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

function New-RandomToken {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
}

Write-Step "检查 Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw "未找到 Node.js。请先安装 Node.js >= 22.19(https://nodejs.org/)后重试。"
}
$versionText = (& node --version).Trim().TrimStart("v")
if ([version]$versionText -lt [version]"22.19.0") {
    throw "Node.js 版本过低: $versionText(需要 >= 22.19.0)"
}
Write-Host "    Node $versionText"

# npm ci 会替换 better-sqlite3 的 .node;必须先停掉正在占用它的服务
Write-Step "停止已有服务(如果存在)"
$runningTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($runningTask) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}
Stop-ServiceProcess

# 旧版本把 SnowLuma 也注册成了独立自启;现在只保留 watching-bot,
# QQ / SnowLuma 由主框架里的 runtime 插件按 data/runtime.json 唤醒。
$legacySnow = Get-ScheduledTask -TaskName "snowluma" -ErrorAction SilentlyContinue
if ($legacySnow) {
    Stop-ScheduledTask -TaskName "snowluma" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "snowluma" -Confirm:$false
}
# 旧版 MCP 网关也曾经注册过自启;stdio 模式不再需要
$legacyGateway = Get-ScheduledTask -TaskName "watching-bot-mcp-gateway" -ErrorAction SilentlyContinue
if ($legacyGateway) {
    Stop-ScheduledTask -TaskName "watching-bot-mcp-gateway" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "watching-bot-mcp-gateway" -Confirm:$false
}
Start-Sleep -Seconds 1

Write-Step "安装依赖"
# better-sqlite3 13 在 tarball 里自带 win32/linux 预编译 N-API 二进制;
# 跳过 install script,避免 Node 26 上无 Python/VS 工具链时触发 node-gyp 源码编译。
if (Test-Path package-lock.json) { npm ci --omit=dev --ignore-scripts } else { npm install --omit=dev --ignore-scripts }
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }

Write-Step "准备 .env 与数据目录"
if (-not (Test-Path .env)) {
    Copy-Item .env.example .env
    Write-Host "    已从 .env.example 创建 .env"
}
if (-not $ApiKey) { $ApiKey = Get-EnvValue "WATCHING_BOT_API_KEY" }

# 面板里配置过模型 key 时(data/model.json),不强制 .env 再填一遍
$hasModelKey = $false
if (Test-Path "data\model.json") {
    try {
        $modelCfg = Get-Content "data\model.json" -Raw | ConvertFrom-Json
        if ($modelCfg.apiKey) { $hasModelKey = $true }
    } catch {
        $hasModelKey = $false
    }
}

if (-not $ApiKey -and -not $hasModelKey) {
    $entered = Read-Host "请输入模型 API Key(直接回车可稍后再填)"
    if ($entered) { $ApiKey = $entered.Trim() }
}
if ($ApiKey) { Set-EnvValue "WATCHING_BOT_API_KEY" $ApiKey }

if (-not $PanelToken) { $PanelToken = Get-EnvValue "WATCHING_BOT_PANEL_TOKEN" }
if (-not $PanelToken) {
    $PanelToken = New-RandomToken
    Set-EnvValue "WATCHING_BOT_PANEL_TOKEN" $PanelToken
    Write-Host "    已生成随机面板 token"
}
# supervisor 已移除,清掉旧版遗留值,避免混淆
Set-EnvValue "WATCHING_BOT_SUPERVISOR_TOKEN" ""

foreach ($dir in @("data", "data\memories", "data\modules", "data\plugins")) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

if (-not $ApiKey -and -not $hasModelKey) {
    Write-Warn "WATCHING_BOT_API_KEY 仍为空:服务可以安装,但启动后会拿不到模型。请编辑 .env 或 data/model.json 后重启任务。"
    $NoStart = $true
}

if (-not $SkipService) {
    Write-Step "注册登录自启任务($TaskName)"
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Stop-ServiceProcess
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    $runner = Join-Path $Root "scripts\service-run.ps1"
    $action = New-ScheduledTaskAction `
        -Execute "powershell.exe" `
        -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$runner`"" `
        -WorkingDirectory $Root
    $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -RestartCount 999 `
        -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
        -Description "watching-bot(登录自启,Node 直跑)" -Force | Out-Null

    if (-not $NoStart) {
        Write-Step "启动服务"
        Start-ScheduledTask -TaskName $TaskName
    }
}

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host "  面板:  http://127.0.0.1:9981/?token=$PanelToken"
Write-Host "  日志:  $Root\data\service.log"
Write-Host "  数据:  $Root\data"
if ($SkipService) {
    Write-Host "  前台启动: npm start"
} else {
    Write-Host "  服务:  计划任务 $TaskName(登录自启)"
    Write-Host "  卸载:  powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1"
}
Write-Host ""
Write-Host "  本机组件: 由 runtime 插件按 data/runtime.json 唤醒(QQ / SnowLuma 等)" -ForegroundColor DarkGray
Write-Host "  开机自启只有计划任务 $TaskName;组件随主框架启动,不单独注册。" -ForegroundColor DarkGray
