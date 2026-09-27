// Umpire match list ("dashboard") — last known good state.
// Regression for the real-device bug: turning Wi-Fi off made supabase-js
// resolve `{ error: { message: "TypeError: Failed to fetch" }, status: 0 }`
// and the list was replaced with nothing.
import { describe, it, expect } from "vitest";
import { classifyQueryFailure, applyLoadOutcome, stateFromCache, createDashboardCache, INITIAL_LOAD_STATE } from "./lastKnownGood.js";
import { createMemoryStore } from "./offlineQueue.js";
import { createMatchLane, reconstructMatchView } from "./matchLane.js";
import { applyOptimisticScore, createInitialScoreState } from "@tournament/engine";

// Exact shape postgrest-js returns when fetch() itself fails.
const networkFailure = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, count: null, status: 0, statusText: "" };
const httpFailure = (status, message = "err") => ({ data: null, error: { message, code: "X" }, status, statusText: "" });
const ok = (data) => ({ data, error: null, status: 200, statusText: "OK" });

const MATCHES = [
  { id: "m1", status: "in_progress", courtName: "Court 1", score_state: { scoreA: 4, scoreB: 2 } },
  { id: "m2", status: "assigned", courtName: "Court 2", score_state: null },
];

function memStorage() {
  const rows = new Map();
  return { getItem: (k) => (rows.has(k) ? rows.get(k) : null), setItem: (k, v) => rows.set(k, String(v)), removeItem: (k) => rows.delete(k) };
}

// Mirrors what MyMatches.load does with a query result.
function reduce(prev, result, rows = MATCHES, at = 1000) {
  const kind = classifyQueryFailure(result);
  return kind
    ? applyLoadOutcome(prev, { ok: false, kind, message: result.error?.message })
    : applyLoadOutcome(prev, { ok: true, rows, meta: { sides: [], participants: [] }, at });
}

describe("classifyQueryFailure", () => {
  it("a successful response — including an empty list — is not a failure", () => {
    expect(classifyQueryFailure(ok(MATCHES))).toBeNull();
    expect(classifyQueryFailure(ok([]))).toBeNull();
  });
  it("postgrest's `TypeError: Failed to fetch` (status 0) is a network failure", () => {
    expect(classifyQueryFailure(networkFailure)).toBe("network");
  });
  it("a thrown error with no HTTP status (fetch TypeError / timeout) is a network failure", () => {
    expect(classifyQueryFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyQueryFailure(Object.assign(new Error("No response"), { timeout: true }))).toBe("network");
  });
  it("401 is auth, 403 is forbidden, 5xx is server, other 4xx is app — never 'network'", () => {
    expect(classifyQueryFailure(httpFailure(401))).toBe("auth");
    expect(classifyQueryFailure(httpFailure(403))).toBe("forbidden");
    expect(classifyQueryFailure(httpFailure(500))).toBe("server");
    expect(classifyQueryFailure(httpFailure(503))).toBe("server");
    expect(classifyQueryFailure(httpFailure(400))).toBe("app");
    expect(classifyQueryFailure(Object.assign(new Error("x"), { status: 401 }))).toBe("auth");
  });
});

describe("dashboard state across connectivity changes", () => {
  it("TEST 1 — initial online load shows the matches and persists them", () => {
    const storage = memStorage();
    const cache = createDashboardCache("tournament.umpire.dashboard.user:a", storage);
    const s = reduce(INITIAL_LOAD_STATE, ok(MATCHES));
    cache.write({ rows: s.rows, meta: s.meta, savedAt: s.lastUpdatedAt });
    expect(s).toMatchObject({ rows: MATCHES, status: "online", error: "" });
    expect(cache.read().rows).toEqual(MATCHES);
  });

  it("TEST 2 — `TypeError: Failed to fetch` after a good load keeps every match and reports offline", () => {
    const loaded = reduce(INITIAL_LOAD_STATE, ok(MATCHES), MATCHES, 1000);
    const offline = reduce(loaded, networkFailure);
    expect(offline.rows).toEqual(MATCHES);
    expect(offline.rows.length).toBeGreaterThan(0);
    expect(offline.status).toBe("offline");
    expect(offline.lastUpdatedAt).toBe(1000); // still the last time the server answered
  });

  it("TEST 3 — a successful EMPTY response is a real empty list (not confused with a failure)", () => {
    const loaded = reduce(INITIAL_LOAD_STATE, ok(MATCHES));
    const empty = reduce(loaded, ok([]), []);
    expect(empty).toMatchObject({ rows: [], status: "online" });
    // …whereas a failure with no data yet leaves rows unknown (null), not [].
    expect(reduce(INITIAL_LOAD_STATE, networkFailure).rows).toBeNull();
  });

  it("TEST 4 — when the network returns, fresh data replaces the saved list and the offline status clears", () => {
    const loaded = reduce(INITIAL_LOAD_STATE, ok(MATCHES), MATCHES, 1000);
    const offline = reduce(loaded, networkFailure);
    const fresh = [{ ...MATCHES[0], score_state: { scoreA: 9, scoreB: 2 } }];
    const back = reduce(offline, ok(fresh), fresh, 5000);
    expect(back).toMatchObject({ rows: fresh, status: "online", error: "", lastUpdatedAt: 5000 });
  });

  it("cold start offline: the list comes from this device's cache, per account", () => {
    const storage = memStorage();
    createDashboardCache("tournament.umpire.dashboard.user:a", storage).write({ rows: MATCHES, meta: null, savedAt: 42 });
    const a = stateFromCache(createDashboardCache("tournament.umpire.dashboard.user:a", storage).read());
    const b = stateFromCache(createDashboardCache("tournament.umpire.dashboard.user:b", storage).read());
    expect(a).toMatchObject({ rows: MATCHES, lastUpdatedAt: 42, source: "cache" });
    expect(b.rows).toBeNull(); // another account never sees A's list
    expect(reduce(a, networkFailure).rows).toEqual(MATCHES);
  });

  it("a corrupt cache entry behaves as 'no cache' instead of crashing", () => {
    const storage = memStorage();
    storage.setItem("k", "{not json");
    expect(createDashboardCache("k", storage).read()).toBeNull();
  });

  it("TEST 7 — 401 is reported as an auth problem, not 'offline', and does not wipe the list", () => {
    const loaded = reduce(INITIAL_LOAD_STATE, ok(MATCHES));
    const s = reduce(loaded, httpFailure(401, "JWT expired"));
    expect(s.status).toBe("auth");
    expect(s.error).toBe("JWT expired");
    expect(s.rows).toEqual(MATCHES);
  });

  it("TEST 8 — 500 is a server problem (never 'no matches'); 403 is a permission problem", () => {
    const loaded = reduce(INITIAL_LOAD_STATE, ok(MATCHES));
    const s500 = reduce(loaded, httpFailure(500, "boom"));
    expect(s500).toMatchObject({ status: "server", rows: MATCHES });
    expect(reduce(INITIAL_LOAD_STATE, httpFailure(500)).rows).toBeNull(); // unknown, not []
    expect(reduce(loaded, httpFailure(403)).status).toBe("forbidden");
  });
});

describe("offline match access and the scoring queue are independent of the list load", () => {
  const SETTINGS = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" };
  const applyEntry = (match, entry) => {
    const p = entry.payload;
    return applyOptimisticScore(match, { id: p.event_id, seq: p.seq, type: p.type, payload: p.payload }).match;
  };

  it("TEST 5 — a seeded/opened match still shows its score and accepts offline points with no list fetch at all", async () => {
    const store = createMemoryStore();
    const match = { id: "m1", status: "in_progress", score_state: createInitialScoreState(SETTINGS) };
    await store.putMatch({ matchId: "m1", owner: "user:a", match });
    const lane = createMatchLane({ store, matchId: "m1", owner: "user:a", minRepeatMs: 0 });
    await lane.enqueue("point", { team: "A" });
    await lane.enqueue("point", { team: "A" });
    // The list load now fails — irrelevant to the match itself.
    reduce(reduce(INITIAL_LOAD_STATE, ok(MATCHES)), networkFailure);
    const base = await store.getMatch("m1");
    const view = reconstructMatchView({ baseMatch: base.match, entries: await store.list(), applyEntry });
    expect(view.match.score_state.scoreA).toBe(2);
    expect(view.pending).toHaveLength(2);
  });

  it("TEST 6 — refreshing the list (and seeding match context) never alters queued commands or rolls a confirmed score back", async () => {
    const store = createMemoryStore();
    const confirmed = { id: "m1", status: "in_progress", score_state: { ...createInitialScoreState(SETTINGS), lastSeq: 5, scoreA: 5 } };
    await store.putMatch({ matchId: "m1", owner: "user:a", match: confirmed });
    const lane = createMatchLane({ store, matchId: "m1", owner: "user:a", minRepeatMs: 0 });
    lane.observeSeq(5);
    await lane.enqueue("point", { team: "A" });
    const before = JSON.stringify(await store.list());
    // Dashboard refresh seeds context from an OLDER server row (lastSeq 3).
    const stale = { ...confirmed, score_state: { ...confirmed.score_state, lastSeq: 3, scoreA: 3 } };
    await store.putMatch({ matchId: "m1", owner: "user:a", match: stale, sides: [], participants: [], court: { id: "c1", name: "Court 1" } });
    expect(JSON.stringify(await store.list())).toBe(before);
    const base = await store.getMatch("m1");
    expect(base.match.score_state.lastSeq).toBe(5); // not rolled back
    expect(base.court).toEqual({ id: "c1", name: "Court 1" }); // display context refreshed
  });
});
