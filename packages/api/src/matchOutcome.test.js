// Win by default (declare_default_win) and Cancel (transition_match to
// cancelled/abandoned), through the real handleCommand() with an in-memory
// admin (same shape as completedCorrection.test.js). Team-elimination default
// wins are covered in teamProgression.test.js.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleCommand } from "./handleCommand.js";
import { timerView } from "@tournament/engine";

const tick = () => new Promise((r) => setTimeout(r, 0));

function createMemoryAdmin(seed) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const table = (name) => (tables[name] ||= []);
  function query(name) {
    const filters = [];
    let orderBy = null;
    const run = () => {
      let rows = table(name).filter((r) => filters.every((f) => f(r)));
      if (orderBy) rows = [...rows].sort((a, b) => (a[orderBy.col] < b[orderBy.col] ? -1 : a[orderBy.col] > b[orderBy.col] ? 1 : 0) * (orderBy.asc ? 1 : -1));
      return rows.map((r) => ({ ...r }));
    };
    const builder = {
      select() { return builder; },
      eq(col, v) { filters.push((r) => r[col] === v); return builder; },
      in(col, vs) { const s = new Set(vs); filters.push((r) => s.has(r[col])); return builder; },
      is(col, v) { filters.push((r) => (r[col] ?? null) === v); return builder; },
      order(col, opts = {}) { orderBy = { col, asc: opts.ascending !== false }; return builder; },
      limit() { return builder; },
      async maybeSingle() { await tick(); return { data: run()[0] ?? null, error: null }; },
      async single() { await tick(); return { data: run()[0] ?? null, error: null }; },
      then(resolve, reject) { return tick().then(() => ({ data: run(), error: null })).then(resolve, reject); },
    };
    return builder;
  }
  return {
    tables,
    from: (name) => query(name),
    async rpc(fn, { payload }) {
      await tick();
      for (const [name, rows] of Object.entries(payload.upserts || {})) {
        for (const row of rows) {
          const list = table(name);
          const i = list.findIndex((r) => r.id === row.id);
          if (i >= 0) list[i] = { ...list[i], ...row }; else list.push({ ...row });
        }
      }
      return { data: {}, error: null };
    },
  };
}

const T = "tournament-wo";
const D = "division-wo";
const ORGANIZER = { kind: "user", id: "organizer-1", email: "organizer@example.com" };
const UMPIRE = { kind: "user", id: "umpire-1", email: "umpire@example.com" };
const OTHER_UMPIRE = { kind: "user", id: "umpire-2", email: "umpire2@example.com" };
const STATION = { kind: "station", id: "dev-1", deviceId: "dev-1", courtId: "c-1", tournamentId: T };
const TS = "2026-10-01T00:00:00.000Z";
const T0 = Date.parse("2026-10-01T10:00:00.000Z");

// Two semifinals → final (slot A from SF1, slot B from SF2) and bronze (losers).
function fixture() {
  const m = (id, extra) => ({
    id, tournament_id: T, division_id: D, stage_id: null, stage_label: null, parent_match_id: null, pair_slot: null,
    bracket_side: "winners", round: 1, bracket_position: 0, status: "scheduled", winner: null, score_state: {},
    next_match_id: null, next_match_slot: null, loser_next_match_id: null, loser_next_match_slot: null,
    serving_team: null, coin_toss: null, team_a_wins: 0, team_b_wins: 0, started_at: null, completed_at: null,
    timer: null, created_at: TS, updated_at: TS, ...extra,
  });
  const matches = [
    m("sf1", { next_match_id: "final", next_match_slot: "A", loser_next_match_id: "bronze", loser_next_match_slot: "A" }),
    m("sf2", { bracket_position: 1, next_match_id: "final", next_match_slot: "B", loser_next_match_id: "bronze", loser_next_match_slot: "B" }),
    m("final", { round: 2, bracket_side: "final" }),
    m("bronze", { round: 2, bracket_position: 1, bracket_side: "bronze", stage_label: "bronze" }),
  ];
  const side = (mid, slot, pid) => ({ id: `${mid}-${slot}`, match_id: mid, slot, participant_id: pid, team_id: null });
  return createMemoryAdmin({
    tournaments: [{ id: T, name: "Open", status: "live" }],
    tournament_members: [
      { id: "tm-o", tournament_id: T, user_id: ORGANIZER.id, role: "organizer" },
      { id: "tm-u", tournament_id: T, user_id: UMPIRE.id, role: "umpire" },
      { id: "tm-u2", tournament_id: T, user_id: OTHER_UMPIRE.id, role: "umpire" },
    ],
    licenses: [{ id: "lic-1", email: ORGANIZER.email, status: "active", expires_at: null, created_at: TS }],
    divisions: [{ id: D, tournament_id: T, name: "Open", format: "single_elim", config: { winTo: 11, bestOf: 1 } }],
    participants: ["p1", "p2", "p3", "p4"].map((id) => ({ id, tournament_id: T, division_id: D, display_name: id.toUpperCase() })),
    stages: [],
    matches,
    match_participants: [side("sf1", "A", "p1"), side("sf1", "B", "p2"), side("sf2", "A", "p3"), side("sf2", "B", "p4")],
    umpire_assignments: [{ id: "ua-1", match_id: "sf1", user_id: UMPIRE.id }, { id: "ua-2", match_id: "final", user_id: UMPIRE.id }],
    court_assignments: [{ id: "ca-1", match_id: "sf1", court_id: "c-1" }],
    court_devices: [{ id: "dev-1", tournament_id: T, court_id: "c-1", status: "active" }],
    command_receipts: [],
    audit_logs: [],
    score_events: [],
    match_results: [],
    courts: [],
  });
}

const send = (admin, actor, type, payload) =>
  handleCommand({ admin, actor, body: { command_id: crypto.randomUUID(), type, payload } });
const fail = (p) => p.then(() => { throw new Error("unexpectedly succeeded"); }, (e) => e);
const row = (admin, id) => admin.tables.matches.find((m) => m.id === id);
const pairsIn = (admin, id) => ["A", "B"].map((s) => admin.tables.match_participants.find((x) => x.match_id === id && x.slot === s)?.participant_id ?? null);
const defaultWin = (admin, actor, id, winner, reason = "No show") => send(admin, actor, "declare_default_win", { match_id: id, winner, reason });
const cancel = (admin, actor, id, status, reason = "Rain") => send(admin, actor, "transition_match", { match_id: id, status, reason });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("declare_default_win", () => {
  test("a not-started semifinal: completed 0–0 W/O, winner to the final, loser to bronze", async () => {
    const admin = fixture();
    const res = await defaultWin(admin, ORGANIZER, "sf1", "B");
    expect(res.ok).toBe(true);
    const sf = row(admin, "sf1");
    expect(sf).toMatchObject({ status: "completed", winner: "B" });
    expect(sf.score_state).toMatchObject({ scoreA: 0, scoreB: 0, status: "completed", winner: "B", defaultWin: { winner: "B", reason: "No show" } });
    const result = admin.tables.match_results.find((r) => r.match_id === "sf1");
    expect(result).toMatchObject({ winner_slot: "B", winner_participant_id: "p2", score_a: 0, score_b: 0 });
    expect(pairsIn(admin, "final")).toEqual(["p2", null]);
    expect(pairsIn(admin, "bronze")).toEqual(["p1", null]);
    expect(JSON.stringify(admin.tables.audit_logs.at(-1))).toContain("default_win");
  });

  test("a live match: the game timer is banked, points so far are replaced by the W/O", async () => {
    const admin = fixture();
    Object.assign(row(admin, "sf1"), {
      status: "in_progress", started_at: TS,
      score_state: { scoreA: 6, scoreB: 4, status: "in_progress", lastSeq: 10, winTo: 11 },
      timer: { v: 1, durationSec: 600, remainingMs: 600000, runningSince: new Date(T0 - 60000).toISOString() },
    });
    expect((await defaultWin(admin, UMPIRE, "sf1", "A")).ok).toBe(true);
    const sf = row(admin, "sf1");
    expect(sf.score_state).toMatchObject({ scoreA: 0, scoreB: 0, winner: "A", lastSeq: 10 });
    expect(sf.timer.runningSince).toBeNull();
    expect(timerView(sf, Date.now())).toMatchObject({ state: "finished", remainingMs: 540000 });
    expect(pairsIn(admin, "final")).toEqual(["p1", null]);
  });

  test("a held match can be won by default", async () => {
    const admin = fixture();
    row(admin, "sf1").status = "postponed";
    expect((await defaultWin(admin, ORGANIZER, "sf1", "A")).ok).toBe(true);
    expect(row(admin, "sf1").status).toBe("completed");
  });

  test("the assigned umpire may; another umpire and a court station may not", async () => {
    const admin = fixture();
    expect(await fail(defaultWin(admin, OTHER_UMPIRE, "sf1", "A"))).toMatchObject({ status: 403 });
    expect(await fail(defaultWin(admin, STATION, "sf1", "A"))).toMatchObject({ status: 403 });
    expect(row(admin, "sf1").status).toBe("scheduled");
    expect((await defaultWin(admin, UMPIRE, "sf1", "A")).ok).toBe(true);
  });

  test("reason and a valid winner are required", async () => {
    const admin = fixture();
    expect(await fail(defaultWin(admin, ORGANIZER, "sf1", "A", "  "))).toMatchObject({ status: 400, code: "REASON_REQUIRED" });
    expect(await fail(defaultWin(admin, ORGANIZER, "sf1", "C"))).toMatchObject({ status: 400, code: "INVALID_COMMAND" });
    expect(row(admin, "sf1").status).toBe("scheduled");
  });

  test("a completed or cancelled match can't be won by default", async () => {
    const admin = fixture();
    await defaultWin(admin, ORGANIZER, "sf1", "A");
    expect(await fail(defaultWin(admin, ORGANIZER, "sf1", "B"))).toMatchObject({ status: 409, code: "MATCH_NOT_ACTIVE" });
    row(admin, "sf2").status = "cancelled";
    expect(await fail(defaultWin(admin, ORGANIZER, "sf2", "B"))).toMatchObject({ status: 409, code: "MATCH_NOT_ACTIVE" });
  });

  test("a match with an empty side is refused", async () => {
    const admin = fixture();
    const err = await fail(defaultWin(admin, ORGANIZER, "final", "A"));
    expect(err.status).toBe(409);
    expect(row(admin, "final").status).toBe("scheduled");
  });

  test("Edit score on a default win is refused", async () => {
    const admin = fixture();
    await defaultWin(admin, ORGANIZER, "sf1", "A");
    const err = await fail(send(admin, ORGANIZER, "score_event", {
      match_id: "sf1", event_id: crypto.randomUUID(), seq: 1, type: "correction",
      payload: { scoreA: 11, scoreB: 5, confirm_completed: true, reason: "x" },
    }));
    expect([err.status, err.code]).toEqual([409, "DEFAULT_WIN"]);
  });
});

describe("cancel a match (transition_match)", () => {
  async function readyFinal(admin) {
    await defaultWin(admin, ORGANIZER, "sf1", "A");
    await defaultWin(admin, ORGANIZER, "sf2", "A");
  }

  test("the final (feeds nothing) before play → cancelled, by the organizer", async () => {
    const admin = fixture();
    await readyFinal(admin);
    expect((await cancel(admin, ORGANIZER, "final", "cancelled")).ok).toBe(true);
    expect(row(admin, "final")).toMatchObject({ status: "cancelled", winner: null });
  });

  test("a live final → abandoned (no result), by its assigned umpire; the timer is banked", async () => {
    const admin = fixture();
    await readyFinal(admin);
    Object.assign(row(admin, "final"), {
      status: "in_progress", started_at: TS,
      timer: { v: 1, durationSec: 600, remainingMs: 600000, runningSince: new Date(T0 - 60000).toISOString() },
    });
    expect((await cancel(admin, UMPIRE, "final", "abandoned")).ok).toBe(true);
    expect(row(admin, "final")).toMatchObject({ status: "abandoned", winner: null });
    expect(row(admin, "final").timer.runningSince).toBeNull();
  });

  test("a live match can't jump to cancelled", async () => {
    const admin = fixture();
    await readyFinal(admin);
    row(admin, "final").status = "in_progress";
    expect(await fail(cancel(admin, ORGANIZER, "final", "cancelled"))).toMatchObject({ status: 409, code: "ILLEGAL_TRANSITION" });
  });

  test("a bracket match whose result feeds the next round is refused, even for the organizer", async () => {
    const admin = fixture();
    expect(await fail(cancel(admin, ORGANIZER, "sf1", "cancelled"))).toMatchObject({ status: 409, code: "CANCEL_BLOCKS_BRACKET" });
    row(admin, "sf1").status = "in_progress";
    expect(await fail(cancel(admin, UMPIRE, "sf1", "abandoned"))).toMatchObject({ status: 409, code: "CANCEL_BLOCKS_BRACKET" });
    expect(row(admin, "sf1").status).toBe("in_progress");
  });

  test("a reason is required", async () => {
    const admin = fixture();
    await readyFinal(admin);
    expect(await fail(cancel(admin, ORGANIZER, "final", "cancelled", ""))).toMatchObject({ status: 400, code: "REASON_REQUIRED" });
  });

  test("another umpire can't cancel; the assigned umpire still can't make other transitions", async () => {
    const admin = fixture();
    await readyFinal(admin);
    expect(await fail(cancel(admin, OTHER_UMPIRE, "final", "cancelled"))).toMatchObject({ status: 403 });
    expect(await fail(cancel(admin, UMPIRE, "final", "ready"))).toMatchObject({ status: 403 });
  });

  test("hold still works for the umpire with no reason", async () => {
    const admin = fixture();
    row(admin, "sf1").status = "in_progress";
    const res = await send(admin, UMPIRE, "transition_match", { match_id: "sf1", status: "postponed" });
    expect(res.ok).toBe(true);
    expect(row(admin, "sf1").status).toBe("postponed");
  });
});

describe("win by default with a recorded (administrative) score", () => {
  const result = (admin, id) => admin.tables.match_results.find((r) => r.match_id === id);
  const setScore = (admin, actor, id, score, reason = "Scoresheet") => send(admin, actor, "set_default_win_score", { match_id: id, score, reason });

  test("records the score while the result stays Won by Default; advancement is the same", async () => {
    const admin = fixture();
    const res = await send(admin, ORGANIZER, "declare_default_win", { match_id: "sf1", winner: "A", reason: "Retired", score: { a: 11, b: 4 } });
    expect(res.ok).toBe(true);
    expect(row(admin, "sf1")).toMatchObject({ status: "completed", winner: "A" });
    expect(row(admin, "sf1").score_state).toMatchObject({ scoreA: 11, scoreB: 4, games: [], winner: "A", defaultWin: { winner: "A", reason: "Retired", score: { a: 11, b: 4 } } });
    expect(result(admin, "sf1")).toMatchObject({ winner_slot: "A", winner_participant_id: "p1", score_a: 11, score_b: 4 });
    expect(pairsIn(admin, "final")).toEqual(["p1", null]);
    expect(pairsIn(admin, "bronze")).toEqual(["p2", null]);
    expect(admin.tables.score_events).toHaveLength(0);
    expect(JSON.stringify(admin.tables.audit_logs.at(-1).detail)).toContain("\"score\":{\"a\":11,\"b\":4}");
  });

  test("without a score it is exactly the existing 0–0 W/O (no score key)", async () => {
    const admin = fixture();
    await defaultWin(admin, ORGANIZER, "sf1", "B");
    expect(row(admin, "sf1").score_state.defaultWin).not.toHaveProperty("score");
    expect(result(admin, "sf1")).toMatchObject({ score_a: 0, score_b: 0 });
  });

  test("rejects a score that contradicts the winner, a tie, an over-target or malformed score — nothing written", async () => {
    const admin = fixture();
    const bad = [
      [{ a: 4, b: 11 }, 400, "SCORE_WINNER_MISMATCH"],
      [{ a: 6, b: 6 }, 400, "SCORE_WINNER_MISMATCH"],
      [{ a: 15, b: 0 }, 400, "INVALID_SCORE"],
      [{ a: "11", b: 0 }, 400, "INVALID_SCORE"],
      [[11, 0], 400, "INVALID_SCORE"],
    ];
    for (const [score, status, code] of bad) {
      const err = await fail(send(admin, ORGANIZER, "declare_default_win", { match_id: "sf1", winner: "A", reason: "x", score }));
      expect([err.status, err.code]).toEqual([status, code]);
    }
    expect(row(admin, "sf1").status).toBe("scheduled");
    expect(admin.tables.match_results).toHaveLength(0);
  });

  test("a multi-game match can't take a W/O score", async () => {
    const admin = fixture();
    admin.tables.divisions[0].config = { winTo: 11, bestOf: 3 };
    const err = await fail(send(admin, ORGANIZER, "declare_default_win", { match_id: "sf1", winner: "A", reason: "x", score: { a: 11, b: 0 } }));
    expect([err.status, err.code]).toEqual([409, "CORRECTION_UNSUPPORTED"]);
  });

  test("set_default_win_score adds, corrects and clears the score; the winner never changes; history is kept", async () => {
    const admin = fixture();
    await defaultWin(admin, ORGANIZER, "sf1", "B");
    expect((await setScore(admin, ORGANIZER, "sf1", { a: 2, b: 11 })).ok).toBe(true);
    expect(row(admin, "sf1")).toMatchObject({ status: "completed", winner: "B" });
    expect(row(admin, "sf1").score_state).toMatchObject({ scoreA: 2, scoreB: 11, defaultWin: { winner: "B", reason: "No show", score: { a: 2, b: 11 } } });
    expect(result(admin, "sf1")).toMatchObject({ winner_slot: "B", score_a: 2, score_b: 11 });
    await setScore(admin, ORGANIZER, "sf1", { a: 5, b: 11 }, "Typo");
    await setScore(admin, ORGANIZER, "sf1", null, "No score after all");
    const dw = row(admin, "sf1").score_state.defaultWin;
    expect(dw).not.toHaveProperty("score");
    expect(dw.scoreHistory.map((h) => [h.from, h.to, h.reason])).toEqual([
      [null, { a: 2, b: 11 }, "Scoresheet"],
      [{ a: 2, b: 11 }, { a: 5, b: 11 }, "Typo"],
      [{ a: 5, b: 11 }, null, "No score after all"],
    ]);
    expect(result(admin, "sf1")).toMatchObject({ winner_slot: "B", score_a: 0, score_b: 0 });
    expect(pairsIn(admin, "final")).toEqual(["p2", null]);
    expect(JSON.stringify(admin.tables.audit_logs.at(-1).detail)).toContain("default_win_score");
  });

  test("set_default_win_score refuses a score that would flip the winner, a played match, a missing reason", async () => {
    const admin = fixture();
    await defaultWin(admin, ORGANIZER, "sf1", "B");
    let err = await fail(setScore(admin, ORGANIZER, "sf1", { a: 11, b: 2 }));
    expect([err.status, err.code]).toEqual([400, "SCORE_WINNER_MISMATCH"]);
    expect(row(admin, "sf1").winner).toBe("B");
    err = await fail(setScore(admin, ORGANIZER, "sf2", { a: 11, b: 2 }));
    expect([err.status, err.code]).toEqual([409, "NOT_DEFAULT_WIN"]);
    err = await fail(setScore(admin, ORGANIZER, "sf1", { a: 2, b: 11 }, " "));
    expect([err.status, err.code]).toEqual([400, "REASON_REQUIRED"]);
  });

  test("set_default_win_score is organizer-only: umpires and court stations are refused", async () => {
    const admin = fixture();
    await defaultWin(admin, ORGANIZER, "sf1", "B");
    for (const actor of [UMPIRE, STATION]) {
      const err = await fail(setScore(admin, actor, "sf1", { a: 2, b: 11 }));
      expect(err.status).toBe(403);
    }
    expect(row(admin, "sf1").score_state.defaultWin).not.toHaveProperty("score");
  });

  test("the ordinary score correction path still refuses a W/O match", async () => {
    const admin = fixture();
    await send(admin, ORGANIZER, "declare_default_win", { match_id: "sf1", winner: "A", reason: "x", score: { a: 11, b: 0 } });
    const err = await fail(send(admin, ORGANIZER, "score_event", {
      match_id: "sf1", event_id: crypto.randomUUID(), seq: 1, type: "correction",
      payload: { scoreA: 11, scoreB: 3, confirm_completed: true, reason: "x" },
    }));
    expect([err.status, err.code]).toEqual([409, "DEFAULT_WIN"]);
  });
});
