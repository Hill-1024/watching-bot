import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * 本地 Electron dev 启动器:
 * - 后端数据直接用仓库根目录(共享 data/config/persona/.env)
 * - 不注册开机自启、不安装系统服务(仅 app.isPackaged 时才注册)
 * - 默认固定 dev token,方便壳外浏览器调试
 */
const require = createRequire(import.meta.url);
const root = process.cwd();

let electronPath;
try {
  electronPath = require("electron");
} catch {
  console.error("没有安装 electron,请先 npm ci --ignore-scripts && npm run electron:install");
  process.exit(1);
}
if (!electronPath || !existsSync(electronPath)) {
  console.error("Electron 二进制不存在,请先 npm run electron:install");
  process.exit(1);
}

const env = {
  ...process.env,
  WATCHING_BOT_DESKTOP_DATA: process.env.WATCHING_BOT_DESKTOP_DATA || root,
  WATCHING_BOT_DESKTOP_TOKEN: process.env.WATCHING_BOT_DESKTOP_TOKEN || "develectron123",
};
const port = process.env.ELECTRON_DEBUG_PORT || "9225";
const args = [".", `--remote-debugging-port=${port}`, ...process.argv.slice(2)];

console.log(`[dev-electron] data=${env.WATCHING_BOT_DESKTOP_DATA}`);
console.log(`[dev-electron] token=${env.WATCHING_BOT_DESKTOP_TOKEN}`);
console.log(`[dev-electron] devtools=http://127.0.0.1:${port}`);

const child = spawn(electronPath, args, { cwd: root, env, stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
