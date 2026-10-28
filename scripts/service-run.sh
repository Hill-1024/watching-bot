#!/usr/bin/env bash
# watching-bot Unix 服务运行器(systemd user / launchd 调用)。
# 直接跑 Node + tsx,崩了 5 秒后自动重启;日志追加到 data/service.log。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p data

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

trap 'kill 0' INT TERM

while true; do
  echo "[service] $(date -Is) starting" >> data/service.log
  code=0
  ./node_modules/.bin/tsx src/index.ts >> data/service.log 2>&1 || code=$?
  echo "[service] $(date -Is) exited code=$code; restarting in 5s" >> data/service.log
  sleep 5
done
