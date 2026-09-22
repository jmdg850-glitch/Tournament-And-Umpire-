const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const { createDesktopUpdater } = require("./updater.cjs");
const { getLicenseDevice } = require("./licenseDevice.cjs");

const PROTOCOL = "tournament-operator";
const ICON = path.join(__dirname, "..", "build", "icon.ico");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let mainWindow = null;
let pendingAuthUrl = null;
// One shared registry for every popped-out display window (live match,
// bracket, per-division match display) — each entry is keyed with its own
// kind prefix (e.g. "live:<tournamentId>:<matchId>", "bracket:<tournamentId>",
// "match:<tournamentId>:<divisionId>") so a Bracket window for tournament A
// and a Match window for the same tournament A never collide, while an
// already-open window for the exact same thing is focused/reused instead of
// duplicated (see createDisplayWindow below). This also means the desktop
// auto-updater's "don't restart while a display window an operator has
// handed off to a second screen/projector is open" gate (getLiveWindowCount /
// closeLiveWindows, passed into updater.cjs) already covers Bracket/Match
// windows too, not just the original Live match window.
const displayWindows = new Map();
let rendererUpdateContext = { liveMatches: 0, busy: false, dialogOpen: false };

function liveWindowCount() {
  let n = 0;
  for (const win of displayWindows.values()) {
    if (win && !win.isDestroyed()) n += 1;
  }
  return n;
}

function closeLiveWindows() {
  for (const [key, win] of [...displayWindows.entries()]) {
    try {
      if (win && !win.isDestroyed()) win.close();
    } catch {
      /* ignore */
    }
    displayWindows.delete(key);
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

// Shared implementation behind createLiveWindow/createBracketWindow/
// createMatchWindow: opens a BrowserWindow scoped to one hash route, focusing
// an already-open window for the same `key` instead of duplicating it. Each
// window is locked to navigating only within its own route family
// (`navPattern`) — the same protection createLiveWindow already had — so this
// popped-out display can never be redirected into the full authenticated
// Operator app or an arbitrary URL.
function createDisplayWindow({ key, hashPath, title, navPattern, width, height, minWidth, minHeight }) {
  const existing = displayWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { ok: true, focused: true };
  }
  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    title,
    icon: ICON,
    backgroundColor: "#0c0f13",
    autoHideMenuBar: true,
    webPreferences: rendererPrefs(),
  });
  denyWindowOpen(win.webContents);
  win.webContents.on("will-navigate", (event, url) => {
    if (!navPattern.test(url)) event.preventDefault();
  });
  loadOperator(win, hashPath);
  displayWindows.set(key, win);
  win.on("closed", () => {
    if (displayWindows.get(key) === win) displayWindows.delete(key);
  });
  return { ok: true, opened: true };
}

function createLiveWindow({ tournamentId, matchId }) {
  if (!UUID_RE.test(tournamentId) || !UUID_RE.test(matchId)) {
    return { ok: false, error: "Invalid live window request" };
  }
  return createDisplayWindow({
    key: `live:${tournamentId}:${matchId}`,
    hashPath: `/live/${tournamentId}/${matchId}`,
    title: "Live match",
    navPattern: /#\/?live\//,
    width: 920,
    height: 640,
    minWidth: 420,
    minHeight: 320,
  });
}

// Read-only, whole-tournament bracket display — one window per tournament
// (opening it again while already open focuses that same window rather than
// spawning a second one for the same tournament).
function createBracketWindow({ tournamentId }) {
  if (!UUID_RE.test(tournamentId)) {
    return { ok: false, error: "Invalid bracket window request" };
  }
  return createDisplayWindow({
    key: `bracket:${tournamentId}`,
    hashPath: `/bracket/${tournamentId}`,
    title: "Bracket",
    navPattern: /#\/?bracket\//,
    width: 1280,
    height: 840,
    minWidth: 640,
    minHeight: 420,
  });
}

// Read-only, division-scoped match display — keyed by (tournamentId,
// divisionId), so Division A's window and Division B's window are always two
// independent windows; opening Division A's again reuses/focuses it without
// touching Division B's.
function createMatchWindow({ tournamentId, divisionId }) {
  if (!UUID_RE.test(tournamentId) || !UUID_RE.test(divisionId)) {
    return { ok: false, error: "Invalid match window request" };
  }
  return createDisplayWindow({
    key: `match:${tournamentId}:${divisionId}`,
    hashPath: `/matches-display/${tournamentId}/${divisionId}`,
    title: "Match display",
    navPattern: /#\/?matches-display\//,
    width: 1000,
    height: 760,
    minWidth: 480,
    minHeight: 360,
  });
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

  // Stable install id + computer name (label only) for license device registration.
  ipcMain.handle("license:get-device", () => getLicenseDevice({ userDataDir: app.getPath("userData") }));

  ipcMain.handle("open-live-window", (_event, payload = {}) => {
    return createLiveWindow({
      tournamentId: String(payload.tournamentId || ""),
      matchId: String(payload.matchId || ""),
    });
  });

  ipcMain.handle("open-bracket-window", (_event, payload = {}) => {
    return createBracketWindow({
      tournamentId: String(payload.tournamentId || ""),
    });
  });

  ipcMain.handle("open-match-window", (_event, payload = {}) => {
    return createMatchWindow({
      tournamentId: String(payload.tournamentId || ""),
      divisionId: String(payload.divisionId || ""),
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
