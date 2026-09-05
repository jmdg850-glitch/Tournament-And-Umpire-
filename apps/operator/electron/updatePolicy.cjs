"use strict";

const DEFAULT_UPDATE_URL =
  "https://evuvgxruavnadpbiehgb.supabase.co/storage/v1/object/public/desktop-updates/operator/win";

function updateFeedUrl() {
  const fromEnv = String(process.env.ELECTRON_UPDATE_URL || "").trim().replace(/\/+$/, "");
  return fromEnv || DEFAULT_UPDATE_URL;
}

function genericPublishConfig() {
  return {
    provider: "generic",
    url: updateFeedUrl(),
    useMultipleRangeRequest: false,
  };
}

function shouldCheckForUpdates({ packaged, disableUpdates }) {
  if (!packaged) return false;
  if (disableUpdates) return false;
  return true;
}

function isUnsafeToAutoRestart({ liveWindowCount = 0, liveMatches = 0, busy = false, dialogOpen = false } = {}) {
  return Number(liveWindowCount) > 0
    || Number(liveMatches) > 0
    || Boolean(busy)
    || Boolean(dialogOpen);
}

function shouldInstallNow({ userConfirmed }) {
  return userConfirmed === true;
}

function nextCheckAllowed({ lastCheckAt, now, minIntervalMs, inProgress }) {
  if (inProgress) return false;
  if (!lastCheckAt) return true;
  return now - lastCheckAt >= minIntervalMs;
}

function initialUpdaterState(version) {
  return {
    status: "idle",
    currentVersion: version || "0.0.0",
    availableVersion: null,
    percent: 0,
    message: "",
    unsafeToAutoRestart: false,
  };
}

module.exports = {
  DEFAULT_UPDATE_URL,
  updateFeedUrl,
  genericPublishConfig,
  shouldCheckForUpdates,
  isUnsafeToAutoRestart,
  shouldInstallNow,
  nextCheckAllowed,
  initialUpdaterState,
  STARTUP_DELAY_MS: 12_000,
  PERIODIC_CHECK_MS: 6 * 60 * 60 * 1000,
  MIN_CHECK_INTERVAL_MS: 30 * 60 * 1000,
};
