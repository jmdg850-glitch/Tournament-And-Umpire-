"use strict";

const {
  autoUpdater,
} = require("electron-updater");
const { app } = require("electron");
const {
  genericPublishConfig,
  shouldCheckForUpdates,
  isUnsafeToAutoRestart,
  shouldInstallNow,
  nextCheckAllowed,
  initialUpdaterState,
  STARTUP_DELAY_MS,
  PERIODIC_CHECK_MS,
  MIN_CHECK_INTERVAL_MS,
} = require("./updatePolicy.cjs");

function createDesktopUpdater({
  sendToMainWindow,
  getLiveWindowCount,
  closeLiveWindows,
  getRendererContext,
}) {
  const state = initialUpdaterState(app.getVersion());
  let lastCheckAt = 0;
  let inProgress = false;
  let dismissedVersion = null;
  let started = false;
  let periodicTimer = null;

  function rendererContext() {
    return getRendererContext ? getRendererContext() : {};
  }

  function unsafe() {
    const ctx = rendererContext();
    return isUnsafeToAutoRestart({
      liveWindowCount: getLiveWindowCount ? getLiveWindowCount() : 0,
      liveMatches: ctx.liveMatches,
      busy: ctx.busy,
      dialogOpen: ctx.dialogOpen,
    });
  }

  function snapshot() {
    return {
      ...state,
      unsafeToAutoRestart: unsafe(),
    };
  }

  function emit() {
    const next = snapshot();
    try {
      sendToMainWindow?.("updater:status", next);
    } catch {
      /* main window may be gone */
    }
    return next;
  }

  function setStatus(status, extra = {}) {
    state.status = status;
    Object.assign(state, extra);
    return emit();
  }

  async function check({ force = false } = {}) {
    if (!shouldCheckForUpdates({
      packaged: app.isPackaged,
      disableUpdates: process.env.ELECTRON_DISABLE_UPDATES === "1",
    })) {
      return snapshot();
    }
    const now = Date.now();
    if (!force && !nextCheckAllowed({
      lastCheckAt,
      now,
      minIntervalMs: MIN_CHECK_INTERVAL_MS,
      inProgress,
    })) {
      return snapshot();
    }
    inProgress = true;
    lastCheckAt = now;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      setStatus("error", { message: "Update check failed", percent: 0 });
    } finally {
      inProgress = false;
    }
    return snapshot();
  }

  function install() {
    if (state.status !== "ready") {
      return { ok: false, error: "No update is ready" };
    }
    if (!shouldInstallNow({ userConfirmed: true })) {
      return { ok: false, error: "Restart was not confirmed" };
    }
    try {
      closeLiveWindows?.();
    } catch {
      /* still attempt install */
    }
    try {
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      setStatus("error", { message: "Could not start the installer" });
      return { ok: false, error: "Could not start the installer" };
    }
  }

  function later() {
    dismissedVersion = state.availableVersion || state.currentVersion;
    if (state.status === "ready" || state.status === "available" || state.status === "downloading") {
      setStatus("idle", { message: "" });
    }
    return snapshot();
  }

  function attach() {
    if (started) return;
    started = true;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    if ("autoInstallEvent" in autoUpdater) autoUpdater.autoInstallEvent = "onQuit";
    autoUpdater.allowDowngrade = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.logger = {
      info: (...args) => console.log("[updater]", ...args),
      warn: (...args) => console.warn("[updater]", ...args),
      error: (...args) => console.error("[updater]", ...args),
    };

    try {
      autoUpdater.setFeedURL(genericPublishConfig());
    } catch (err) {
      console.warn("[updater] feed URL not applied; using packaged app-update.yml if present");
    }

    autoUpdater.on("checking-for-update", () => {
      setStatus("checking", { message: "Checking for updates…" });
    });
    autoUpdater.on("update-available", (info) => {
      dismissedVersion = null;
      setStatus("available", {
        availableVersion: info?.version || null,
        message: "Update available",
        percent: 0,
      });
    });
    autoUpdater.on("update-not-available", () => {
      setStatus("idle", { availableVersion: null, message: "", percent: 0 });
    });
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress?.percent) || 0));
      setStatus("downloading", {
        percent,
        message: "Downloading update…",
      });
    });
    autoUpdater.on("update-downloaded", (info) => {
      if (dismissedVersion && info?.version === dismissedVersion) {
        setStatus("idle", {
          availableVersion: info?.version || null,
          percent: 100,
          message: "",
        });
        return;
      }
      setStatus("ready", {
        availableVersion: info?.version || state.availableVersion,
        percent: 100,
        message: unsafe()
          ? "Update ready. Restart when convenient."
          : "Update ready",
      });
    });
    autoUpdater.on("error", () => {
      inProgress = false;
      if (state.status === "ready") return;
      setStatus("error", { message: "Update check failed", percent: 0 });
    });

    setTimeout(() => {
      check().catch(() => {});
    }, STARTUP_DELAY_MS);
    periodicTimer = setInterval(() => {
      check().catch(() => {});
    }, PERIODIC_CHECK_MS);
    periodicTimer.unref?.();
  }

  function dispose() {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
  }

  return {
    attach,
    dispose,
    check,
    install,
    later,
    getState: snapshot,
  };
}

module.exports = { createDesktopUpdater };
