// Operator → Edit score on a completed single-elimination match, through the
// real handleCommand() with an in-memory admin (same shape as
// teamProgression.test.js). A corrected winner moves into the next match and
// the corrected loser into bronze — never past a match that has started.
// Team-elimination corrections are covered in teamProgression.test.js.
import { describe, expect, test } from "vitest";
import { handleCommand } from "./handleCommand.js";
import { matchScoringTarget } from "@tournament/engine";

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

const T = "tournament-se";
const D = "division-se";
const ORGANIZER = { kind: "user", id: "organizer-1", email: "organizer@example.com" };
const UMPIRE = { kind: "user", id: "umpire-1", email: "umpire@example.com" };
const PLAYERS = ["p1", "p2", "p3", "p4"];
const TS = "2026-10-01T00:00:00.000Z";

// Two semifinals → final (slot A from SF1, slot B from SF2) and bronze (losers).
function fixture() {
  const m = (id, extra) => ({
    id, tournament_id: T, division_id: D, stage_id: null, stage_label: null, parent_match_id: null, pair_slot: null,
    bracket_side: "winners", round: 1, bracket_position: 0, status: "scheduled", winner: null, score_state: {},
    next_match_id: null, next_match_slot: null, loser_next_match_id: null, loser_next_match_slot: null,
    serving_team: null, coin_toss: null, team_a_wins: 0, team_b_wins: 0, started_at: null, completed_at: null,
    created_at: TS, updated_at: TS, ...extra,
  });
  const matches = [
    m("sf1", { next_match_id: "final", next_match_slot: "A", loser_next_match_id: "bronze", loser_next_match_slot: "A" }),
    m("sf2", { bracket_position: 1, next_match_id: "final", next_match_slot: "B", loser_next_match_id: "bronze", loser_next_match_slot: "B" }),
    m("final", { round: 2, bracket_side: "final" }),
    m("bronze", { round: 2, bracket_position: 1, bracket_side: "bronze", stage_label: "bronze" }),
  ];
  const sides = [
    { id: "sf1-A", match_id: "sf1", slot: "A", participant_id: "p1", team_id: null },
    { id: "sf1-B", match_id: "sf1", slot: "B", participant_id: "p2", team_id: null },
    { id: "sf2-A", match_id: "sf2", slot: "A", participant_id: "p3", team_id: null },
    { id: "sf2-B", match_id: "sf2", slot: "B", participant_id: "p4", team_id: null },
  ];
  return createMemoryAdmin({
    tournaments: [{ id: T, name: "Open", status: "live" }],
    tournament_members: [
      { id: "tm-o", tournament_id: T, user_id: ORGANIZER.id, role: "organizer" },
      { id: "tm-u", tournament_id: T, user_id: UMPIRE.id, role: "umpire" },
    ],
    licenses: [{ id: "lic-1", email: ORGANIZER.email, status: "active", expires_at: null, created_at: TS }],
    divisions: [{ id: D, tournament_id: T, name: "Open", format: "single_elim", config: { winTo: 11, bestOf: 1 } }],
    participants: PLAYERS.map((id) => ({ id, tournament_id: T, division_id: D, display_name: id.toUpperCase() })),
    stages: [],
    matches,
    match_participants: sides,
    umpire_assignments: [{ id: "ua-1", match_id: "sf1", user_id: UMPIRE.id }],
    court_assignments: [],
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
// Same inputs as the server's matchScoringSettings (no stage_id → no related matches).
const target = (admin, id) => matchScoringTarget(row(admin, id), []);

// Plays a match to `win`–3 for slot A (or 3–`win` for B) through complete_match.
async function play(admin, id, winnerSlot) {
  const w = target(admin, id);
  row(admin, id).status = "in_progress";
  admin.tables.score_events.push({
    id: crypto.randomUUID(), match_id: id, seq: 1, type: "correction",
    payload: winnerSlot === "A" ? { scoreA: w, scoreB: 3 } : { scoreA: 3, scoreB: w },
  });
  await send(admin, ORGANIZER, "complete_match", { match_id: id });
}

const correct = (admin, actor, id, scoreA, scoreB, extra = {}) => send(admin, actor, "score_event", {
  match_id: id,
  event_id: crypto.randomUUID(),
  seq: (row(admin, id).score_state?.lastSeq || 0) + 1,
  type: "correction",
  payload: { scoreA, scoreB, confirm_completed: true, reason: "Scoresheet", ...extra },
});

describe("organizer correction of a completed single-elimination match", () => {
  test("same winner: score and result updated, bracket untouched", async () => {
    const admin = fixture();
    await play(admin, "sf1", "A");
    const w = target(admin, "sf1");
    const res = await correct(admin, ORGANIZER, "sf1", w, 7);
    expect(res.ok).toBe(true);
    expect(row(admin, "sf1")).toMatchObject({ status: "completed", winner: "A" });
    const result = admin.tables.match_results.find((r) => r.match_id === "sf1");
    expect([result.score_a, result.score_b, result.winner_participant_id]).toEqual([w, 7, "p1"]);
    expect(pairsIn(admin, "final")).toEqual(["p1", null]);
    expect(pairsIn(admin, "bronze")).toEqual(["p2", null]);
  });

  test("winner flip: the new winner takes the final slot, the old winner goes to bronze, results follow", async () => {
    const admin = fixture();
    await play(admin, "sf1", "A");
    const w = target(admin, "sf1");
    const res = await correct(admin, ORGANIZER, "sf1", 5, w);
    expect(res.ok).toBe(true);
    expect(row(admin, "sf1")).toMatchObject({ status: "completed", winner: "B" });
    const result = admin.tables.match_results.find((r) => r.match_id === "sf1");
    expect(result).toMatchObject({ winner_slot: "B", winner_participant_id: "p2", score_a: 5, score_b: w });
    expect(pairsIn(admin, "final")).toEqual(["p2", null]);
    expect(pairsIn(admin, "bronze")).toEqual(["p1", null]);
    const audit = admin.tables.audit_logs.at(-1);
    expect(JSON.stringify(audit)).toContain("next_winner");
  });

  test("refused when the next match has started; nothing changes", async () => {
    const admin = fixture();
    await play(admin, "sf1", "A");
    await play(admin, "sf2", "A");
    row(admin, "final").status = "in_progress";
    const before = JSON.stringify(admin.tables.match_participants);
    const err = await fail(correct(admin, ORGANIZER, "sf1", 5, target(admin, "sf1")));
    expect([err.status, err.code]).toEqual([409, "DOWNSTREAM_STARTED"]);
    expect(row(admin, "sf1").winner).toBe("A");
    expect(JSON.stringify(admin.tables.match_participants)).toBe(before);
  });

  test("refused when the bronze match is already completed", async () => {
    const admin = fixture();
    await play(admin, "sf1", "A");
    row(admin, "bronze").status = "completed";
    const err = await fail(correct(admin, ORGANIZER, "sf1", 5, target(admin, "sf1")));
    expect([err.status, err.code]).toEqual([409, "DOWNSTREAM_STARTED"]);
  });

  test("the assigned umpire still can't change the winner", async () => {
    const admin = fixture();
    await play(admin, "sf1", "A");
    const err = await fail(correct(admin, UMPIRE, "sf1", 5, target(admin, "sf1")));
    expect([err.status, err.code]).toEqual([409, "WOULD_CHANGE_WINNER"]);
    expect(pairsIn(admin, "final")).toEqual(["p1", null]);
  });

  test("a score with no winner is refused for a completed match", async () => {
    const admin = fixture();
    await play(admin, "sf1", "A");
    const err = await fail(correct(admin, ORGANIZER, "sf1", 5, 4));
    expect([err.status, err.code]).toEqual([409, "WOULD_CHANGE_WINNER"]);
    expect(row(admin, "sf1").winner).toBe("A");
  });
});
