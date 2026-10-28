/**
 * electron-builder afterPack:
 * extraResources 的默认过滤会跳过 node_modules,这里把生产依赖补到 resources/server。
 * 后端由内置 Node 执行,依赖必须在 asar 外、且保持真实目录结构。
 */
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const resourcesDir =
    process.platform === "darwin"
      ? path.join(context.appOutDir, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const source = path.join(process.cwd(), "build", "server", "node_modules");
  const target = path.join(resourcesDir, "server", "node_modules");
  if (!fs.existsSync(source)) {
    throw new Error(`afterPack: 缺少 ${source},请先运行 npm run prepare:server`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  if (!fs.existsSync(path.join(target, "tsx", "dist", "cli.mjs"))) {
    throw new Error("afterPack: server/node_modules 里没有 tsx");
  }
};
