const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const { createDesktopUpdater } = require("./updater.cjs");

const PROTOCOL = "tournament-operator";
const ICON = path.join(__dirname, "..", "build", "icon.ico");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let mainWindow = null;
let pendingAuthUrl = null;
const liveWindows = new Map();
let rendererUpdateContext = { liveMatches: 0, busy: false, dialogOpen: false };

function liveWindowCount() {
  let n = 0;
  for (const win of liveWindows.values()) {
    if (win && !win.isDestroyed()) n += 1;
  }
  return n;
}

function closeLiveWindows() {
  for (const [key, win] of [...liveWindows.entries()]) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      /* ignore */
    }
    liveWindows.delete(key);
  }
}

function sendToMainWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const updater = createDesktopUpdater({
  sendToMainWindow,
  getLiveWindowCount: liveWindowCount,
  closeLiveWindows,
  getRendererContext: () => rendererUpdateContext,
});

function resolveAuthUrl(argv = []) {
  return argv.find((a) => typeof a === "string" && a.startsWith(`${PROTOCOL}://`)) || null;
}

function rendererPrefs() {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function operatorIndex() {
  return path.join(__dirname, "..", "dist", "index.html");
}

function loadOperator(win, hash) {
  const opts = hash ? { hash: String(hash).replace(/^#/, "") } : undefined;
  win.loadFile(operatorIndex(), opts);
}

function denyWindowOpen(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: "Tournament Operator",
    icon: ICON,
    backgroundColor: "#101318",
    autoHideMenuBar: true,
    webPreferences: rendererPrefs(),
  });

  denyWindowOpen(mainWindow.webContents);
  loadOperator(mainWindow);
  mainWindow.webContents.on("did-finish-load", () => {
    if (pendingAuthUrl) {
      mainWindow.webContents.send("auth-callback", pendingAuthUrl);
      pendingAuthUrl = null;
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

function createLiveWindow({ tournamentId, matchId }) {
  if (!UUID_RE.test(tournamentId) || !UUID_RE.test(matchId)) {
    return { ok: false, error: "Invalid live window request" };
  }
  const key = `${tournamentId}:${matchId}`;
  const existing = liveWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { ok: true, focused: true };
  }
  const win = new BrowserWindow({
    width: 920,
    height: 640,
    minWidth: 420,
    minHeight: 320,
    title: "Live match",
    icon: ICON,
    backgroundColor: "#0c0f13",
    autoHideMenuBar: true,
    webPreferences: rendererPrefs(),
  });
  denyWindowOpen(win.webContents);
  win.webContents.on("will-navigate", (event, url) => {
    const live = /#\/?live\//.test(url);
    if (!live) event.preventDefault();
  });
  loadOperator(win, `/live/${tournamentId}/${matchId}`);
  liveWindows.set(key, win);
  win.on("closed", () => {
    if (liveWindows.get(key) === win) liveWindows.delete(key);
  });
  return { ok: true, opened: true };
}

function deliverAuthUrl(url) {
  if (!url) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.isLoading()) pendingAuthUrl = url;
    else mainWindow.webContents.send("auth-callback", url);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } else {
    pendingAuthUrl = url;
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const fromArgv = resolveAuthUrl(process.argv);
  if (fromArgv) pendingAuthUrl = fromArgv;

  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.on("second-instance", (_event, argv) => {
    deliverAuthUrl(resolveAuthUrl(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    deliverAuthUrl(url);
  });

  ipcMain.handle("desktop-info", () => ({
    runtime: "electron",
    authRedirect: `${PROTOCOL}://auth/callback`,
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle("open-live-window", (_event, payload = {}) => {
    return createLiveWindow({
      tournamentId: String(payload.tournamentId || ""),
      matchId: String(payload.matchId || ""),
    });
  });

  ipcMain.handle("updater:get-state", () => updater.getState());
  ipcMain.handle("updater:check", () => updater.check({ force: true }));
  ipcMain.handle("updater:install", (event) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
      return { ok: false, error: "Install from the organizer window" };
    }
    return updater.install();
  });
  ipcMain.handle("updater:later", () => updater.later());
  ipcMain.on("updater:set-context", (_event, payload = {}) => {
    rendererUpdateContext = {
      liveMatches: Math.max(0, Number(payload.liveMatches) || 0),
      busy: Boolean(payload.busy),
      dialogOpen: Boolean(payload.dialogOpen),
    };
  });

  app.whenReady().then(() => {
    createWindow();
    try {
      updater.attach();
    } catch (err) {
      console.warn("[updater] disabled:", err?.message || err);
    }
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
