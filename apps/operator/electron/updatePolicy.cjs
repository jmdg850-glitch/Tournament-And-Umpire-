"use strict";

const GITHUB_UPDATE_OWNER = "jmdg850-glitch";
const GITHUB_UPDATE_REPO = "Tournament-And-Umpire-";

function githubPublishConfig() {
  return {
    provider: "github",
    owner: GITHUB_UPDATE_OWNER,
    repo: GITHUB_UPDATE_REPO,
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
  GITHUB_UPDATE_OWNER,
  GITHUB_UPDATE_REPO,
  githubPublishConfig,
  shouldCheckForUpdates,
  isUnsafeToAutoRestart,
  shouldInstallNow,
  nextCheckAllowed,
  initialUpdaterState,
  STARTUP_DELAY_MS: 12_000,
  PERIODIC_CHECK_MS: 6 * 60 * 60 * 1000,
  MIN_CHECK_INTERVAL_MS: 30 * 60 * 1000,
};
