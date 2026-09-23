const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");

const ICON = path.join(__dirname, "..", "build", "icon.ico");

let mainWindow = null;

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

  app.whenReady().then(() => {
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
