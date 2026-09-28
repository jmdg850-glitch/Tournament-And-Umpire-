// Offline umpire scoring — write-ahead lane + central sync engine.
//
// Exercises the real modules the umpire app is wired to
// (matchLane.js, syncEngine.js, offlineQueue.js, sendCommand's timeout)
// against a fake command server that enforces the SAME idempotency rules as
// packages/api/src/handleCommand.js:
//   - command_receipts: a repeated command_id returns the stored result
//   - score_events.id: a repeated event_id is a no-op duplicate
//   - seq <= lastSeq → 409 OUT_OF_ORDER (scoring.js applyScoreEvent)
// Assertions check the fake SERVER's data (event count, lastSeq, score), not
// just local UI state.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { createMemoryStore, enqueueCommand, classifySendError, mergeConfirmedRecord } from "./offlineQueue.js";
import { createMatchLane, reconstructMatchView } from "./matchLane.js";
import { createSyncEngine, createStorageLease } from "./syncEngine.js";
import { sendCommand } from "./index.js";
import { applyOptimisticScore, createInitialScoreState, mergeMatchFromResult, configureTimer, startTimer, pauseTimer, adjustTimer, timerView } from "@tournament/engine";

const SETTINGS = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" };
const USER_A = "user:aaaa";
const USER_B = "user:bbbb";

function startedMatch(id = "m1") {
  return { id, status: "in_progress", score_state: createInitialScoreState(SETTINGS) };
}

function httpError(status, code, message = code) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function createFakeServer() {
  const matches = new Map();
  const receipts = new Map();
  const events = new Map(); // event_id -> event
  const calls = [];
  function seed(match) {
    matches.set(match.id, structuredClone(match));
  }
  function apply({ type, payload, commandId }) {
    if (receipts.has(commandId)) return { ok: true, idempotent: true, result: receipts.get(commandId) };
    const m = matches.get(payload.match_id);
    if (!m) throw httpError(404, "NOT_FOUND");
    let result;
    if (type === "score_event" || type === "coin_toss") {
      if (events.has(payload.event_id)) return { ok: true, result: { match: structuredClone(m), duplicate: true } };
      const event = type === "score_event"
        ? { id: payload.event_id, seq: payload.seq, type: payload.type, payload: payload.payload || {} }
        : { id: payload.event_id, seq: payload.seq, type: "coin_toss", payload: { result: payload.result, servingTeam: payload.serving_team } };
      let applied;
      try {
        applied = applyOptimisticScore(m, event, SETTINGS);
      } catch (err) {
        throw httpError(409, err.code || "OUT_OF_ORDER", err.message);
      }
      if (!applied.applied && !applied.duplicate) throw httpError(400, "INVALID_COMMAND");
      m.score_state = applied.state;
      if (applied.state.status === "completed" && m.status !== "completed") {
        m.status = "completed";
        m.completed_at = new Date().toISOString();
      }
      events.set(event.id, { ...event, match_id: m.id });
      result = { match: structuredClone(m), score_state: m.score_state, duplicate: false };
    } else if (type === "complete_match") {
      result = { match: structuredClone(m), already_complete: m.status === "completed" };
    } else {
      throw httpError(400, "UNSUPPORTED");
    }
    receipts.set(commandId, result);
    return { ok: true, idempotent: false, result };
  }
  return {
    seed,
    calls,
    match: (id) => matches.get(id),
    eventCount: (id) => [...events.values()].filter((e) => e.match_id === id).length,
    // Mimics sendCommand's contract.
    async send(req) {
      calls.push(req);
      return apply(req);
    },
    apply,
  };
}

const noTimers = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
};

function createFakeLocks() {
  const held = new Set();
  return {
    async request(name, opts, cb) {
      if (held.has(name)) return cb(null);
      held.add(name);
      try {
        return await cb({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}

function engineFor({ store, server, owner = USER_A, send, getAuth, locks = createFakeLocks(), onAck } = {}) {
  return createSyncEngine({
    store,
    lockName: "test-sync",
    owner,
    getAuth: getAuth || (async () => ({ token: "tok" })),
    send: send || ((req) => server.send(req)),
    timers: noTimers,
    locks,
    onAck: onAck || (async (entry, result) => {
      const existing = await store.getMatch(entry.payload.match_id);
      if (!existing) return null;
      return { ...existing, match: mergeMatchFromResult(existing.match, result) };
    }),
  });
}

// Distinct rallies are seconds apart in real play; tests fire them back to
// back, so the identical-tap window is disabled here (the "busy" guard stays)
// and covered by its own test below with a controlled clock.
function laneFor(store, match, owner = USER_A) {
  return createMatchLane({ store, matchId: match.id, owner, commandUrl: "https://x/command", publishableKey: "pk", minRepeatMs: 0 });
}

function applyEntry(match, entry) {
  const p = entry.payload;
  if (entry.type === "score_event") {
    const r = applyOptimisticScore(match, { id: p.event_id, seq: p.seq, type: p.type, payload: p.payload || {} });
    if (!r.applied && !r.duplicate) throw new Error("invalid");
    return r.match;
  }
  return match;
}

async function localView(store, matchId, owner = USER_A) {
  const base = await store.getMatch(matchId);
  const entries = (await store.list()).filter((e) => e.owner === owner && e.payload?.match_id === matchId);
  return reconstructMatchView({ baseMatch: base.match, entries, applyEntry });
}

async function scoreOffline(lane, store, matchId, teams) {
  for (const team of teams) {
    const view = await localView(store, matchId);
    lane.observeSeq(view.localLastSeq);
    const res = await lane.enqueue("point", { team });
    expect(res.accepted).toBe(true);
  }
}

async function setup(owner = USER_A) {
  const store = createMemoryStore();
  const server = createFakeServer();
  const match = startedMatch();
  server.seed(match);
  await store.putMatch({ matchId: match.id, owner, match, sides: [], participants: [], court: null, savedAt: 1 });
  return { store, server, match };
}

describe("write-ahead persistence", () => {
  it("a point is durably in the queue BEFORE any network send is attempted", async () => {
    const { store, server, match } = await setup();
    const send = vi.fn((req) => server.send(req));
    const lane = laneFor(store, match);
    const res = await lane.enqueue("point", { team: "A" });
    expect(res.accepted).toBe(true);
    expect(send).not.toHaveBeenCalled();
    const queued = await store.list();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ command_id: res.entry.payload.event_id, type: "score_event", status: "pending", owner: USER_A });
    expect(queued[0].payload).toMatchObject({ match_id: "m1", seq: 1, type: "point", payload: { team: "A" } });
  });

  it("a network failure leaves the command stored (retryable), and the local score still shows it", async () => {
    const { store, match } = await setup();
    const lane = laneFor(store, match);
    await lane.enqueue("point", { team: "A" });
    const engine = engineFor({ store, send: async () => { throw new TypeError("Failed to fetch"); } });
    await engine.kick();
    const queued = await store.list();
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("pending");
    expect(queued[0].attempts).toBe(1);
    expect(engine.status.offline).toBe(true);
    const view = await localView(store, "m1");
    expect(view.match.score_state.scoreA).toBe(1);
    expect(view.pending).toHaveLength(1);
  });

  it("if persistence fails the command is refused and its seq is handed back (no gap, nothing shown)", async () => {
    const { store, match } = await setup();
    const failing = { ...store, put: async () => { throw new Error("QuotaExceededError"); } };
    const lane = laneFor(failing, match);
    const res = await lane.enqueue("point", { team: "A" });
    expect(res).toMatchObject({ accepted: false, reason: "persist_failed" });
    expect(lane.lastSeq).toBe(0);
  });
});

describe("offline scoring + app restart", () => {
  it("scores several points offline, 'closes the app', reopens from disk with the same local score and queue, keeps scoring, then syncs exactly once each", async () => {
    const { store, server, match } = await setup();
    // Session 1: online point, then the network drops.
    let online = true;
    const send = async (req) => {
      if (!online) throw new TypeError("Failed to fetch");
      return server.send(req);
    };
    const lane1 = laneFor(store, match);
    const engine1 = engineFor({ store, send });
    await scoreOffline(lane1, store, "m1", ["A"]);
    await engine1.kick();
    expect(server.eventCount("m1")).toBe(1);

    online = false;
    await scoreOffline(lane1, store, "m1", ["A", "A", "B"]);
    await engine1.kick();
    expect(server.eventCount("m1")).toBe(1);
    const before = await localView(store, "m1");
    expect(before.pending).toHaveLength(3);

    // "Restart": every in-memory object is gone; only the store (disk) remains.
    engine1.stop();
    const reopened = await localView(store, "m1");
    expect(reopened.match.score_state).toMatchObject({ scoreA: before.match.score_state.scoreA, scoreB: before.match.score_state.scoreB, lastSeq: 4 });
    const lane2 = laneFor(store, match);
    lane2.observeSeq(reopened.localLastSeq);
    await scoreOffline(lane2, store, "m1", ["B"]);
    expect((await store.list()).map((e) => e.payload.seq)).toEqual([2, 3, 4, 5]);

    // Reconnect → a brand-new engine drains everything, in order.
    online = true;
    const engine2 = engineFor({ store, send });
    await engine2.kick();
    expect(await store.list()).toHaveLength(0);
    expect(server.eventCount("m1")).toBe(5);
    const local = await localView(store, "m1");
    expect(server.match("m1").score_state.lastSeq).toBe(5);
    expect(server.match("m1").score_state.scoreA).toBe(local.match.score_state.scoreA);
    expect(server.match("m1").score_state.scoreB).toBe(local.match.score_state.scoreB);
  });

  it("the confirmed base only moves forward (an old/idempotent result never rolls the score back)", () => {
    const newer = { matchId: "m1", match: { id: "m1", score_state: { lastSeq: 5, scoreA: 3 } } };
    const older = { matchId: "m1", match: { id: "m1", score_state: { lastSeq: 2, scoreA: 1 } }, court: { id: "c", name: "Court 9" } };
    const merged = mergeConfirmedRecord(newer, older);
    expect(merged.match.score_state.lastSeq).toBe(5);
    expect(merged.court).toEqual({ id: "c", name: "Court 9" });
  });
});

describe("timeout / lost response", () => {
  it("server accepted the command but the response was lost: the retry reuses the SAME command id and creates no second score", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    const res = await lane.enqueue("point", { team: "A" });
    let first = true;
    const send = async (req) => {
      const out = await server.send(req);
      if (first) {
        first = false;
        const err = new Error("No response from the server within 15s");
        err.timeout = true;
        err.code = "TIMEOUT";
        throw err;
      }
      return out;
    };
    const engine = engineFor({ store, send });
    await engine.kick(); // times out → kept
    expect(await store.list()).toHaveLength(1);
    expect(classifySendError(Object.assign(new Error("t"), { timeout: true }))).toBe("network");
    await engine.kick(); // retry
    expect(await store.list()).toHaveLength(0);
    expect(server.eventCount("m1")).toBe(1);
    expect(server.calls.map((c) => c.commandId)).toEqual([res.entry.command_id, res.entry.command_id]);
  });

  it("reconstruction skips an entry the server already applied (lost response) instead of double-counting it", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    const res = await lane.enqueue("point", { team: "A" });
    await server.send({ type: "score_event", payload: res.entry.payload, commandId: res.entry.command_id });
    await store.putMatch({ matchId: "m1", owner: USER_A, match: server.match("m1") });
    const view = await localView(store, "m1");
    expect(view.alreadyApplied).toHaveLength(1);
    expect(view.pending).toHaveLength(0);
    expect(view.match.score_state.scoreA).toBe(1);
  });

  it("sendCommand aborts a hanging request after timeoutMs with a retryable (status-less) timeout error", async () => {
    vi.stubGlobal("fetch", (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    try {
      const err = await sendCommand({ commandUrl: "https://x/command", accessToken: "t", publishableKey: "pk", type: "score_event", payload: {}, commandId: "c1", timeoutMs: 20 }).catch((e) => e);
      expect(err.timeout).toBe(true);
      expect(err.status).toBeUndefined();
      expect(classifySendError(err)).toBe("network");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("5xx", () => {
  it("keeps the local point pending (not discarded, not rolled back) and syncs it once the server recovers", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    await lane.enqueue("point", { team: "A" });
    let down = true;
    const engine = engineFor({ store, send: async (req) => { if (down) throw httpError(503, "UNAVAILABLE"); return server.send(req); } });
    await engine.kick();
    const kept = await store.list();
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe("pending");
    expect(kept[0].lastError.status).toBe(503);
    expect((await localView(store, "m1")).match.score_state.scoreA).toBe(1);
    down = false;
    await engine.kick();
    expect(await store.list()).toHaveLength(0);
    expect(server.eventCount("m1")).toBe(1);
  });
});

describe("401 / auth", () => {
  it("refreshes auth and retries the same entry — never marks it a conflict", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    await lane.enqueue("point", { team: "A" });
    const getAuth = vi.fn(async ({ force }) => ({ token: force ? "fresh" : "expired" }));
    const send = async (req) => {
      if (req.accessToken === "expired") throw httpError(401, "UNAUTHENTICATED");
      return server.send(req);
    };
    const engine = engineFor({ store, send, getAuth });
    await engine.kick();
    expect(getAuth).toHaveBeenCalledWith({ force: true });
    expect(await store.list()).toHaveLength(0);
    expect(server.eventCount("m1")).toBe(1);
  });

  it("when the session can't be refreshed, entries stay pending and the engine reports needsAuth", async () => {
    const { store, match } = await setup();
    const lane = laneFor(store, match);
    await lane.enqueue("point", { team: "A" });
    const getAuth = async ({ force }) => (force ? { needsAuth: true, message: "Sign in again" } : { token: "expired" });
    const engine = engineFor({ store, send: async () => { throw httpError(401, "UNAUTHENTICATED"); }, getAuth });
    await engine.kick();
    const kept = await store.list();
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe("pending");
    expect(engine.status.needsAuth).toBe("Sign in again");
    expect(engine.status.conflicts).toBe(0);
  });

  it("offline refresh (no network) is treated as offline, not as a sign-out", async () => {
    const { store, match } = await setup();
    const lane = laneFor(store, match);
    await lane.enqueue("point", { team: "A" });
    const send = vi.fn();
    const engine = engineFor({ store, send, getAuth: async () => ({ offline: true }) });
    await engine.kick();
    expect(send).not.toHaveBeenCalled();
    expect(engine.status.offline).toBe(true);
    expect(engine.status.needsAuth).toBeNull();
    expect(await store.list()).toHaveLength(1);
  });
});

describe("sequence allocation", () => {
  it("a correction and the next point get consecutive seqs (no reuse) and both apply on the server", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    await scoreOffline(lane, store, "m1", ["A", "A"]);
    const view = await localView(store, "m1");
    lane.observeSeq(view.localLastSeq);
    const corr = await lane.enqueue("correction", { scoreA: 5, scoreB: 3 });
    const next = await lane.enqueue("point", { team: "A" });
    expect(corr.entry.payload.seq).toBe(3);
    expect(next.entry.payload.seq).toBe(4);
    const engine = engineFor({ store, server });
    await engine.kick();
    expect(await store.list()).toHaveLength(0);
    expect(server.eventCount("m1")).toBe(4);
    expect(server.match("m1").score_state).toMatchObject({ lastSeq: 4, scoreA: 6, scoreB: 3 });
  });

  it("coin toss, undo and points all come from the same allocator", async () => {
    const { store, match } = await setup();
    const lane = laneFor(store, match);
    const a = await lane.enqueue("coin_toss", { result: "heads", winner: "A", serving_team: "A", court_side: "left" });
    const b = await lane.enqueue("point", { team: "A" });
    const c = await lane.enqueue("undo", {});
    expect([a, b, c].map((r) => r.entry.payload.seq)).toEqual([1, 2, 3]);
    expect(a.entry.command_id).toBe(a.entry.payload.event_id);
  });

  it("the allocator never goes below what is already queued or confirmed", async () => {
    const { store, match } = await setup();
    const lane = laneFor(store, match);
    lane.observeSeq(7);
    lane.observeSeq(3);
    const r = await lane.enqueue("point", { team: "B" });
    expect(r.entry.payload.seq).toBe(8);
  });
});

describe("double tap", () => {
  it("two taps fired at the same instant produce exactly one queued command", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    const [r1, r2] = await Promise.all([lane.enqueue("point", { team: "A" }), lane.enqueue("point", { team: "A" })]);
    expect([r1.accepted, r2.accepted].sort()).toEqual([false, true]);
    expect((r1.accepted ? r2 : r1).reason).toBe("busy");
    expect(await store.list()).toHaveLength(1);
    await engineFor({ store, server }).kick();
    expect(server.eventCount("m1")).toBe(1);
  });

  it("an identical tap repeated within the double-tap window is refused; a later one is accepted", async () => {
    let t = 1000;
    const store = createMemoryStore();
    const lane = createMatchLane({ store, matchId: "m1", owner: USER_A, now: () => t });
    expect((await lane.enqueue("point", { team: "A" })).accepted).toBe(true);
    t += 100;
    expect(await lane.enqueue("point", { team: "A" })).toMatchObject({ accepted: false, reason: "duplicate_tap" });
    t += 1000;
    expect((await lane.enqueue("point", { team: "A" })).accepted).toBe(true);
    expect((await store.list()).map((e) => e.payload.seq)).toEqual([1, 2]);
  });
});

describe("one sync worker per queue", () => {
  it("two engines (two windows) over the same queue: only one sends while the lock is held", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    await lane.enqueue("point", { team: "A" });
    const locks = createFakeLocks();
    let release;
    const gate = new Promise((r) => { release = r; });
    const slowSend = vi.fn(async (req) => { await gate; return server.send(req); });
    const fastSend = vi.fn((req) => server.send(req));
    const windowA = engineFor({ store, send: slowSend, locks });
    const windowB = engineFor({ store, send: fastSend, locks });
    const runA = windowA.kick();
    await vi.waitFor(() => expect(slowSend).toHaveBeenCalledTimes(1));
    await windowB.kick();
    expect(fastSend).not.toHaveBeenCalled();
    expect(windowB.status.lockedElsewhere).toBe(true);
    release();
    await runA;
    expect(server.eventCount("m1")).toBe(1);
    expect(server.calls).toHaveLength(1);
  });

  it("the localStorage lease fallback admits one holder at a time and frees on release/expiry", () => {
    const rows = new Map();
    const storage = { getItem: (k) => rows.get(k) ?? null, setItem: (k, v) => rows.set(k, v), removeItem: (k) => rows.delete(k) };
    let t = 0;
    const a = createStorageLease("q.lease", { storage, now: () => t, holder: "A", ttlMs: 1000 });
    const b = createStorageLease("q.lease", { storage, now: () => t, holder: "B", ttlMs: 1000 });
    expect(a.acquire()).toBe(true);
    expect(b.acquire()).toBe(false);
    a.release();
    expect(b.acquire()).toBe(true);
    t = 5000; // B crashed without releasing; its lease expired
    expect(a.acquire()).toBe(true);
  });
});

describe("conflicts (another device advanced the match)", () => {
  it("a rejected entry is kept and marked conflict; later entries in that match wait; nothing is deleted; other matches still sync", async () => {
    const { store, server, match } = await setup();
    const other = startedMatch("m2");
    server.seed(other);
    await store.putMatch({ matchId: "m2", owner: USER_A, match: other });
    const laneA = laneFor(store, match);
    const laneB = laneFor(store, other);
    await scoreOffline(laneA, store, "m1", ["A", "A"]);
    await laneB.enqueue("point", { team: "B" });
    // Device 2 scored m1 first (seq 1 and 2 are taken on the server).
    server.apply({ type: "score_event", payload: { match_id: "m1", event_id: "dev2-1", seq: 1, type: "point", payload: { team: "B" } }, commandId: "dev2-1" });
    server.apply({ type: "score_event", payload: { match_id: "m1", event_id: "dev2-2", seq: 2, type: "point", payload: { team: "B" } }, commandId: "dev2-2" });

    const engine = engineFor({ store, server });
    await engine.kick();

    const left = await store.list();
    expect(left.filter((e) => e.payload.match_id === "m1")).toHaveLength(2);
    expect(left.find((e) => e.payload.seq === 1).status).toBe("conflict");
    expect(left.find((e) => e.payload.seq === 1).lastError.status).toBe(409);
    expect(server.eventCount("m2")).toBe(1); // the unrelated match was not blocked
    expect(engine.status.conflicts).toBe(1);

    // Local view: server score is authoritative, this device's work is visible, not applied, not lost.
    await store.putMatch({ matchId: "m1", owner: USER_A, match: server.match("m1") });
    const view = await localView(store, "m1");
    expect(view.conflicts.length + view.blocked.length).toBe(2);
    expect(view.match.score_state.scoreB).toBe(server.match("m1").score_state.scoreB);

    // "Keep server score" archives — entries remain on disk, just never sent.
    await engine.archiveLane("m1");
    const archived = (await store.list()).filter((e) => e.payload.match_id === "m1");
    expect(archived).toHaveLength(2);
    expect(archived.every((e) => e.status === "discarded")).toBe(true);
    await engine.kick();
    expect(server.eventCount("m1")).toBe(2);
  });

  it("'apply this device's score as a correction' after a conflict produces one valid correction on the server", async () => {
    const { store, server, match } = await setup();
    const lane = laneFor(store, match);
    await scoreOffline(lane, store, "m1", ["A", "A", "A"]);
    server.apply({ type: "score_event", payload: { match_id: "m1", event_id: "x1", seq: 1, type: "point", payload: { team: "B" } }, commandId: "x1" });
    const engine = engineFor({ store, server });
    await engine.kick();
    const localScore = 3;
    await store.putMatch({ matchId: "m1", owner: USER_A, match: server.match("m1") });
    await engine.archiveLane("m1");
    lane.reset(server.match("m1").score_state.lastSeq);
    const corr = await lane.enqueue("correction", { scoreA: localScore, scoreB: 0 });
    expect(corr.entry.payload.seq).toBe(2);
    await engine.kick();
    expect(server.match("m1").score_state).toMatchObject({ scoreA: 3, scoreB: 0, lastSeq: 2 });
  });
});

describe("identity isolation (sign-out / unpair)", () => {
  it("entries created by user A are never sent by user B's engine", async () => {
    const { store, server, match } = await setup(USER_A);
    await laneFor(store, match, USER_A).enqueue("point", { team: "A" });
    const engineB = engineFor({ store, server, owner: USER_B });
    await engineB.kick();
    expect(server.calls).toHaveLength(0);
    expect(engineB.status.otherOwner).toBe(1);
    const engineA = engineFor({ store, server, owner: USER_A });
    await engineA.kick();
    expect(server.eventCount("m1")).toBe(1);
  });

  it("owner-less entries from an older app version are held until explicitly claimed", async () => {
    const { store, server } = await setup();
    await enqueueCommand(store, { command_id: "legacy-1", type: "score_event", payload: { match_id: "m1", event_id: "legacy-1", seq: 1, type: "point", payload: { team: "A" } } });
    const engine = engineFor({ store, server });
    await engine.kick();
    expect(server.calls).toHaveLength(0);
    expect(engine.status.unclaimed).toBe(1);
    await engine.claimUnowned();
    expect(server.eventCount("m1")).toBe(1);
    expect(await store.list()).toHaveLength(0);
  });
});

// Game timer + offline (scenarios A–E). The countdown is never sent over the
// network: every device computes it from the match's saved timer anchor
// (packages/engine gameTimer.js). These check that offline scoring, queued
// sync and reconnect never restart, rewind or corrupt that anchor. Start and
// Hold are online-only commands (umpire App.jsx onlineOnly), so here they are
// applied on the fake server and reach the device the way load() does: a
// fetched match row saved with store.putMatch.
describe("game timer with offline scoring", () => {
  const T0 = Date.parse("2026-09-28T10:00:00.000Z");
  const at = (sec) => T0 + sec * 1000;
  const setClock = (sec) => vi.setSystemTime(at(sec));
  const TEN_MIN = 600_000;

  function timedMatch() {
    return { ...startedMatch(), started_at: new Date(T0).toISOString(), completed_at: null, timer: startTimer(configureTimer(600, { now: T0 }), T0) };
  }

  async function timedSetup() {
    const store = createMemoryStore();
    const server = createFakeServer();
    const match = timedMatch();
    server.seed(match);
    await store.putMatch({ matchId: match.id, owner: USER_A, match, sides: [], participants: [], court: null, savedAt: 1 });
    let online = true;
    const send = async (req) => {
      if (!online) throw new TypeError("Failed to fetch");
      return server.send(req);
    };
    return { store, server, match, send, setOnline: (v) => { online = v; } };
  }

  // What the umpire's load() does on focus / Reload: save the fetched row.
  async function reload(store, server) {
    await store.putMatch({ matchId: "m1", owner: USER_A, match: structuredClone(server.match("m1")), savedAt: Date.now() });
  }

  const shown = async (store) => timerView((await localView(store, "m1")).match, Date.now());

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setClock(0);
  });
  afterEach(() => vi.useRealTimers());

  it("A: running timer → offline → scoring continues → timer keeps counting → reconnect syncs without restarting it", async () => {
    const { store, server, match, send, setOnline } = await timedSetup();
    const anchor = structuredClone(server.match("m1").timer);
    const lane = laneFor(store, match);
    const engine = engineFor({ store, send });

    setOnline(false);
    for (const [sec, team] of [[30, "A"], [75, "A"], [140, "B"]]) {
      setClock(sec);
      await scoreOffline(lane, store, "m1", [team]);
      await engine.kick(); // fails offline, entry kept
      expect(await shown(store)).toEqual({ state: "running", remainingMs: TEN_MIN - sec * 1000, durationSec: 600 });
    }
    expect(server.eventCount("m1")).toBe(0);
    expect(await store.list()).toHaveLength(3);

    setClock(200);
    setOnline(true);
    await engine.kick();
    await engine.kick(); // a second drain is a no-op
    expect(await store.list()).toHaveLength(0);
    expect(server.eventCount("m1")).toBe(3);
    expect(server.match("m1").timer).toEqual(anchor); // scoring never touches the timer
    expect(await shown(store)).toEqual({ state: "running", remainingMs: TEN_MIN - 200_000, durationSec: 600 });
    await reload(store, server);
    expect((await shown(store)).remainingMs).toBe(TEN_MIN - 200_000);
  });

  it("B: Hold banks 08:00 → offline → stays 08:00 however long → online Resume/Start continues from 08:00, not 10:00", async () => {
    const { store, server, setOnline } = await timedSetup();
    setClock(120);
    const m = server.match("m1");
    m.status = "postponed";
    m.timer = pauseTimer(m.timer, Date.now());
    await reload(store, server);
    expect(await shown(store)).toMatchObject({ state: "paused", remainingMs: 480_000 });

    setOnline(false);
    setClock(120 + 3600);
    expect(await shown(store)).toMatchObject({ state: "paused", remainingMs: 480_000 });

    // Back online: organizer resumes (ready), umpire starts — both on the server.
    setOnline(true);
    m.status = "ready";
    await reload(store, server);
    expect(await shown(store)).toMatchObject({ state: "paused", remainingMs: 480_000 });
    m.status = "in_progress";
    m.timer = startTimer(m.timer, Date.now());
    await reload(store, server);
    setClock(120 + 3600 + 60);
    expect(await shown(store)).toEqual({ state: "running", remainingMs: 420_000, durationSec: 600 });

    // Repeated Hold/Resume only counts running time.
    m.status = "postponed";
    m.timer = pauseTimer(m.timer, Date.now());
    setClock(120 + 3600 + 60 + 900);
    m.status = "in_progress";
    m.timer = startTimer(m.timer, Date.now());
    await reload(store, server);
    setClock(120 + 3600 + 60 + 900 + 20);
    expect((await shown(store)).remainingMs).toBe(400_000);
  });

  it("C: Operator changes the timer while the umpire is offline → umpire keeps scoring → reconnect picks up the change, with no duplicate events", async () => {
    const { store, server, match, send, setOnline } = await timedSetup();
    const lane = laneFor(store, match);
    const engine = engineFor({ store, send });
    setOnline(false);
    setClock(60);
    await scoreOffline(lane, store, "m1", ["A"]);
    const m = server.match("m1");
    m.timer = adjustTimer(m.timer, 60, { now: Date.now(), by: "organizer" }); // +1 min, server only
    setClock(90);
    await scoreOffline(lane, store, "m1", ["A"]);
    // The device hasn't seen the change yet: it keeps counting from its saved anchor.
    expect((await shown(store)).remainingMs).toBe(510_000);

    setOnline(true);
    await engine.kick();
    expect(server.eventCount("m1")).toBe(2);
    expect((await localView(store, "m1")).match.timer).toEqual(m.timer);
    expect((await shown(store)).remainingMs).toBe(570_000);

    // A retried command (same command id) is idempotent and adds nothing.
    await server.send(server.calls[0]);
    expect(server.eventCount("m1")).toBe(2);

    // A stale older row (lower lastSeq) never rolls the confirmed match back.
    await store.putMatch({ matchId: "m1", owner: USER_A, match: timedMatch(), savedAt: 0 });
    expect((await localView(store, "m1")).match.score_state.lastSeq).toBe(2);
    expect((await shown(store)).remainingMs).toBe(570_000);
  });

  it("D: timer reaches 00:00 while offline → scoring unaffected → reconnect does not restart it", async () => {
    const { store, server, match, send, setOnline } = await timedSetup();
    const anchor = structuredClone(server.match("m1").timer);
    const lane = laneFor(store, match);
    const engine = engineFor({ store, send });
    setOnline(false);
    setClock(599);
    expect(await shown(store)).toMatchObject({ state: "running", remainingMs: 1000 });
    setClock(700);
    expect(await shown(store)).toMatchObject({ state: "expired", remainingMs: 0 });
    await scoreOffline(lane, store, "m1", ["A", "B"]);
    const local = await localView(store, "m1");
    expect(local.match.status).toBe("in_progress");
    expect(local.match.score_state.lastSeq).toBe(2);

    setOnline(true);
    await engine.kick();
    expect(server.eventCount("m1")).toBe(2);
    expect(server.match("m1").status).toBe("in_progress");
    expect(server.match("m1").winner ?? null).toBeNull();
    expect(server.match("m1").timer).toEqual(anchor);
    await reload(store, server);
    setClock(900);
    expect(await shown(store)).toMatchObject({ state: "expired", remainingMs: 0 });
  });

  it("E: winning point scored offline → synced later → match completes → timer frozen and never restarts", async () => {
    const { store, server, match, send, setOnline } = await timedSetup();
    const lane = laneFor(store, match);
    const engine = engineFor({ store, send });
    setOnline(false);
    setClock(100);
    // Side-out scoring with A serving: A wins every rally, 11-0.
    await scoreOffline(lane, store, "m1", Array(11).fill("A"));
    expect((await localView(store, "m1")).match.score_state.status).toBe("completed");

    setClock(400);
    setOnline(true);
    await engine.kick();
    const done = server.match("m1");
    expect(done.status).toBe("completed");
    expect(done.completed_at).toBe(new Date(at(400)).toISOString());
    await reload(store, server);
    const frozen = await shown(store);
    expect(frozen).toEqual({ state: "finished", remainingMs: 200_000, durationSec: 600 });
    setClock(5000);
    expect(await shown(store)).toEqual(frozen);
    await engine.kick();
    expect(server.eventCount("m1")).toBe(11);
  });
});
