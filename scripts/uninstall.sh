#!/usr/bin/env bash
# watching-bot 一键卸载(Linux / macOS)。
# 默认保留 data/、config/、.env;加 --purge 才会连 node_modules、data、.env 一起删掉。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }

case "$(uname -s)" in
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      step "停止 systemd user 服务"
      systemctl --user disable --now watching-bot >/dev/null 2>&1 || true
      rm -f "$HOME/.config/systemd/user/watching-bot.service"
      systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    ;;
  Darwin)
    PLIST="$HOME/Library/LaunchAgents/com.watching-bot.plist"
    step "停止 launchd 服务"
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || launchctl unload "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
    ;;
esac

if [ "$PURGE" -eq 1 ]; then
  step "清理依赖与数据(--purge)"
  rm -rf node_modules data .env
  echo "已删除 node_modules / data / .env"
else
  echo "已保留 data/、config/、.env(要彻底清理请加 --purge)"
fi

echo
printf '\033[32m卸载完成。\033[0m\n'
