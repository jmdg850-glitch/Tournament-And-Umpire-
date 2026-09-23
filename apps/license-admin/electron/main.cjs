const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");

const ICON = path.join(__dirname, "..", "build", "icon.ico");

let mainWindow = null;

function sendToMainWindow(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// A missing/broken updater must never stop License Admin from starting.
let updater = null;
try {
  const { createDesktopUpdater } = require("./updater.cjs");
  updater = createDesktopUpdater({ sendToMainWindow });
} catch (err) {
  console.warn("[updater] unavailable:", err?.message || err);
}

function rendererPrefs() {
  return {
    preload: path.join(__dirname, "preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function licenseAdminIndex() {
  return path.join(__dirname, "..", "dist", "index.html");
}

function denyWindowOpen(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    title: "Tournament License Admin",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: rendererPrefs(),
  });

  denyWindowOpen(mainWindow.webContents);
  mainWindow.loadFile(licenseAdminIndex());
  mainWindow.on("closed", () => { mainWindow = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  ipcMain.handle("desktop-info", () => ({
    runtime: "electron",
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  const noUpdater = { status: "idle", currentVersion: app.getVersion(), availableVersion: null, percent: 0, message: "" };
  ipcMain.handle("updater:get-state", () => (updater ? updater.getState() : noUpdater));
  ipcMain.handle("updater:install", (event) => {
    if (!updater) return { ok: false, error: "Updater unavailable" };
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
      return { ok: false, error: "Install from the License Admin window" };
    }
    return updater.install();
  });
  ipcMain.handle("updater:later", () => (updater ? updater.later() : noUpdater));

  app.whenReady().then(() => {
    createWindow();
    try {
      updater?.attach();
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
