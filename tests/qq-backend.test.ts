import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadQqBackend, saveQqBackend } from "../src/qq-backend.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-qq-backend-"));
  dirs.push(dir);
  return join(dir, "qq-backend.json");
}

describe("QQ backend selection", () => {
  it("没有选择文件时默认 NapCat", () => {
    expect(loadQqBackend(tempFile())).toBe("napcat");
  });

  it("保存 SnowLuma 后可重新读取,损坏/未知值回到 NapCat", () => {
    const path = tempFile();
    saveQqBackend("snowluma", path);
    expect(loadQqBackend(path)).toBe("snowluma");

    writeFileSync(path, JSON.stringify({ backend: "unknown" }), "utf-8");
    expect(loadQqBackend(path)).toBe("napcat");

    writeFileSync(path, "{broken", "utf-8");
    expect(loadQqBackend(path)).toBe("napcat");
  });
});
