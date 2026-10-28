# watching-bot Windows 服务运行器(由计划任务 watching-bot 在登录时启动)。
# 直接跑 Node + tsx,崩了 5 秒后自动重启;PID 写到 data/service.pid 供卸载脚本整棵进程树结束。
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
New-Item -ItemType Directory -Force -Path data | Out-Null

$log = Join-Path $Root "data\service.log"
$pidFile = Join-Path $Root "data\service.pid"
$current = $null

try {
    while ($true) {
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        "[$stamp] starting watching-bot" | Out-File -FilePath $log -Append -Encoding utf8
        $cmd = "node --env-file-if-exists=.env --import tsx src/index.ts >> `"$log`" 2>&1"
        $current = Start-Process -FilePath "cmd.exe" -ArgumentList @("/d", "/s", "/c", $cmd) `
            -WorkingDirectory $Root -PassThru -WindowStyle Hidden
        $current.Id | Set-Content -Path $pidFile -Encoding ascii
        Wait-Process -Id $current.Id -ErrorAction SilentlyContinue
        $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        "[$stamp] exited code=$($current.ExitCode); restarting in 5s" | Out-File -FilePath $log -Append -Encoding utf8
        Start-Sleep -Seconds 5
    }
} finally {
    if ($current -and -not $current.HasExited) {
        & taskkill /PID $current.Id /T /F 2>$null | Out-Null
    }
}
