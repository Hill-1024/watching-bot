#!/usr/bin/env bash
# WebUI-only 远程安装引导:克隆/更新仓库后交给 scripts/install.sh。
#   curl -fsSL https://raw.githubusercontent.com/Hill-1024/watching-bot/main/scripts/install-remote.sh | bash
set -euo pipefail

REPO="${WATCHING_BOT_REPO:-https://github.com/Hill-1024/watching-bot.git}"
DIR="${WATCHING_BOT_HOME:-$HOME/.watching-bot}"

if ! command -v git >/dev/null 2>&1; then
  echo "需要 git:请先安装 git 后重试" >&2
  exit 1
fi

if [ -d "$DIR/.git" ]; then
  echo "==> 更新 $DIR"
  git -C "$DIR" pull --ff-only
else
  echo "==> 克隆到 $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR"
fi

exec bash "$DIR/scripts/install.sh" "$@"
