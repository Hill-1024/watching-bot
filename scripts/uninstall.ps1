# watching-bot 一键卸载(Windows)。
#
# 默认保留 data/、config/、.env(你的记忆与配置)。
# 加 -Purge 才会连 node_modules、data、.env 一起删掉。
param(
    [switch]$Purge
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$TaskName = "watching-bot"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }

Write-Step "停止计划任务"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

Write-Step "结束进程树"
$pidFile = Join-Path $Root "data\service.pid"
if (Test-Path $pidFile) {
    $servicePid = (Get-Content $pidFile -Raw).Trim()
    if ($servicePid -match "^\d+$") {
        # PID 可能已被系统复用:只在命令行确实是 watching-bot 时才动它
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$servicePid" -ErrorAction SilentlyContinue
        if ($proc -and ($proc.CommandLine -like "*src/index.ts*" -or $proc.CommandLine -like "*service-run*")) {
            & taskkill /PID $servicePid /T /F 2>$null | Out-Null
        }
    }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

if ($task) {
    Write-Step "删除计划任务"
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Step "停止 SnowLuma 任务(如果存在)"
$snowTask = Get-ScheduledTask -TaskName "snowluma" -ErrorAction SilentlyContinue
if ($snowTask) {
    Stop-ScheduledTask -TaskName "snowluma" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "snowluma" -Confirm:$false
}
$legacyGateway = Get-ScheduledTask -TaskName "watching-bot-mcp-gateway" -ErrorAction SilentlyContinue
if ($legacyGateway) {
    Stop-ScheduledTask -TaskName "watching-bot-mcp-gateway" -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName "watching-bot-mcp-gateway" -Confirm:$false
}

$snowPidFile = Join-Path $Root "runtime\snowluma\snowluma.pid"
if (Test-Path $snowPidFile) {
    $snowPid = (Get-Content $snowPidFile -Raw).Trim()
    if ($snowPid -match "^\d+$") {
        $snowProc = Get-CimInstance Win32_Process -Filter "ProcessId=$snowPid" -ErrorAction SilentlyContinue
        if ($snowProc -and ($snowProc.CommandLine -like "*snowluma*" -or $snowProc.CommandLine -like "*index.mjs*")) {
            & taskkill /PID $snowPid /T /F 2>$null | Out-Null
        }
    }
    Remove-Item $snowPidFile -Force -ErrorAction SilentlyContinue
}

if ($Purge) {
    Write-Step "清理依赖与数据(-Purge)"
    foreach ($path in @("node_modules", "data", ".env")) {
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }
    Write-Host "已删除 node_modules / data / .env" -ForegroundColor Yellow
} else {
    Write-Host "已保留 data/、config/、.env(要彻底清理请加 -Purge)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "卸载完成。" -ForegroundColor Green
