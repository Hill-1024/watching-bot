import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * electron 包在 --ignore-scripts 安装时不会下载二进制。
 * 开发模式启动前补一次下载;打包由 electron-builder 自己下载 Electron。
 */
const root = process.cwd();
const electronDir = path.join(root, "node_modules", "electron");
const marker = path.join(electronDir, "path.txt");

if (existsSync(marker)) process.exit(0);

const installer = path.join(electronDir, "install.js");
if (!existsSync(installer)) {
  console.error("[electron] 没有安装 electron 包,请先 npm ci --ignore-scripts");
  process.exit(1);
}

console.log("[electron] 下载 Electron 二进制(首次运行需要网络)…");
const result = spawnSync(process.execPath, [installer], {
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/",
  },
});
process.exit(result.status ?? 1);
