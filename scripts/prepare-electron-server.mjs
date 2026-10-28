import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * 准备 Electron 的 server sidecar 目录:
 * build/server 只包含运行后端需要的源码、插件、配置、人设与生产依赖。
 * 打包时由 electron-builder extraResources 原样放进 resources/server。
 */

const root = process.cwd();
const out = path.join(root, "build", "server");

if (!existsSync(path.join(root, "package-lock.json"))) {
  throw new Error("缺少 package-lock.json,无法做可复现的生产依赖安装");
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const dir of ["src", "plugins", "config", "persona"]) {
  cpSync(path.join(root, dir), path.join(out, dir), { recursive: true });
}
for (const file of ["package.json", "package-lock.json", ".env.example"]) {
  const from = path.join(root, file);
  if (existsSync(from)) copyFileSync(from, path.join(out, file));
}

console.log("[prepare] installing production dependencies in build/server ...");
const result = spawnSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: out,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, npm_config_update_notifier: "false" },
});
if (result.status !== 0) throw new Error(`build/server 依赖安装失败(code ${result.status})`);

for (const required of [
  "node_modules/tsx/dist/cli.mjs",
  "node_modules/better-sqlite3/prebuilds",
  "src/index.ts",
  "plugins/runtime/server/index.ts",
  "config/default.json",
  "persona/persona.md",
]) {
  if (!existsSync(path.join(out, required))) throw new Error(`build/server 缺少 ${required}`);
}

console.log("[prepare] server payload ready: build/server");
