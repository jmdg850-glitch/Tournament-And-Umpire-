"use strict";
// Test-only Electron main process used by licenseDeviceIpc.test.cjs.
//
// It registers the EXACT same ipcMain.handle("license:get-device", ...) line
// used in production main.cjs (verified byte-for-byte by the companion test,
// which greps both files) and exercises it through the real
// main -> preload -> contextBridge -> renderer path, instead of only calling
// the underlying licenseDevice.cjs helper directly in Node.
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { getLicenseDevice } = require("./licenseDevice.cjs");

app.disableHardwareAcceleration();

// Keep this line identical to apps/operator/electron/main.cjs's own
// registration — licenseDeviceIpc.test.cjs asserts the two files agree.
ipcMain.handle("license:get-device", () => getLicenseDevice({ userDataDir: app.getPath("userData") }));

function fail(err) {
  process.stdout.write(`IPC_TEST_ERROR:${JSON.stringify(String((err && err.stack) || err))}\n`);
  app.exit(1);
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadURL("data:text/html,<html></html>");
    // Call twice through the real IPC path to prove determinism, not just
    // that the helper function itself is deterministic.
    const first = await win.webContents.executeJavaScript("window.tournamentDesktop.getLicenseDevice()");
    const second = await win.webContents.executeJavaScript("window.tournamentDesktop.getLicenseDevice()");
    const hasBridge = await win.webContents.executeJavaScript(
      "typeof window.tournamentDesktop === 'object' && typeof window.require === 'undefined'",
    );
    process.stdout.write(`IPC_TEST_RESULT:${JSON.stringify({ first, second, hasBridge })}\n`);
    app.exit(0);
  } catch (err) {
    fail(err);
  }
});

process.on("uncaughtException", fail);
