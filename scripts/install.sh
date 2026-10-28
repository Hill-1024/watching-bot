#!/usr/bin/env bash
# watching-bot 一键安装(Linux / macOS):Node 直跑 + 服务化。
#
# 用法:
#   bash scripts/install.sh
#   bash scripts/install.sh --api-key sk-... --panel-token mypass
#   bash scripts/install.sh --skip-service
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
chmod +x "$ROOT/scripts/service-run.sh" 2>/dev/null || true

API_KEY=""
PANEL_TOKEN=""
SKIP_SERVICE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --api-key) API_KEY="${2:-}"; shift 2 ;;
    --panel-token) PANEL_TOKEN="${2:-}"; shift 2 ;;
    --skip-service) SKIP_SERVICE=1; shift ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *) echo "未知参数: $1" >&2; exit 1 ;;
  esac
done

step() { printf '\033[36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[33m!!  %s\033[0m\n' "$1"; }

step "检查 Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js >= 22.19(https://nodejs.org/)后重试。" >&2
  exit 1
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22 || (a===22 && b>=19) ? 0 : 1)' || {
  echo "Node.js 版本过低: $(node --version)(需要 >= 22.19.0)" >&2
  exit 1
}
echo "    Node $(node --version)"

step "停止已有服务(如果存在)"
if command -v systemctl >/dev/null 2>&1; then
  systemctl --user stop watching-bot >/dev/null 2>&1 || true
fi

step "安装依赖"
# better-sqlite3 13 自带预编译 N-API 二进制,跳过 install script 可避免无 Python 时触发源码编译
if [ -f package-lock.json ]; then npm ci --omit=dev --ignore-scripts; else npm install --omit=dev --ignore-scripts; fi

step "准备 .env 与数据目录"
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    已从 .env.example 创建 .env"
fi

set_env() {
  local key="$1" value="$2"
  node - "$key" "$value" <<'NODE'
const fs = require("fs");
const [key, value] = process.argv.slice(2);
let text = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8") : "";
const line = `${key}=${value}`;
const re = new RegExp(`^${key}=.*$`, "m");
text = re.test(text) ? text.replace(re, line) : (text && !text.endsWith("\n") ? `${text}\n` : text) + `${line}\n`;
fs.writeFileSync(".env", text);
NODE
}

get_env() {
  if [ ! -f .env ]; then return 0; fi
  grep -E "^$1=" .env | tail -n 1 | sed -E "s/^$1=//" || true
}

if [ -z "$API_KEY" ]; then API_KEY="$(get_env WATCHING_BOT_API_KEY)"; fi

# 面板里配置过模型 key 时(data/model.json),不强制 .env 再填一遍
HAS_MODEL_KEY=0
if [ -f data/model.json ] && node -e 'const m=require("./data/model.json"); process.exit(m && m.apiKey ? 0 : 1)' 2>/dev/null; then
  HAS_MODEL_KEY=1
fi

if [ -z "$API_KEY" ] && [ "$HAS_MODEL_KEY" -eq 0 ] && [ -t 0 ]; then
  read -r -p "请输入模型 API Key(直接回车可稍后再填): " API_KEY || true
fi
if [ -n "$API_KEY" ]; then set_env WATCHING_BOT_API_KEY "$API_KEY"; fi

if [ -z "$PANEL_TOKEN" ]; then PANEL_TOKEN="$(get_env WATCHING_BOT_PANEL_TOKEN)"; fi
if [ -z "$PANEL_TOKEN" ]; then
  PANEL_TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  set_env WATCHING_BOT_PANEL_TOKEN "$PANEL_TOKEN"
  echo "    已生成随机面板 token"
fi
set_env WATCHING_BOT_SUPERVISOR_TOKEN ""

mkdir -p data/memories data/modules data/plugins

if [ -z "$API_KEY" ] && [ "$HAS_MODEL_KEY" -eq 0 ]; then
  warn "WATCHING_BOT_API_KEY 仍为空:服务可以安装,但启动后拿不到模型。请编辑 .env 或 data/model.json 后重启服务。"
fi

if [ "$SKIP_SERVICE" -eq 1 ]; then
  step "跳过服务安装"
else
  case "$(uname -s)" in
    Linux)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        step "安装 systemd user 服务"
        UNIT_DIR="$HOME/.config/systemd/user"
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT_DIR/watching-bot.service" <<EOF
[Unit]
Description=watching-bot (Node)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
ExecStart=$ROOT/scripts/service-run.sh
Restart=on-failure
RestartSec=5
KillMode=control-group

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now watching-bot
        if ! loginctl enable-linger "$USER" 2>/dev/null; then
          warn "无法启用 linger:注销后服务会停止。可手动执行: sudo loginctl enable-linger $USER"
        fi
      else
        warn "当前环境没有可用的 systemd user 会话,跳过服务安装。前台启动: npm start"
      fi
      ;;
    Darwin)
      step "安装 launchd 服务"
      PLIST="$HOME/Library/LaunchAgents/com.watching-bot.plist"
      mkdir -p "$(dirname "$PLIST")"
      cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.watching-bot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT/scripts/service-run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$ROOT/data/launchd.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/launchd.err.log</string>
</dict>
</plist>
EOF
      launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
      launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"
      ;;
    *)
      warn "未识别的系统,跳过服务安装。前台启动: npm start"
      ;;
  esac
fi

echo
printf '\033[32m安装完成。\033[0m\n'
echo "  面板:  http://127.0.0.1:9981/?token=$PANEL_TOKEN"
echo "  日志:  $ROOT/data/service.log"
echo "  数据:  $ROOT/data"
if [ "$SKIP_SERVICE" -eq 1 ]; then
  echo "  前台启动: npm start"
else
  echo "  卸载:  bash scripts/uninstall.sh"
fi
echo
echo "QQ 运行时(NapCat / SnowLuma)需要单独下载并以本机进程启动;"
echo "在它的 WebUI 里启用 OneBot v11 WebSocket 服务器(127.0.0.1:3001)即可。"
