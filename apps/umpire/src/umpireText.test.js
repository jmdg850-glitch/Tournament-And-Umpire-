import test from "node:test";
import assert from "node:assert/strict";
import { friendlyError, syncChipState } from "./umpireText.js";

const err = (message, status, code) => Object.assign(new Error(message), status === undefined ? {} : { status }, code ? { code } : {});
const quiet = (fn) => { const w = console.warn; console.warn = () => {}; try { return fn(); } finally { console.warn = w; } };

test("network failures read as no connection, never the raw fetch text", () => {
  quiet(() => {
    assert.match(friendlyError(err("Failed to fetch"), "load"), /No connection/);
    assert.match(friendlyError(err("TypeError: NetworkError", 0), "action"), /No connection/);
  });
});

test("sign-in: wrong credentials are explained plainly", () => {
  quiet(() => {
    assert.equal(friendlyError(err("Invalid login credentials", 400, "invalid_credentials"), "signin"), "Email or password is incorrect.");
  });
});

test("pairing: any 4xx means the code is bad or expired", () => {
  quiet(() => {
    for (const s of [400, 401, 404, 410]) assert.match(friendlyError(err("grant expired", s), "pair"), /pairing code isn't valid/);
    assert.match(friendlyError(err("boom", 503), "pair"), /server isn't responding/);
  });
});

test("status-specific messages; no status codes or raw text leak", () => {
  quiet(() => {
    assert.match(friendlyError(err("jwt expired", 401), "action"), /sign-in has expired/);
    assert.match(friendlyError(err("FORBIDDEN", 403), "action"), /not assigned/);
    assert.match(friendlyError(err("stale", 409, "STALE_STATE"), "action"), /changed on another device/);
    const t = friendlyError(err("Command failed (500)", 500), "action");
    assert.match(t, /server isn't responding/);
    assert.doesNotMatch(t, /500/);
    assert.doesNotMatch(friendlyError(err("column x does not exist", 422), "load"), /column/);
  });
});

test("known API codes get their own sentence; app-written sign-in messages pass through", () => {
  quiet(() => {
    assert.match(friendlyError(err("x", 409, "MATCH_NOT_READY"), "action"), /isn't ready to start/);
    assert.match(friendlyError(err("x", 409, "TIMER_UNAVAILABLE"), "action"), /Game time isn't available/);
    const own = Object.assign(new Error("Your sign-in has expired. Scores are kept."), { status: 401, code: "NEEDS_AUTH" });
    assert.equal(friendlyError(own, "action"), "Your sign-in has expired. Scores are kept.");
  });
});

test("sync chip: problems outrank transient work, calm state last", () => {
  assert.equal(syncChipState({ inConflict: true, pending: 3, offline: true }).tone, "error");
  assert.equal(syncChipState({ needsAuth: "x", pending: 2 }).label, "Sign in needed · 2 saved");
  assert.equal(syncChipState({ offline: true, pending: 4 }).label, "Offline · 4 saved");
  assert.equal(syncChipState({ offline: true }).label, "Offline");
  assert.equal(syncChipState({ saving: true, pending: 1 }).label, "Saving…");
  assert.equal(syncChipState({ pending: 2 }).label, "Syncing 2");
  assert.equal(syncChipState({ justSynced: true }).label, "Synced");
  assert.deepEqual(syncChipState({}), { tone: "ok", label: "Online" });
  assert.equal(syncChipState({ durable: false }).label, "Not saving offline");
});
