import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const require = createRequire(import.meta.url);
const png2icons = require("png2icons");

const root = process.cwd();
const source = path.join(root, "docs", "assets", "icon.svg");
const outDir = path.join(root, "build");
const iconsDir = path.join(outDir, "icons");

if (!fs.existsSync(source)) throw new Error(`找不到图标源文件: ${source}`);
fs.mkdirSync(iconsDir, { recursive: true });

const svg = fs.readFileSync(source);
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

for (const size of sizes) {
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(path.join(iconsDir, `${size}x${size}.png`));
}

const png1024 = await sharp(svg, { density: 384 }).resize(1024, 1024).png().toBuffer();
fs.writeFileSync(path.join(outDir, "icon.png"), png1024);

const icoBuffers = await Promise.all(
  [16, 24, 32, 48, 64, 128, 256].map((size) =>
    sharp(svg, { density: 384 }).resize(size, size).png().toBuffer(),
  ),
);
fs.writeFileSync(path.join(outDir, "icon.ico"), await pngToIco(icoBuffers));

const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
if (!icns) throw new Error("生成 ICNS 失败");
fs.writeFileSync(path.join(outDir, "icon.icns"), icns);

console.log("icons written to build/icon.{png,ico,icns} + build/icons/");
