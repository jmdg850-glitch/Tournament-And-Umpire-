// Headless, browser-free reproduction of the umpire's real offline scoring
// lifecycle: optimistic apply (packages/engine) + durable queue + drain
// (offlineQueue.js) + local snapshot (matchSnapshot.js), composed exactly the
// way apps/umpire/src/App.jsx wires them, via dependency-injected `send`
// mocks — the same style already established in offlineQueue.test.js. This
// is what actually proves the real-world bug scenarios in the bug report,
// which offlineQueue.test.js alone (queue algorithm only, no scoring) never
// exercised.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryStore, sendCommandDurable, drainQueue, isNetworkError } from "./offlineQueue.js";
import { readMatchSnapshot, writeMatchSnapshot, clearMatchSnapshot } from "./matchSnapshot.js";
import { applyOptimisticScore, mergeMatchFromResult, reconcileAuthoritativeScore, createInitialScoreState } from "@tournament/engine";

// Builds a fully-shaped score_state (history, server, etc. all present, as
// createInitialScoreState produces) but pre-advanced to an arbitrary
// lastSeq/scoreA/scoreB, so tests can start "mid-match" without needing to
// replay every prior point through the real reducer.
function baseState(lastSeq, scoreA, scoreB, settingsOverride = settings) {
  const st = createInitialScoreState(settingsOverride);
  return { ...st, lastSeq, scoreA, scoreB, appliedEventIds: Array.from({ length: lastSeq }, (_, i) => `seed-${i}`) };
}

function fakeLocalStorage() {
  const rows = new Map();
  return {
    getItem: (k) => (rows.has(k) ? rows.get(k) : null),
    setItem: (k, v) => rows.set(k, v),
    removeItem: (k) => rows.delete(k),
  };
}

function networkError() {
  return new Error("fetch failed");
}

function serverError(status, code, message = "rejected") {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

// A tiny stand-in for the real server: authoritative per-match score_events
// log with the SAME dedup guarantees the real schema enforces (score_events
// primary key on event id, unique(match_id, seq)) and the same seq<=lastSeq
// rejection scoring.js's applyScoreEvent already implements — so a test
// proving "exactly one event survives a retry" here is a faithful stand-in
// for the real unique constraints, not a weaker approximation.
function createFakeServer(settings = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" }) {
  const byMatch = new Map(); // matchId -> { events: Map(event_id -> event), state }
  function matchRow(matchId) {
    if (!byMatch.has(matchId)) byMatch.set(matchId, { events: new Map(), state: null });
    return byMatch.get(matchId);
  }
  return {
    eventCount(matchId) {
      return matchRow(matchId).events.size;
    },
    stateOf(matchId) {
      return matchRow(matchId).state;
    },
    // Test-only: seed the server's baseline for a match to the SAME starting
    // state the client's local `match` begins from, so a test can start
    // "mid-match" (e.g. already at 6-4) instead of always from scratch.
    seed(matchId, state) {
      matchRow(matchId).state = state;
    },
    // Mimics sendCommand's contract: resolves {ok:true, result:{match:{id,score_state}}}
    // on success, throws an Error with .status set on a real rejection.
    async send({ type, payload, commandId }) {
      if (type !== "score_event") throw serverError(400, "UNSUPPORTED", "fake server only understands score_event");
      const row = matchRow(payload.match_id);
      const existing = row.events.get(payload.event_id);
      if (existing) {
        return { ok: true, result: { match: { id: payload.match_id, score_state: row.state } } };
      }
      const lastSeq = row.state?.lastSeq ?? 0;
      if (payload.seq <= lastSeq) {
        throw serverError(409, "OUT_OF_ORDER", `seq ${payload.seq} <= lastSeq ${lastSeq}`);
      }
      const event = { id: payload.event_id, seq: payload.seq, type: payload.type, payload: payload.payload };
      const applied = applyOptimisticScore({ id: payload.match_id, score_state: row.state }, event, settings);
      row.events.set(payload.event_id, event);
      row.state = applied.state;
      return { ok: true, result: { match: { id: payload.match_id, score_state: row.state } } };
    },
  };
}

const settings = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" };

describe("TEST 1 — online scoring: no queueing, server matches immediately", () => {
  it("6-4 -> 7-4 -> 8-4, three sequential taps, all reach the server, queue stays empty", async () => {
    const server = createFakeServer();
    const store = createMemoryStore();
    let match = { id: "m1", status: "in_progress", score_state: baseState(4, 6, 4) };
    server.seed("m1", match.score_state); // server starts from the same 6-4/lastSeq-4 baseline as the client
    for (let i = 0; i < 3; i++) {
      const event_id = crypto.randomUUID();
      const seq = match.score_state.lastSeq + 1;
      const optimistic = applyOptimisticScore(match, { id: event_id, seq, type: "point", payload: { team: "A" } }, settings);
      match = optimistic.match;
      const body = await sendCommandDurable({
        store,
        send: (args) => server.send(args),
        type: "score_event",
        commandId: event_id,
        payload: { match_id: "m1", event_id, seq, type: "point", payload: { team: "A" } },
      });
      expect(body.queued).toBeUndefined();
      match = { ...match, score_state: reconcileAuthoritativeScore(match.score_state, body.result.match.score_state).state };
    }
    expect(match.score_state.scoreA).toBe(9); // 6-4 -> 7-4 -> 8-4 -> 9-4, matching the bug report's example
    expect(server.stateOf("m1").scoreA).toBe(match.score_state.scoreA);
    expect(server.eventCount("m1")).toBe(3);
    expect((await store.list()).length).toBe(0);
  });
});

describe("TEST 2 — offline scoring then reconnect", () => {
  it("3 taps while offline are all queued and shown locally; reconnecting drains them and the fake server converges to the same score", async () => {
    const server = createFakeServer();
    const store = createMemoryStore();
    let match = { id: "m1", status: "in_progress", score_state: baseState(4, 6, 4) };
    server.seed("m1", match.score_state);
    let send = () => Promise.reject(networkError()); // offline
    for (let i = 0; i < 3; i++) {
      const event_id = crypto.randomUUID();
      const seq = match.score_state.lastSeq + 1;
      match = applyOptimisticScore(match, { id: event_id, seq, type: "point", payload: { team: "A" } }, settings).match;
      const body = await sendCommandDurable({
        store,
        send,
        type: "score_event",
        commandId: event_id,
        payload: { match_id: "m1", event_id, seq, type: "point", payload: { team: "A" } },
      });
      expect(body.queued).toBe(true);
    }
    // Still offline: the UI-equivalent local state already shows the full
    // advance, but the "server" has not seen anything yet.
    expect(match.score_state.scoreA).toBe(9);
    expect(server.eventCount("m1")).toBe(0);
    expect((await store.list()).length).toBe(3);

    // Reconnect.
    send = (args) => server.send(args);
    const outcome = await drainQueue({
      store,
      send,
      getAccessToken: async () => "tok",
      publishableKey: "pk",
      onEach: (entry, result) => {
        if (result) match = { ...match, score_state: reconcileAuthoritativeScore(match.score_state, result.result.match.score_state).state };
      },
    });
    expect(outcome).toEqual({ drained: 3, remaining: 0, stoppedOn: null });
    expect((await store.list()).length).toBe(0);
    expect(server.stateOf("m1").scoreA).toBe(9);
    expect(match.score_state.scoreA).toBe(9);
  });
});

describe("TEST 3 — offline refresh: the durable snapshot survives a simulated reload", () => {
  beforeEach(() => {
    globalThis.localStorage = fakeLocalStorage();
  });

  it("9-4 -> +1 -> +1 -> +1 while offline, then a simulated reload still shows 11-4 with the 3 commands still queued", async () => {
    const store = createMemoryStore(); // stands in for the IndexedDB outbox, which — like localStorage — survives a real reload
    let match = { id: "m1", status: "in_progress", score_state: baseState(4, 9, 4) };
    const send = () => Promise.reject(networkError());
    for (let i = 0; i < 3; i++) {
      const event_id = crypto.randomUUID();
      const seq = match.score_state.lastSeq + 1;
      match = applyOptimisticScore(match, { id: event_id, seq, type: "point", payload: { team: "A" } }, settings).match;
      writeMatchSnapshot("m1", match, match.score_state.lastSeq); // App.jsx's [match]-effect, done explicitly here
      await sendCommandDurable({
        store,
        send,
        type: "score_event",
        commandId: event_id,
        payload: { match_id: "m1", event_id, seq, type: "point", payload: { team: "A" } },
      });
    }
    expect(match.score_state.scoreA).toBe(12); // 9 + 3

    // --- simulated hard reload while still offline: a fresh module read of
    // localStorage (the snapshot) and of the queue (the durable outbox) is
    // exactly what App.jsx's lazy useState/useRef initializers do on mount.
    const rehydrated = readMatchSnapshot();
    expect(rehydrated.matchId).toBe("m1");
    const rehydratedMatch = rehydrated.match;
    const rehydratedSeq = rehydrated.seq;

    expect(rehydratedMatch.score_state.scoreA).toBe(12);
    expect(rehydratedSeq).toBe(7); // lastSeq after 3 taps from a base of 4
    expect((await store.list()).length).toBe(3); // the queue itself, unaffected by the "reload"
  });
});

describe("TEST 5 — network flapping: no lost or duplicated events across alternating outages", () => {
  it("online -> offline -> online -> offline -> online while scoring converges to the correct total with no duplicate event ids server-side", async () => {
    const server = createFakeServer();
    const store = createMemoryStore();
    let match = { id: "m1", status: "in_progress", score_state: baseState(0, 0, 0) };
    const online = (args) => server.send(args);
    const offline = () => Promise.reject(networkError());
    const pattern = [online, offline, online, offline, online, online, offline, online];

    for (const send of pattern) {
      const event_id = crypto.randomUUID();
      const seq = match.score_state.lastSeq + 1;
      match = applyOptimisticScore(match, { id: event_id, seq, type: "point", payload: { team: "A" } }, settings).match;
      // Mirrors App.jsx's sendScore: never attempt a live send while an
      // earlier event for this match is still queued, even if THIS
      // particular attempt would otherwise succeed — otherwise a later tap
      // can leapfrog an earlier queued one and open a gap.
      const forceQueue = (await store.list()).some((e) => e.payload?.match_id === "m1");
      await sendCommandDurable({
        store,
        send,
        type: "score_event",
        commandId: event_id,
        payload: { match_id: "m1", event_id, seq, type: "point", payload: { team: "A" } },
        forceQueue,
      });
    }
    // Drain whatever is left after the flapping sequence.
    await drainQueue({ store, send: online, getAccessToken: async () => "tok", publishableKey: "pk" });

    expect((await store.list()).length).toBe(0);
    expect(server.eventCount("m1")).toBe(pattern.length);
    expect(server.stateOf("m1").scoreA).toBe(pattern.length);
    expect(match.score_state.scoreA).toBe(pattern.length);
  });
});

describe("TEST 6 — lost response: retrying the SAME command_id/event_id never creates a second score event", () => {
  it("server applies the event once; a resend after the client 'lost' the response is a no-op (idempotent) on the fake server's own event-id dedup", async () => {
    const server = createFakeServer();
    const event_id = crypto.randomUUID();
    const payload = { match_id: "m1", event_id, seq: 1, type: "point", payload: { team: "A" } };

    const first = await server.send({ type: "score_event", payload, commandId: event_id });
    expect(first.result.match.score_state.scoreA).toBe(1);

    // Client thinks the first attempt failed (response lost) and retries with
    // the identical command_id/event_id — exactly what drainQueue/
    // sendCommandDurable already guarantee by construction (they always
    // reuse the original id, never mint a new one on retry).
    const second = await server.send({ type: "score_event", payload, commandId: event_id });
    expect(second.result.match.score_state.scoreA).toBe(1); // unchanged, not double-applied

    expect(server.eventCount("m1")).toBe(1);
  });
});

describe("cross-match contamination: a drained result for match A must never bleed onto match B", () => {
  it("mergeMatchFromResult ignores a stale match-A result while match B is on screen", () => {
    const matchB = { id: "m2", status: "in_progress", score_state: { lastSeq: 2, scoreA: 2, scoreB: 0 } };
    const staleResultFromA = { match: { id: "m1", status: "completed", score_state: { lastSeq: 9, scoreA: 11, scoreB: 4 }, winner: "A" } };
    const merged = mergeMatchFromResult(matchB, staleResultFromA);
    expect(merged).toBe(matchB);
    expect(merged.status).toBe("in_progress");
    expect(merged.score_state.scoreA).toBe(2);
  });
});

describe("organizer-correction-vs-offline-umpire fork: load() must not let a stale fetch clobber a mid-drain optimistic view, and a real conflict must surface as an actionable rejection, not a silent loop", () => {
  it("a queued backlog rejected by a since-corrected server surfaces as a genuine (non-network) rejection, and drainQueue stops rather than retrying forever", async () => {
    const server = createFakeServer();
    const store = createMemoryStore();
    // Umpire went offline at lastSeq=4 and queued 2 points (seq 5, 6).
    let match = { id: "m1", status: "in_progress", score_state: baseState(4, 6, 4) };
    const offline = () => Promise.reject(networkError());
    for (const _ of [1, 2]) {
      const event_id = crypto.randomUUID();
      const seq = match.score_state.lastSeq + 1;
      match = applyOptimisticScore(match, { id: event_id, seq, type: "point", payload: { team: "A" } }, settings).match;
      await sendCommandDurable({
        store, send: offline, type: "score_event", commandId: event_id,
        payload: { match_id: "m1", event_id, seq, type: "point", payload: { team: "A" } },
      });
    }
    expect(match.score_state.scoreA).toBe(8); // locally-optimistic view is ahead

    // Meanwhile, an organizer correction lands directly on the fake server —
    // out of band, nothing to do with the umpire's queue — advancing the
    // server straight to lastSeq=6 with a DIFFERENT score than what the
    // umpire's queued (now stale) seq-5/seq-6 events assumed.
    await server.send({
      type: "score_event",
      commandId: "organizer-correction",
      payload: { match_id: "m1", event_id: "organizer-correction", seq: 5, type: "correction", payload: { scoreA: 7, scoreB: 4 } },
    });
    await server.send({
      type: "score_event",
      commandId: "organizer-correction-2",
      payload: { match_id: "m1", event_id: "organizer-correction-2", seq: 6, type: "point", payload: { team: "B" } },
    });
    expect(server.stateOf("m1").lastSeq).toBe(6);

    // Umpire reconnects; the queued seq-5 event is now a genuine, permanent
    // conflict (seq 5 <= server lastSeq 6) — a real rejection, not a network
    // error, and drainQueue must stop there rather than skip ahead or loop.
    const rejections = [];
    const outcome = await drainQueue({
      store,
      send: (args) => server.send(args),
      getAccessToken: async () => "tok",
      publishableKey: "pk",
      onEach: (entry, result, err) => { if (err) rejections.push(err); },
    });
    expect(outcome.stoppedOn).toBe("rejected");
    expect(outcome.drained).toBe(0);
    expect(outcome.remaining).toBe(2);
    expect(rejections).toHaveLength(1);
    expect(isNetworkError(rejections[0])).toBe(false);
    expect(rejections[0].code).toBe("OUT_OF_ORDER");
    // The two stale queued commands are left exactly as-is — nothing was
    // silently dropped or double-applied.
    expect((await store.list()).length).toBe(2);
  });
});
