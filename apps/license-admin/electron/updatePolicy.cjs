"use strict";

// License Admin shares Operator's GitHub repository and GitHub Release, but
// reads its own update-info file: electron-updater fetches `${channel}.yml`
// from the latest release, so channel "license-admin" means this app reads
// license-admin.yml and can never consume Operator's latest.yml.
// Must stay in sync with apps/license-admin/package.json build.publish —
// scripts/publish-desktop-update.mjs refuses to publish if they drift.
const GITHUB_UPDATE_OWNER = "jmdg850-glitch";
const GITHUB_UPDATE_REPO = "Tournament-And-Umpire-";
const UPDATE_CHANNEL = "license-admin";

function githubPublishConfig() {
  return {
    provider: "github",
    owner: GITHUB_UPDATE_OWNER,
    repo: GITHUB_UPDATE_REPO,
    channel: UPDATE_CHANNEL,
  };
}

function shouldCheckForUpdates({ packaged, disableUpdates }) {
  if (!packaged) return false;
  if (disableUpdates) return false;
  return true;
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
  };
}

module.exports = {
  GITHUB_UPDATE_OWNER,
  GITHUB_UPDATE_REPO,
  UPDATE_CHANNEL,
  githubPublishConfig,
  shouldCheckForUpdates,
  shouldInstallNow,
  nextCheckAllowed,
  initialUpdaterState,
  STARTUP_DELAY_MS: 12_000,
  PERIODIC_CHECK_MS: 6 * 60 * 60 * 1000,
  MIN_CHECK_INTERVAL_MS: 30 * 60 * 1000,
};
