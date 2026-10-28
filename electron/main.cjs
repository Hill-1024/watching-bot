const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
  clipboard,
} = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

/**
 * watching-bot 桌面壳。
 *
 * - Electron 只负责窗口/托盘/自启/进程托管,业务仍然是原来的 Node 后端;
 * - 后端绑定 127.0.0.1 的随机端口,并使用每次启动生成的 token;
 * - 壳内窗口自动带 token 打开面板,壳外浏览器访问必须自己填 token;
 * - 用户数据(config/persona/data/.env/日志)放在 app.getPath("userData"),不写安装目录。
 */

const APP_ID = "ai.watching.bot";
const DEFAULT_PORT = 9981;
const IS_WIN = process.platform === "win32";

app.setName("watching-bot");
app.setAppUserModelId(APP_ID);

const repoRoot = path.resolve(__dirname, "..");
const isPackaged = app.isPackaged;
const serverRoot = isPackaged ? path.join(process.resourcesPath, "server") : repoRoot;
const userData = process.env.WATCHING_BOT_DESKTOP_DATA
  ? path.resolve(process.env.WATCHING_BOT_DESKTOP_DATA)
  : app.getPath("userData");
const configDir = path.join(userData, "config");
const personaDir = path.join(userData, "persona");
const logDir = path.join(userData, "logs");
const envFile = path.join(userData, ".env");
const configFile = path.join(configDir, "default.json");
const personaFile = path.join(personaDir, "persona.md");
const logFile = path.join(logDir, "desktop.log");
const autostartMarker = path.join(userData, ".desktop-autostart-initialized");

let backend = null;
let backendLog = null;
let backendRestarts = 0;
let restartTimer = null;
let restarting = false;
let quitting = false;
let win = null;
let tray = null;
let panelPort = 0;
let panelToken = "";
const startHidden = process.argv.includes("--hidden");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  app.whenReady().then(bootstrap).catch(failStartup);
  app.on("activate", () => showWindow());
  app.on("before-quit", () => {
    quitting = true;
    void stopBackend();
  });
  // 关窗只隐藏到托盘;真正退出走托盘菜单
  app.on("window-all-closed", () => {});
}

// ---------- 启动 ----------

async function bootstrap() {
  seedUserData();
  panelToken = (process.env.WATCHING_BOT_DESKTOP_TOKEN || "").trim() || crypto.randomBytes(32).toString("hex");
  panelPort = await findFreePort(readConfigPort());
  openLog();

  createWindow();
  createTray();
  startBackend();

  await waitForBackend();
  loadDashboard();
  initAutoStart();
}

function failStartup(err) {
  const message = err instanceof Error ? err.message : String(err);
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] startup failed: ${message}\n`);
  } catch {
    // 日志也写不了就只弹窗
  }
  dialog.showErrorBox("watching-bot 启动失败", `${message}\n\n日志: ${logFile}`);
  app.quit();
}

function seedUserData() {
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(personaDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  for (const dir of ["data", "data/memories", "data/modules", "data/plugins"]) {
    fs.mkdirSync(path.join(userData, dir), { recursive: true });
  }

  const configSource = path.join(serverRoot, "config", "default.json");
  if (!fs.existsSync(configSource)) throw new Error(`找不到默认配置: ${configSource}`);
  copyIfMissing(configSource, configFile);

  const personaSource = path.join(serverRoot, "persona", "persona.md");
  if (!fs.existsSync(personaSource)) throw new Error(`找不到人设文件: ${personaSource}`);
  copyIfMissing(personaSource, personaFile);

  if (!fs.existsSync(envFile)) {
    const envExample = path.join(serverRoot, ".env.example");
    if (fs.existsSync(envExample)) fs.copyFileSync(envExample, envFile);
    else fs.writeFileSync(envFile, "", "utf-8");
  }
}

function copyIfMissing(from, to) {
  if (fs.existsSync(to)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// ---------- 端口 / token ----------

function readConfigPort() {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    const port = cfg?.panel?.port;
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    // 配置坏了就走默认端口;后端启动时会给出更明确的错误
  }
  return DEFAULT_PORT;
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const finish = (ok) => {
      server.removeAllListeners();
      try {
        server.close(() => resolve(ok));
      } catch {
        resolve(ok);
      }
    };
    server.once("error", () => finish(false));
    server.listen(port, "127.0.0.1", () => finish(true));
  });
}

async function findFreePort(start) {
  for (let port = start; port < start + 80; port++) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`在 ${start}-${start + 80} 之间找不到空闲端口`);
}

function webuiUrl(withToken = true) {
  const base = `http://127.0.0.1:${panelPort}/`;
  return withToken ? `${base}?token=${encodeURIComponent(panelToken)}` : base;
}

// ---------- 后端 sidecar ----------

function resolveNodeBinary() {
  if (process.env.WATCHING_BOT_DESKTOP_NODE) return process.env.WATCHING_BOT_DESKTOP_NODE;
  if (!isPackaged) return process.env.WATCHING_BOT_NODE || "node";
  const binary = IS_WIN
    ? path.join(process.resourcesPath, "runtime", "node", "node.exe")
    : path.join(process.resourcesPath, "runtime", "node", "bin", "node");
  if (!fs.existsSync(binary)) throw new Error(`打包内缺少 Node 运行时: ${binary}`);
  return binary;
}

function resolveTsxCli() {
  const cli = path.join(serverRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(cli)) throw new Error(`找不到 tsx: ${cli}`);
  return cli;
}

function backendEnv() {
  const env = {
    ...process.env,
    WATCHING_BOT_CONFIG: configFile,
    WATCHING_BOT_PLUGINS_DIR: path.join(serverRoot, "plugins"),
    WATCHING_BOT_PERSONA_FILE: personaFile,
    WATCHING_BOT_WEB_DIR: path.join(serverRoot, "src", "web", "public"),
    WATCHING_BOT_PANEL_PORT: String(panelPort),
    WATCHING_BOT_PANEL_HOST: "127.0.0.1",
    WATCHING_BOT_PANEL_TOKEN: panelToken,
    WATCHING_BOT_DESKTOP: "1",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function openLog() {
  fs.mkdirSync(logDir, { recursive: true });
  backendLog = fs.createWriteStream(logFile, { flags: "a" });
}

function logLine(line) {
  const text = `[${new Date().toISOString()}] ${line}\n`;
  backendLog?.write(text);
  if (!isPackaged) process.stdout.write(text);
}

function startBackend() {
  if (backend || quitting) return;
  const node = resolveNodeBinary();
  const tsx = resolveTsxCli();
  const entry = path.join(serverRoot, "src", "index.ts");
  logLine(`[backend] starting ${node} (port ${panelPort}, cwd ${userData})`);

  const child = spawn(node, ["--env-file-if-exists=.env", tsx, entry], {
    cwd: userData,
    env: backendEnv(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  backend = child;

  child.stdout?.setEncoding("utf-8");
  child.stderr?.setEncoding("utf-8");
  child.stdout?.on("data", (chunk) => backendLog?.write(chunk));
  child.stderr?.on("data", (chunk) => {
    backendLog?.write(chunk);
    if (!isPackaged) process.stderr.write(chunk);
  });

  child.once("error", (err) => {
    logLine(`[backend] spawn error: ${err.message}`);
    backend = null;
    scheduleRestart();
  });
  child.once("exit", (code, signal) => {
    logLine(`[backend] exited code=${code ?? "-"} signal=${signal ?? "-"}`);
    backend = null;
    if (!quitting && !restarting) scheduleRestart();
  });
}

function scheduleRestart() {
  if (quitting || restartTimer) return;
  backendRestarts += 1;
  const delay = Math.min(10_000, Math.round(1000 * Math.pow(1.6, Math.min(backendRestarts, 5))));
  logLine(`[backend] restart in ${delay}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    try {
      startBackend();
    } catch (err) {
      logLine(`[backend] restart failed: ${err instanceof Error ? err.message : String(err)}`);
      scheduleRestart();
      return;
    }
    waitForBackend()
      .then(() => loadDashboard())
      .catch((err) => logLine(`[backend] still not ready: ${err.message}`));
  }, delay);
  restartTimer.unref?.();
}

function waitForBackend(timeoutMs = 90_000) {
  const url = `http://127.0.0.1:${panelPort}/api/status`;
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (quitting) throw new Error("应用正在退出");
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${panelToken}` } });
        if (res.ok) return;
      } catch {
        // 还没起来
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    throw new Error(`后台启动超时,请查看日志: ${logFile}`);
  })();
}

function stopBackend() {
  return new Promise((resolve) => {
    const child = backend;
    backend = null;
    if (!child) return resolve();
    restarting = true;
    const done = () => {
      restarting = false;
      resolve();
    };
    child.once("exit", done);
    try {
      if (IS_WIN) {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {
      try {
        child.kill("SIGTERM");
      } catch {
        // 已经退出了
      }
    }
    const timer = setTimeout(done, 3000);
    timer.unref?.();
  });
}

async function restartBackend() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  await stopBackend();
  backendRestarts = 0;
  startBackend();
  await waitForBackend();
  loadDashboard();
}

// ---------- 窗口 / 托盘 ----------

function iconPath() {
  if (isPackaged) return path.join(process.resourcesPath, "icon.png");
  return path.join(repoRoot, "build", "icon.png");
}

function createWindow() {
  if (win && !win.isDestroyed()) return win;
  const icon = iconPath();
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: "#0b0e13",
    title: "watching-bot",
    icon: fs.existsSync(icon) ? icon : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "loading.html"));
  win.once("ready-to-show", () => {
    if (!startHidden) win.show();
  });
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
  win.on("closed", () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const base = `http://127.0.0.1:${panelPort}`;
    if (!url.startsWith(base)) {
      event.preventDefault();
      if (/^https?:/i.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    logLine(`[window] renderer gone: ${details.reason}`);
  });
  return win;
}

function loadDashboard() {
  if (!win || win.isDestroyed()) return;
  const url = webuiUrl(true);
  logLine(`[window] loading ${webuiUrl(false)}`);
  void win.loadURL(url);
  if (!startHidden) {
    win.show();
    win.focus();
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return;
  const icon = iconPath();
  let image = nativeImage.createEmpty();
  if (fs.existsSync(icon)) {
    const loaded = nativeImage.createFromPath(icon);
    if (!loaded.isEmpty()) image = loaded.resize({ width: 32, height: 32 });
  }
  tray = new Tray(image);
  tray.setToolTip(`watching-bot · ${webuiUrl(false)}`);
  tray.on("double-click", showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: "打开面板", click: showWindow },
    { label: "重新加载界面", click: () => win?.reload() },
    {
      label: "重启后台",
      click: () => {
        void restartBackend().catch((err) => {
          dialog.showErrorBox("重启后台失败", err instanceof Error ? err.message : String(err));
        });
      },
    },
    { type: "separator" },
    {
      label: "复制壳外访问地址(含 token)",
      click: () => {
        clipboard.writeText(webuiUrl(true));
      },
    },
    {
      label: "显示 WebUI token",
      click: () => {
        dialog.showMessageBox({
          type: "info",
          title: "WebUI 访问 token",
          message: "壳外浏览器访问需要这个 token",
          detail: `地址: ${webuiUrl(false)}\ntoken: ${panelToken}`,
          buttons: ["复制地址", "关闭"],
          defaultId: 0,
          cancelId: 1,
        }).then(({ response }) => {
          if (response === 0) clipboard.writeText(webuiUrl(true));
        });
      },
    },
    {
      label: "打开数据目录",
      click: () => {
        void shell.openPath(userData);
      },
    },
    { type: "separator" },
    {
      label: "开机自启",
      type: "checkbox",
      checked: loginItemEnabled(),
      click: (item) => {
        setLoginItem(item.checked);
        refreshTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "退出 watching-bot",
      click: () => {
        quitting = true;
        void stopBackend();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---------- 开机自启(整个 App 是唯一入口) ----------

function linuxAutostartFile() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "autostart", "watching-bot.desktop");
}

function loginItemEnabled() {
  if (process.platform === "linux") return fs.existsSync(linuxAutostartFile());
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

function setLoginItem(enabled) {
  if (process.platform === "linux") {
    const file = linuxAutostartFile();
    if (!enabled) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // ignore
      }
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exec = process.env.APPIMAGE || process.execPath;
    fs.writeFileSync(
      file,
      [
        "[Desktop Entry]",
        "Type=Application",
        "Name=watching-bot",
        `Exec="${exec}" --hidden`,
        "Terminal=false",
        "X-GNOME-Autostart-enabled=true",
        "",
      ].join("\n"),
      "utf-8",
    );
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: true,
    args: ["--hidden"],
  });
}

function initAutoStart() {
  if (!isPackaged) return;
  // 首次运行默认开启;用户之后在托盘里关掉不会被重新打开
  if (fs.existsSync(autostartMarker)) return;
  try {
    setLoginItem(true);
    fs.writeFileSync(autostartMarker, new Date().toISOString(), "utf-8");
    refreshTrayMenu();
  } catch (err) {
    logLine(`[autostart] 设置失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}
