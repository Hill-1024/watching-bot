# WebUI-only 远程安装引导(Windows):克隆/更新仓库后交给 scripts/install.ps1。
#   irm https://raw.githubusercontent.com/Hill-1024/watching-bot/main/scripts/install-remote.ps1 | iex
$ErrorActionPreference = "Stop"

$Repo = if ($env:WATCHING_BOT_REPO) { $env:WATCHING_BOT_REPO } else { "https://github.com/Hill-1024/watching-bot.git" }
$Dir = if ($env:WATCHING_BOT_HOME) { $env:WATCHING_BOT_HOME } else { Join-Path $env:LOCALAPPDATA "watching-bot\src" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "需要 git:请先安装 Git for Windows 后重试"
}

if (Test-Path (Join-Path $Dir ".git")) {
    Write-Host "==> 更新 $Dir" -ForegroundColor Cyan
    git -C $Dir pull --ff-only
} else {
    Write-Host "==> 克隆到 $Dir" -ForegroundColor Cyan
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Dir) | Out-Null
    git clone --depth 1 $Repo $Dir
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dir "scripts\install.ps1") @args
