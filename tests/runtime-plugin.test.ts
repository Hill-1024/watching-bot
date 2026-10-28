import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import start from "../plugins/runtime/server/index.js";
import { JsonPluginStorage } from "../src/plugins/storage.js";
import type { PluginContext } from "../src/plugins/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wb-runtime-"));
  dirs.push(dir);
  return dir;
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function ctxFor(dir: string): PluginContext {
  return {
    id: "runtime",
    manifest: { schemaVersion: 1, id: "runtime", name: "Runtime", version: "1", description: "", entry: "" },
    config: { overrideFile: join(dir, "runtime.json"), ensureIntervalMs: 5000, components: [] },
    dataDir: dir,
    simNow: () => Date.now(),
    realNow: () => Date.now(),
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    storage: new JsonPluginStorage(join(dir, "store.json")),
    emitPerception: () => {},
  };
}

describe("runtime 插件:本机组件唤醒", () => {
  it("按配置拉起组件、探测端口并在 stop 时结束进程", async () => {
    const dir = tempDir();
    const port = await freePort();
    writeFileSync(
      join(dir, "runtime.json"),
      JSON.stringify({
        ensureIntervalMs: 5000,
        components: [
          {
            id: "dummy",
            command: process.execPath,
            args: ["-e", `require("net").createServer().listen(${port},"127.0.0.1")`],
            check: { port },
            stopOnExit: true,
          },
        ],
      }),
    );

    const plugin = await start(ctxFor(dir));
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        await new Promise((r) => setTimeout(r, 100));
        up = await portOpen(port);
      }
      expect(up).toBe(true);

      const view = (await plugin.handle!({ method: "GET", path: "", query: {}, body: null })) as {
        body: { components: { id: string; status: string }[] };
      };
      expect(view.body.components[0]).toMatchObject({ id: "dummy", status: "running" });
      expect(plugin.status?.()).toMatchObject({ status: "ready" });
    } finally {
      await plugin.stop();
    }

    let closed = false;
    for (let i = 0; i < 40 && !closed; i++) {
      await new Promise((r) => setTimeout(r, 100));
      closed = !(await portOpen(port));
    }
    expect(closed).toBe(true);
  });
});
