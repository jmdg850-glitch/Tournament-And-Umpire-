import test from "node:test";
import assert from "node:assert/strict";
import { applyLoadOutcome, createMemoryStore, createTournamentRepository, deriveConnectionState, stateFromCache } from "@tournament/client";
import { commandFailureError, dashboardFromQueries, deskOutcome, keepFresherMatch, mergeServerMatches, offlineUnverifiedError, savedAtLabel } from "./offlineData.js";
import { selectAllPages } from "./lib.js";
import { LicenseCallError, gateStateFromCheck, offlineLicenseError, rememberActive } from "./license.js";

const offline = () => ({ data: null, error: { message: "TypeError: Failed to fetch", code: "" }, status: 0 });
const ok = (data) => ({ data, error: null, status: 200 });
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

function dashboardQueries() {
  return [
    ok([{ id: "t1", name: "Spring Open", status: "in_progress" }]),
    ok([{ id: "m1", status: "in_progress", tournament_id: "t1", started_at: null, created_at: "2020-01-01T00:00:00Z" }]),
    ok([{ id: "c1" }]),
    ok([{ id: "p1" }, { id: "p2" }]),
    ok([]),
    ok([{ id: "u1", user_id: "x" }]),
    ok([{ id: "d1", status: "active", court_id: "c1", tournament_id: "t1", refresh_token_hash: "SECRET" }]),
  ];
}

test("dashboard: a successful load yields rows + metrics, without device secrets", () => {
  const out = dashboardFromQueries(dashboardQueries(), 42);
  assert.equal(out.ok, true);
  assert.deepEqual(out.rows.map((t) => t.id), ["t1"]);
  assert.equal(out.meta.metrics.live, 1);
  assert.equal(out.meta.metrics.paired, 1);
  assert.equal(out.meta.metrics.players, 2);
  assert.ok(!JSON.stringify(out).includes("SECRET"));
});

test("dashboard: going offline keeps the tournaments on screen (never blanks) and says so plainly", () => {
  const loaded = applyLoadOutcome(undefined, dashboardFromQueries(dashboardQueries(), 42));
  const queries = dashboardQueries();
  queries[0] = offline();
  const failed = dashboardFromQueries(queries);
  assert.deepEqual(failed, { ok: false, kind: "network", message: "TypeError: Failed to fetch" });
  const next = applyLoadOutcome(loaded, failed);
  assert.deepEqual(next.rows.map((t) => t.id), ["t1"]);
  assert.equal(next.meta.metrics.live, 1);
  const state = deriveConnectionState({ load: next });
  assert.equal(state.kind, "offline-cached");
  assert.doesNotMatch(state.label, /Failed to fetch/);
});

test("dashboard: an empty server answer is a real 'nothing', distinct from offline", () => {
  const empty = dashboardQueries().map(() => ok([]));
  const out = dashboardFromQueries(empty);
  assert.equal(out.ok, true);
  assert.deepEqual(out.rows, []);
  assert.equal(deriveConnectionState({ load: applyLoadOutcome(undefined, out) }).kind, "online");
});

test("dashboard: a missing court_devices answer is still optional (unchanged behaviour)", () => {
  const queries = dashboardQueries();
  queries[6] = { data: null, error: { message: "denied" }, status: 403 };
  const out = dashboardFromQueries(queries);
  assert.equal(out.ok, true);
  assert.equal(out.meta.metrics.paired, 0);
  assert.deepEqual(out.meta.courtDevices, []);
});

test("dashboard: a restart offline restores the saved dashboard from this computer", async () => {
  const store = createMemoryStore();
  const out = dashboardFromQueries(dashboardQueries(), 1000);
  await createTournamentRepository({ store, owner: "user:u1" }).saveDashboard({ rows: out.rows, meta: out.meta }, out.at);
  // "restart": a fresh repository over the same store, then the load fails offline
  const snap = await createTournamentRepository({ store, owner: "user:u1" }).loadDashboard();
  const seeded = stateFromCache({ rows: snap.data.rows, meta: snap.data.meta, savedAt: snap.savedAt });
  const queries = dashboardQueries();
  queries[0] = offline();
  const next = applyLoadOutcome(seeded, dashboardFromQueries(queries));
  assert.deepEqual(next.rows.map((t) => t.id), ["t1"]);
  assert.equal(next.lastUpdatedAt, 1000);
  assert.equal(deriveConnectionState({ load: next }).kind, "offline-cached");
});

test("desk: status 0 is offline; 401/403/5xx are not", () => {
  assert.equal(deskOutcome({ data: null, error: { message: "TypeError: Failed to fetch" }, status: 0 }).kind, "network");
  assert.equal(deskOutcome({ data: null, error: { message: "JWT expired" }, status: 401 }).kind, "auth");
  assert.equal(deskOutcome({ data: null, error: { message: "denied" }, status: 403 }).kind, "forbidden");
  assert.equal(deskOutcome({ data: null, error: { message: "boom" }, status: 503 }).kind, "server");
  const good = deskOutcome({ data: { tournament: { id: "t1" } }, error: null }, 7);
  assert.deepEqual(good, { ok: true, rows: { tournament: { id: "t1" } }, at: 7 });
});

test("commands: no answer is reported as NOT CONFIRMED (never 'saved'), and keeps its command_id", () => {
  const timeout = commandFailureError(Object.assign(new Error("t"), { timeout: true, code: "TIMEOUT" }), "cmd-1");
  assert.equal(timeout.code, "OFFLINE");
  assert.equal(timeout.commandId, "cmd-1");
  assert.match(timeout.message, /not confirmed/);
  assert.match(timeout.message, /may or may not/);
  const net = commandFailureError(new TypeError("Failed to fetch"), "cmd-2");
  assert.match(net.message, /not confirmed/);
  for (const e of [timeout, net]) {
    assert.doesNotMatch(e.message, /Failed to fetch|NOT saved|queued/i);
  }
});

test("commands: offline with an unverified sign-in says nothing was sent", () => {
  const err = offlineUnverifiedError();
  assert.equal(err.code, "OFFLINE");
  assert.match(err.message, /NOT sent/);
});

test("license: an unverified offline identity uses only the existing 7-day allowance — never a denial", () => {
  const storage = mem();
  const now = 10_000_000_000;
  // verified active 2 days ago → allowed offline
  rememberActive("u1", now - 2 * 86400000, storage);
  const allowed = gateStateFromCheck({ userId: "u1", error: offlineLicenseError(), now, storage });
  assert.equal(allowed.phase, "active");
  // the allowance itself is untouched (not consumed, not dropped)
  assert.equal(Number(storage.getItem("tournament.license.lastActive.u1")), now - 2 * 86400000);
  // never verified here → blocked with a connection message, not a license denial
  const blocked = gateStateFromCheck({ userId: "u2", error: offlineLicenseError(), now, storage });
  assert.equal(blocked.phase, "blocked");
  assert.match(blocked.error, /offline|internet/i);
  assert.equal(storage.getItem("tournament.license.blockedAt.u2"), null);
});

test("savedAtLabel is human-readable", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  assert.equal(savedAtLabel(null, now), "");
  assert.equal(savedAtLabel(now - 10_000, now), "saved just now");
  assert.equal(savedAtLabel(now - 5 * 60000, now), "saved 5 min ago");
  assert.match(savedAtLabel(now - 3 * 3600000, now), /^saved /);
});

test("license: a license-service hiccup (5xx/408/429/401/device error) uses the offline allowance instead of locking the desk", () => {
  const storage = mem();
  const now = 10_000_000_000;
  rememberActive("u1", now - 86400000, storage);
  const hiccups = [
    new LicenseCallError("INTERNAL", "bad gateway", 502),
    new LicenseCallError("INTERNAL", "unavailable", 503),
    new LicenseCallError("RATE_LIMITED", "slow down", 429),
    new LicenseCallError("TIMEOUT", "timeout", 408),
    new LicenseCallError("UNAUTHENTICATED", "token expired", 401),
    new Error("getLicenseDevice failed"),
  ];
  for (const error of hiccups) {
    assert.equal(gateStateFromCheck({ userId: "u1", error, now, storage }).phase, "active", error.message);
  }
  // A real refusal still blocks, allowance or not.
  const refused = gateStateFromCheck({ userId: "u1", error: new LicenseCallError("LICENSE_INVALID", "not active", 403), now, storage });
  assert.equal(refused.phase, "blocked");
  // Without a recent confirmed-active record a hiccup still blocks.
  assert.equal(gateStateFromCheck({ userId: "u9", error: new LicenseCallError("INTERNAL", "x", 503), now, storage }).phase, "blocked");
});

test("mergeServerMatches: an older server copy never replaces a newer live score; the server decides which matches exist", () => {
  const live = { id: "m1", updated_at: "2026-09-28T10:00:05Z", score_state: { lastSeq: 7, scoreA: 5 } };
  const staleServer = { id: "m1", updated_at: "2026-09-28T10:00:01Z", score_state: { lastSeq: 6, scoreA: 4 } };
  const newServer = { id: "m1", updated_at: "2026-09-28T10:00:09Z", score_state: { lastSeq: 8, scoreA: 6 } };
  const added = { id: "m2", updated_at: "2026-09-28T10:00:00Z" };
  assert.deepEqual(mergeServerMatches([live], [staleServer, added]), [live, added]);
  assert.deepEqual(mergeServerMatches([live], [newServer]), [newServer]);
  assert.deepEqual(mergeServerMatches([live, { id: "gone" }], []), []);
  assert.deepEqual(mergeServerMatches(null, [added]), [added]);
});

test("selectAllPages reads past the 1000-row response cap", async () => {
  const all = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
  const ranges = [];
  const makeQuery = () => ({ range: async (from, to) => { ranges.push([from, to]); return { data: all.slice(from, to + 1), error: null, status: 200 }; } });
  const res = await selectAllPages(makeQuery);
  assert.equal(res.data.length, 2345);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  const failing = () => ({ range: async () => ({ data: null, error: { message: "Failed to fetch" }, status: 0 }) });
  const bad = await selectAllPages(failing);
  assert.equal(bad.error.message, "Failed to fetch");
  assert.equal(bad.status, 0);
});

test("keepFresherMatch (Live Match window): a slower focus reload never replaces a newer score on screen", () => {
  const onScreen = { id: "m1", updated_at: "2026-09-28T10:00:05Z", score_state: { lastSeq: 9, scoreA: 7 } };
  const slowRead = { id: "m1", updated_at: "2026-09-28T10:00:01Z", score_state: { lastSeq: 8, scoreA: 6 } };
  const newerRead = { id: "m1", updated_at: "2026-09-28T10:00:07Z", score_state: { lastSeq: 10, scoreA: 8 } };
  assert.equal(keepFresherMatch(onScreen, slowRead), onScreen);
  assert.equal(keepFresherMatch(onScreen, newerRead), newerRead);
  // First load, and a server row for a different match (window reused): the server row.
  assert.equal(keepFresherMatch(null, slowRead), slowRead);
  const other = { id: "m2", updated_at: "2026-09-28T09:00:00Z" };
  assert.equal(keepFresherMatch(onScreen, other), other);
  // Same version (no change on the server): the server row, as before.
  const same = { ...onScreen };
  assert.equal(keepFresherMatch(onScreen, same), same);
  // Nothing read: keep what is shown.
  assert.equal(keepFresherMatch(onScreen, null), onScreen);
});
