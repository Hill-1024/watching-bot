import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

/**
 * 下载目标平台的 Node 运行时到 build/node,供 Electron 资源目录内置。
 * 环境变量:
 *   NODE_RUNTIME_VERSION  默认 22.19.0
 *   NODE_RUNTIME_PLATFORM 默认 process.platform(win32/linux/darwin)
 *   NODE_RUNTIME_ARCH     默认 process.arch(x64/arm64)
 */

const version = process.env.NODE_RUNTIME_VERSION ?? "22.19.0";
const platform = process.env.NODE_RUNTIME_PLATFORM ?? process.platform;
const arch = process.env.NODE_RUNTIME_ARCH ?? process.arch;

if (!["win32", "linux", "darwin"].includes(platform)) throw new Error(`不支持的平台: ${platform}`);
if (!["x64", "arm64"].includes(arch)) throw new Error(`不支持的架构: ${arch}`);

const extension = platform === "win32" ? "zip" : platform === "linux" ? "tar.xz" : "tar.gz";
const distPlatform = platform === "win32" ? "win" : platform;
const folder = `node-v${version}-${distPlatform}-${arch}`;
const mirror = (process.env.NODE_RUNTIME_MIRROR ?? "https://nodejs.org/dist").replace(/\/+$/, "");
const url = `${mirror}/v${version}/${folder}.${extension}`;

const root = process.cwd();
const downloadDir = path.join(root, "build");
const archive = path.join(downloadDir, `node-runtime.${extension}`);
const temp = path.join(downloadDir, "node-tmp");
const target = path.join(downloadDir, "node");

mkdirSync(downloadDir, { recursive: true });
rmSync(temp, { recursive: true, force: true });
rmSync(target, { recursive: true, force: true });

console.log(`[node-runtime] downloading ${url}`);
const response = await fetch(url, { redirect: "follow" });
if (!response.ok) throw new Error(`下载 Node 运行时失败: HTTP ${response.status}`);
writeFileSync(archive, Buffer.from(await response.arrayBuffer()));

mkdirSync(temp, { recursive: true });
const extract =
  platform === "win32"
    ? spawnSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${temp.replace(/'/g, "''")}' -Force`], { stdio: "inherit" })
    : spawnSync("tar", ["-xf", archive, "-C", temp], { stdio: "inherit" });
if (extract.status !== 0) throw new Error(`解压 Node 运行时失败(code ${extract.status})`);

const extracted = path.join(temp, folder);
if (!existsSync(extracted)) throw new Error(`解压目录不符合预期: ${extracted}`);
cpSync(extracted, target, { recursive: true });

const binary = platform === "win32" ? path.join(target, "node.exe") : path.join(target, "bin", "node");
if (!existsSync(binary)) throw new Error(`Node 运行时缺少可执行文件: ${binary}`);
if (platform !== "win32") chmodSync(binary, 0o755);

rmSync(temp, { recursive: true, force: true });
rmSync(archive, { force: true });
console.log(`[node-runtime] ready: ${binary}`);
