import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIMEOUT_DURATIONS_MIN,
  clearMatchTimeout,
  readTimeout,
  startTimeout,
  timeoutStorageKey,
  timeoutView,
  writeTimeout,
} from "./timeoutClock.js";

const T0 = 1_700_000_000_000;

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    map,
  };
}

const throwingStorage = {
  getItem() { throw new Error("blocked"); },
  setItem() { throw new Error("blocked"); },
  removeItem() { throw new Error("blocked"); },
};

test("offered durations are whole positive minutes", () => {
  assert.deepEqual([...TIMEOUT_DURATIONS_MIN], [1, 2, 3, 5]);
});

test("start: records an absolute end time for the chosen duration", () => {
  const rec = startTimeout(null, 2, T0);
  assert.deepEqual(rec, { startedAt: T0, endsAt: T0 + 120_000, durationSec: 120 });
  assert.deepEqual(timeoutView(rec, T0), { active: true, remainingMs: 120_000 });
});

test("countdown is computed from the end time, not decremented", () => {
  const rec = startTimeout(null, 1, T0);
  assert.equal(timeoutView(rec, T0 + 30_000).remainingMs, 30_000);
  // e.g. the app was backgrounded / screen slept for 45 s: no reset, no extension.
  assert.equal(timeoutView(rec, T0 + 45_000).remainingMs, 15_000);
});

test("expiry clamps to zero and is no longer active", () => {
  const rec = startTimeout(null, 1, T0);
  assert.deepEqual(timeoutView(rec, T0 + 60_000), { active: false, remainingMs: 0 });
  assert.deepEqual(timeoutView(rec, T0 + 10 * 60_000), { active: false, remainingMs: 0 });
});

test("a device clock moved backwards never shows more than the granted time", () => {
  const rec = startTimeout(null, 1, T0);
  assert.equal(timeoutView(rec, T0 - 3_600_000).remainingMs, 60_000);
});

test("repeated taps while active return the SAME timeout (no duplicate start)", () => {
  const first = startTimeout(null, 2, T0);
  const again = startTimeout(first, 5, T0 + 1_000);
  assert.equal(again, first);
});

test("a new timeout can start once the previous one has ended", () => {
  const first = startTimeout(null, 1, T0);
  const next = startTimeout(first, 3, T0 + 61_000);
  assert.notEqual(next, first);
  assert.equal(next.durationSec, 180);
});

test("invalid durations are rejected", () => {
  for (const bad of [0, -1, 1.5, 99, 11, "2", NaN, null, undefined]) {
    assert.equal(startTimeout(null, bad, T0), null, `duration ${String(bad)}`);
  }
});

test("malformed or tampered records are treated as no timeout", () => {
  for (const bad of [null, {}, { startedAt: T0 }, { startedAt: T0, endsAt: T0 + 5_000, durationSec: 60 }, { startedAt: T0, endsAt: T0 - 60_000, durationSec: -60 }]) {
    assert.deepEqual(timeoutView(bad, T0), { active: false, remainingMs: 0 });
  }
});

test("storage round trip is scoped per owner and match", () => {
  const storage = memoryStorage();
  const rec = startTimeout(null, 2, T0);
  assert.equal(writeTimeout(storage, "u1", "m1", rec), true);
  assert.deepEqual(readTimeout(storage, "u1", "m1"), rec);
  assert.equal(readTimeout(storage, "u1", "m2"), null);
  assert.equal(readTimeout(storage, "u2", "m1"), null);
  clearMatchTimeout(storage, "u1", "m1");
  assert.equal(readTimeout(storage, "u1", "m1"), null);
});

test("corrupt stored JSON reads as no timeout", () => {
  const storage = memoryStorage();
  storage.setItem(timeoutStorageKey("u1", "m1"), "{not json");
  assert.equal(readTimeout(storage, "u1", "m1"), null);
  storage.setItem(timeoutStorageKey("u1", "m1"), JSON.stringify({ startedAt: "x" }));
  assert.equal(readTimeout(storage, "u1", "m1"), null);
});

test("unavailable storage never throws", () => {
  assert.equal(readTimeout(throwingStorage, "u1", "m1"), null);
  assert.equal(writeTimeout(throwingStorage, "u1", "m1", startTimeout(null, 1, T0)), false);
  assert.doesNotThrow(() => clearMatchTimeout(throwingStorage, "u1", "m1"));
  assert.equal(readTimeout(undefined, "u1", "m1"), null);
});
