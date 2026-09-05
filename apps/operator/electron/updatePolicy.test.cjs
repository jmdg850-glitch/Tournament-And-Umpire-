"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldCheckForUpdates,
  isUnsafeToAutoRestart,
  shouldInstallNow,
  nextCheckAllowed,
  initialUpdaterState,
  DEFAULT_UPDATE_URL,
} = require("./updatePolicy.cjs");

test("development / unpackaged builds never check for production updates", () => {
  assert.equal(shouldCheckForUpdates({ packaged: false, disableUpdates: false }), false);
  assert.equal(shouldCheckForUpdates({ packaged: true, disableUpdates: true }), false);
  assert.equal(shouldCheckForUpdates({ packaged: true, disableUpdates: false }), true);
});

test("auto-restart is blocked while live matches, live windows, busy work, or dialogs exist", () => {
  assert.equal(isUnsafeToAutoRestart({}), false);
  assert.equal(isUnsafeToAutoRestart({ liveWindowCount: 1 }), true);
  assert.equal(isUnsafeToAutoRestart({ liveMatches: 2 }), true);
  assert.equal(isUnsafeToAutoRestart({ busy: true }), true);
  assert.equal(isUnsafeToAutoRestart({ dialogOpen: true }), true);
});

test("install happens only after explicit organizer confirmation", () => {
  assert.equal(shouldInstallNow({ userConfirmed: false }), false);
  assert.equal(shouldInstallNow({ userConfirmed: true }), true);
});

test("duplicate in-flight checks are rejected; interval prevents aggressive polling", () => {
  assert.equal(nextCheckAllowed({ inProgress: true, lastCheckAt: null, now: 100, minIntervalMs: 50 }), false);
  assert.equal(nextCheckAllowed({ inProgress: false, lastCheckAt: 80, now: 100, minIntervalMs: 50 }), false);
  assert.equal(nextCheckAllowed({ inProgress: false, lastCheckAt: 10, now: 100, minIntervalMs: 50 }), true);
  assert.equal(nextCheckAllowed({ inProgress: false, lastCheckAt: null, now: 100, minIntervalMs: 50 }), true);
});

test("initial state is idle and carries the installed version", () => {
  const state = initialUpdaterState("1.0.0");
  assert.equal(state.status, "idle");
  assert.equal(state.currentVersion, "1.0.0");
  assert.equal(state.availableVersion, null);
});

test("production feed is a public HTTPS generic URL, not GitHub", () => {
  assert.match(DEFAULT_UPDATE_URL, /^https:\/\//);
  assert.doesNotMatch(DEFAULT_UPDATE_URL, /github\.com/i);
});
