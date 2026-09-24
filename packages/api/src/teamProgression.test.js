// End-to-end qualification -> semifinals -> final progression, driven through
// the real handleCommand() with an in-memory stand-in for the Supabase admin
// client. Nothing here touches a real database: every write goes through the
// same createBatch()/apply_official_writes payload the server sends, and is
// applied to plain in-memory tables. Fixture = the real BEG LOW division shape
// (2 teams x 5 pairs, the 20 completed round-robin results, real pair ids).
import { describe, expect, test } from "vitest";
import { handleCommand } from "./handleCommand.js";

// ---- in-memory admin -------------------------------------------------------
const tick = () => new Promise((r) => setTimeout(r, 0));
// Mirrors the database: apply_official_writes is one transaction (all rows
// or none), and migration 0017's partial unique index allows at most one
// team_knockout stage per division. `knockoutUniqueIndex: false` simulates the
// schema before 0017, to prove the concurrency test really races.
function createMemoryAdmin(seed, { knockoutUniqueIndex = true } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const table = (name) => (tables[name] ||= []);

  function query(name) {
    const filters = [];
    let orderBy = null;
    let limitN = null;
    const run = () => {
      let rows = table(name).filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return rows.map((r) => ({ ...r }));
    };
    const builder = {
      select() { return builder; },
      eq(col, v) { filters.push((r) => r[col] === v); return builder; },
      in(col, vs) { const s = new Set(vs); filters.push((r) => s.has(r[col])); return builder; },
      is(col, v) { filters.push((r) => (r[col] ?? null) === v); return builder; },
      order(col, opts = {}) { orderBy = { col, asc: opts.ascending !== false }; return builder; },
      limit(n) { limitN = n; return builder; },
      // Every read yields to the event loop first, like a network round trip,
      // so two in-flight commands genuinely interleave.
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
      if (fn !== "apply_official_writes") return { data: null, error: { message: `unexpected rpc ${fn}` } };
      await tick();
      if (knockoutUniqueIndex) {
        const incoming = (payload.upserts?.stages || []).filter((s) => s.kind === "team_knockout");
        for (const s of incoming) {
          const clash = table("stages").some((r) => r.kind === "team_knockout" && r.division_id === s.division_id && r.id !== s.id);
          if (clash) {
            // Postgres aborts the whole call: nothing from this payload is kept.
            return { data: null, error: { message: 'duplicate key value violates unique constraint "stages_one_team_knockout_per_division_uidx"' } };
          }
        }
      }
      for (const [name, rows] of Object.entries(payload.upserts || {})) {
        for (const row of rows) {
          const list = table(name);
          const i = list.findIndex((r) => r.id === row.id);
          if (i >= 0) list[i] = { ...list[i], ...row }; else list.push({ ...row });
        }
      }
      for (const [name, idsToDelete] of Object.entries(payload.deletes || {})) {
        tables[name] = table(name).filter((r) => !idsToDelete.includes(r.id));
      }
      return { data: {}, error: null };
    },
  };
}

// ---- BEG LOW fixture -------------------------------------------------------
const T = "tournament-1";
const D = "division-beg-low";
const ORGANIZER = { kind: "user", id: "organizer-1", email: "organizer@example.com" };
const ONSE = "045c9b11-deb6-4957-829a-ec9ecf1e23e9";
const NEXTG = "8b40f53f-d3a4-4321-9b7e-6dd259698e67";
const P = {
  JOSH: ["90e68ba9-0e54-4404-bee1-909f8a932998", ONSE, "JOSHUA C. / SANDRA"],
  DEVAN: ["a33c13b6-7520-4086-b7a6-b3e17c935415", ONSE, "DEVAN / KEMP"],
  ALIE: ["1b5b8154-0470-499e-845e-d893e3592ecb", ONSE, "ALIE / JEROME"],
  CARL: ["a1640d12-1db0-44ad-9b9d-349baf507aba", ONSE, "CARL / LOY G"],
  AKI: ["fa83b077-ebbb-4330-968a-e8a40637d465", ONSE, "AKI / MAE MAE"],
  ADO: ["c118e40e-aae7-4621-8a4f-61bd03a2158f", NEXTG, "ADO / MAMEN"],
  KEISHA: ["1b51b300-677d-4e6c-aa25-06da7a3186c6", NEXTG, "KEISHA / RONA"],
  GRACE: ["8519db53-9609-443a-b948-1c987793b378", NEXTG, "GRACE / REIN"],
  JEFF: ["bb0d9492-1d28-4e56-a42d-2c7f063e8c07", NEXTG, "JEFFREY / REM"],
  KEN: ["a7870eb7-8db5-46d2-beb2-39b5b3b64401", NEXTG, "KENNETH / JENNY"],
};
const id = (key) => P[key][0];
const nameOf = (pid) => Object.values(P).find(([x]) => x === pid)?.[2];
// [slot A (ONSE), slot B (NEXTG), score A, score B] — the real 20 results.
const RESULTS = [
  ["ALIE", "ADO", 8, 11], ["JOSH", "ADO", 10, 12], ["DEVAN", "KEISHA", 11, 10], ["ALIE", "GRACE", 10, 11],
  ["AKI", "KEN", 5, 11], ["CARL", "JEFF", 11, 9], ["JOSH", "KEISHA", 8, 11], ["AKI", "ADO", 11, 8],
  ["ALIE", "KEN", 10, 11], ["DEVAN", "GRACE", 9, 11], ["ALIE", "JEFF", 9, 11], ["CARL", "KEN", 8, 11],
  ["CARL", "KEISHA", 11, 4], ["JOSH", "JEFF", 10, 11], ["JOSH", "GRACE", 10, 11], ["DEVAN", "JEFF", 10, 11],
  ["AKI", "GRACE", 11, 9], ["AKI", "KEISHA", 11, 10], ["CARL", "ADO", 11, 9], ["DEVAN", "KEN", 6, 11],
];

function begLow(configPatch = {}, { withMatches = true, ...adminOpts } = {}) {
  const ts = "2026-09-21T05:19:31.430Z";
  const matchRow = (extra) => ({
    tournament_id: T, division_id: D, stage_id: "stage-rr", round: 1, bracket_position: 0,
    next_match_id: null, next_match_slot: null, loser_next_match_id: null, loser_next_match_slot: null,
    serving_team: null, coin_toss: null, team_a_wins: 0, team_b_wins: 0, started_at: null,
    created_at: ts, updated_at: ts, completed_at: ts, ...extra,
  });
  const matches = [matchRow({
    id: "rr-1", parent_match_id: null, pair_slot: null, bracket_side: "round_robin", stage_label: "round_robin",
    status: "completed", winner: "B", team_a_wins: 7, team_b_wins: 13, score_state: {},
  })];
  const sides = [
    { id: "mp-rr-A", match_id: "rr-1", slot: "A", participant_id: null, team_id: ONSE },
    { id: "mp-rr-B", match_id: "rr-1", slot: "B", participant_id: null, team_id: NEXTG },
  ];
  RESULTS.forEach(([a, b, sa, sb], i) => {
    const mid = `rr-pm-${i + 1}`;
    matches.push(matchRow({
      id: mid, parent_match_id: "rr-1", pair_slot: i + 1, bracket_side: "pair", stage_label: null,
      status: "completed", winner: sa > sb ? "A" : "B",
      score_state: { scoreA: sa, scoreB: sb, status: "completed", winner: sa > sb ? "A" : "B" },
    }));
    sides.push({ id: `${mid}-A`, match_id: mid, slot: "A", participant_id: id(a), team_id: ONSE });
    sides.push({ id: `${mid}-B`, match_id: mid, slot: "B", participant_id: id(b), team_id: NEXTG });
  });
  if (!withMatches) { matches.length = 0; sides.length = 0; }
  return createMemoryAdmin({
    tournaments: [{ id: T, name: "Test Tournament", status: "live" }],
    tournament_members: [{ id: "tm-1", tournament_id: T, user_id: ORGANIZER.id, role: "organizer" }],
    licenses: [{ id: "lic-1", email: ORGANIZER.email, status: "active", expires_at: null, created_at: ts }],
    divisions: [{
      id: D, tournament_id: T, name: "BEG LOW", format: "team_elimination",
      config: {
        winBy: "two", winTo: 11, bestOf: 1, isDoubles: true, bronzeMatch: true,
        qualifierMode: "top_x_per_team", qualifierCount: 2, sameTeamPolicy: "avoid_semis",
        progressionMode: "direct_semifinals", ...configPatch,
      },
    }],
    teams: [{ id: ONSE, division_id: D, name: "ONSE" }, { id: NEXTG, division_id: D, name: "NEXTG" }],
    participants: Object.values(P).map(([pid, team_id, display_name]) => ({ id: pid, division_id: D, team_id, display_name })),
    stages: [{ id: "stage-rr", division_id: D, kind: "team_round_robin", name: "Team round robin", config: {} }],
    matches,
    match_participants: sides,
    command_receipts: [],
    audit_logs: [],
    score_events: [],
    match_results: [],
    court_assignments: [],
    umpire_assignments: [],
  }, adminOpts);
}

// ---- helpers -----------------------------------------------------------------
let seq = 0;
const send = (admin, type, payload) =>
  handleCommand({ admin, actor: ORGANIZER, body: { command_id: crypto.randomUUID(), type, payload } });
const sendErr = (admin, type, payload) => send(admin, type, payload).then(
  () => { throw new Error(`${type} unexpectedly succeeded`); },
  (err) => err,
);
const parents = (admin, label) => admin.tables.matches.filter((m) => !m.parent_match_id && m.stage_label === label);
const childOf = (admin, parentId) => admin.tables.matches.filter((m) => m.parent_match_id === parentId);
const side = (admin, matchId, slot) => admin.tables.match_participants.find((s) => s.match_id === matchId && s.slot === slot);
const pairsIn = (admin, matchId) => ["A", "B"].map((s) => side(admin, matchId, s)?.participant_id ?? null);

// Plays a knockout pair match to a final score through the official path: a
// score correction event (the reducer's own completion rule decides the
// winner) followed by the real complete_match command.
async function playKnockout(admin, parentId, winnerPairId, loserPoints = 9) {
  const [child] = childOf(admin, parentId);
  expect(child, `pair match for ${parentId}`).toBeTruthy();
  const aWins = side(admin, child.id, "A").participant_id === winnerPairId;
  expect(aWins || side(admin, child.id, "B").participant_id === winnerPairId).toBe(true);
  child.status = "in_progress"; // as start_match would leave it
  admin.tables.score_events.push({
    id: crypto.randomUUID(), match_id: child.id, seq: ++seq, type: "correction",
    payload: aWins ? { scoreA: 15, scoreB: loserPoints } : { scoreA: loserPoints, scoreB: 15 },
  });
  const res = await send(admin, "complete_match", { match_id: child.id });
  expect(res.ok).toBe(true);
  return { child, winnerSlot: aWins ? "A" : "B" };
}

// ---- tests ---------------------------------------------------------------------
describe("team elimination: qualification -> semifinals -> final (real BEG LOW shape, in-memory)", () => {
  test("12. BEG LOW, 2 per team: exactly KENNETH + JEFFREY (NEXTG) and CARL + AKI (ONSE); GRACE does not take AKI's place", async () => {
    const admin = begLow();
    const res = await send(admin, "generate_team_playoffs", { division_id: D });
    const q = res.result.qualifiers;
    expect(q).toHaveLength(4);
    expect(new Set(q)).toEqual(new Set([id("KEN"), id("JEFF"), id("CARL"), id("AKI")]));
    expect(q).not.toContain(id("GRACE"));
    const team = (pid) => Object.values(P).find(([x]) => x === pid)[1];
    expect(q.filter((pid) => team(pid) === NEXTG)).toHaveLength(2);
    expect(q.filter((pid) => team(pid) === ONSE)).toHaveLength(2);
    // JEFFREY / REM vs GRACE / REIN are level on W, L, +/- and PF — reported, not silent.
    expect(res.result.unresolved_ties).toEqual([{ teamId: NEXTG, qualified: id("JEFF"), excluded: id("GRACE") }]);
    expect(res.result.stage.config).toEqual({ qualifierMode: "top_x_per_team", qualifierCount: 2, progressionMode: "direct_semifinals" });
  });

  test("6-8. semifinals hold exactly the 4 qualifiers, once each, cross-team only; final and bronze start empty", async () => {
    const admin = begLow();
    const { result } = await send(admin, "generate_team_playoffs", { division_id: D });
    const semis = parents(admin, "semifinal");
    expect(semis).toHaveLength(2);
    const placed = semis.flatMap((m) => pairsIn(admin, m.id));
    expect(placed.slice().sort()).toEqual([...result.qualifiers].sort());
    expect(new Set(placed).size).toBe(4);
    for (const m of semis) {
      expect(side(admin, m.id, "A").team_id).not.toBe(side(admin, m.id, "B").team_id);
      const [child] = childOf(admin, m.id);
      expect(pairsIn(admin, child.id)).toEqual(pairsIn(admin, m.id));
    }
    const nonQualified = ["GRACE", "ADO", "KEISHA", "DEVAN", "JOSH", "ALIE"].map(id);
    for (const pid of nonQualified) expect(placed).not.toContain(pid);
    const [final] = parents(admin, "final");
    const [bronze] = parents(admin, "bronze");
    expect(pairsIn(admin, final.id)).toEqual([null, null]);
    expect(pairsIn(admin, bronze.id)).toEqual([null, null]);
    expect(childOf(admin, final.id)).toHaveLength(0);
    expect(childOf(admin, bronze.id)).toHaveLength(0);
  });

  test("9-10. semifinal winners (only) reach the final, losers go to bronze; a same-team final won by slot B records slot B", async () => {
    const admin = begLow();
    await send(admin, "generate_team_playoffs", { division_id: D });
    const semis = parents(admin, "semifinal");
    const semiWith = (key) => semis.find((m) => pairsIn(admin, m.id).includes(id(key)));
    const sfKen = semiWith("KEN");
    const sfJeff = semiWith("JEFF");
    expect(sfKen.id).not.toBe(sfJeff.id);

    // Semifinal 1: KENNETH wins. The final is not playable yet.
    await playKnockout(admin, sfKen.id, id("KEN"));
    const [final] = parents(admin, "final");
    const [bronze] = parents(admin, "bronze");
    expect(pairsIn(admin, final.id)).toContain(id("KEN"));
    expect(childOf(admin, final.id)).toHaveLength(0);

    // Semifinal 2: JEFFREY wins -> an all-NEXTG final.
    await playKnockout(admin, sfJeff.id, id("JEFF"));
    const finalists = pairsIn(admin, final.id);
    expect(new Set(finalists)).toEqual(new Set([id("KEN"), id("JEFF")]));
    const losers = semis.flatMap((m) => pairsIn(admin, m.id)).filter((pid) => !finalists.includes(pid));
    expect(new Set(pairsIn(admin, bronze.id))).toEqual(new Set(losers));
    const [finalChild] = childOf(admin, final.id);
    expect(pairsIn(admin, finalChild.id)).toEqual(finalists);
    expect(childOf(admin, bronze.id)).toHaveLength(1);
    expect(side(admin, final.id, "A").team_id).toBe(NEXTG);
    expect(side(admin, final.id, "B").team_id).toBe(NEXTG);
    // Each completed semifinal parent records the side that actually won.
    for (const sf of [sfKen, sfJeff]) {
      const row = admin.tables.matches.find((m) => m.id === sf.id);
      expect(row.status).toBe("completed");
      expect(side(admin, sf.id, row.winner).participant_id).toMatch(new RegExp(`${id("KEN")}|${id("JEFF")}`));
    }

    // Final: the slot-B pair wins. Champion = actual final winner.
    const slotBPair = side(admin, final.id, "B").participant_id;
    const slotAPair = side(admin, final.id, "A").participant_id;
    await playKnockout(admin, final.id, slotBPair);
    const finalRow = admin.tables.matches.find((m) => m.id === final.id);
    expect(finalRow.status).toBe("completed");
    expect(finalRow.winner).toBe("B");
    const champion = side(admin, final.id, finalRow.winner).participant_id;
    const runnerUp = side(admin, final.id, finalRow.winner === "A" ? "B" : "A").participant_id;
    expect(champion).toBe(slotBPair);
    expect(runnerUp).toBe(slotAPair);
    expect([nameOf(champion), nameOf(runnerUp)].sort()).toEqual(["JEFFREY / REM", "KENNETH / JENNY"]);
  });

  test("11. generating playoffs again is refused and creates nothing", async () => {
    const admin = begLow();
    await send(admin, "generate_team_playoffs", { division_id: D });
    const before = { stages: admin.tables.stages.length, matches: admin.tables.matches.length, sides: admin.tables.match_participants.length };
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("PLAYOFFS_EXIST");
    expect(err.status).toBe(409);
    expect({ stages: admin.tables.stages.length, matches: admin.tables.matches.length, sides: admin.tables.match_participants.length }).toEqual(before);
    expect(admin.tables.stages.filter((s) => s.kind === "team_knockout")).toHaveLength(1);
  });

  test("qualifierCount is per team: 4 per team x 2 teams = 8 is rejected for Direct Semifinals with the math, and nothing is generated", async () => {
    const admin = begLow({ qualifierCount: 4 });
    const matchesBefore = admin.tables.matches.length;
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("DIRECT_SEMIS_INVALID_COUNT");
    expect(err.message).toContain("Top 4 per team × 2 teams = 8");
    expect(err.message).toContain("Set qualifiers per team to 2");
    expect(admin.tables.matches.length).toBe(matchesBefore);
    expect(admin.tables.stages.filter((s) => s.kind === "team_knockout")).toHaveLength(0);
  });

});

// ---- hardening: qualifierCount validation --------------------------------------
describe("qualifierCount must be a positive whole number (create, update, generate)", () => {
  const VALID = [1, 2, 3, 4];
  const INVALID = [
    ["1.5", 1.5], ["0", 0], ["-1", -1], ["'abc'", "abc"], ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY], ["empty string", ""], ["null", null], ["'2' (string)", "2"],
  ];

  test.each(VALID)("create_division qualifierCount %s: accepted and stored as-is", async (count) => {
    const admin = begLow();
    const res = await send(admin, "create_division", { tournament_id: T, name: `C${count}`, format: "team_elimination", config: { qualifierCount: count } });
    expect(res.result.division.config.qualifierCount).toBe(count);
  });

  test.each(INVALID)("create_division qualifierCount %s: rejected, nothing saved", async (_label, count) => {
    const admin = begLow();
    const before = admin.tables.divisions.length;
    const err = await sendErr(admin, "create_division", { tournament_id: T, name: "Bad", format: "team_elimination", config: { qualifierCount: count } });
    expect(err.code).toBe("INVALID_QUALIFIER_COUNT");
    expect(err.status).toBe(400);
    expect(admin.tables.divisions.length).toBe(before);
  });

  test.each(VALID)("update_division qualifierCount %s: accepted", async (count) => {
    const admin = begLow();
    await send(admin, "update_division", { division_id: D, config: { qualifierCount: count } });
    expect(admin.tables.divisions.find((d) => d.id === D).config.qualifierCount).toBe(count);
  });

  test.each(INVALID)("update_division qualifierCount %s: rejected, stored value unchanged", async (_label, count) => {
    const admin = begLow();
    const err = await sendErr(admin, "update_division", { division_id: D, config: { qualifierCount: count } });
    expect(err.code).toBe("INVALID_QUALIFIER_COUNT");
    expect(admin.tables.divisions.find((d) => d.id === D).config.qualifierCount).toBe(2);
  });

  test("create_division with no qualifierCount at all gets the explicit default of 2", async () => {
    const admin = begLow();
    const res = await send(admin, "create_division", { tournament_id: T, name: "Default", format: "team_elimination" });
    expect(res.result.division.config).toEqual(expect.objectContaining({ qualifierMode: "top_x_per_team", qualifierCount: 2 }));
  });

  test.each([["1.5", 1.5], ["0", 0], ["-1", -1], ["'abc'", "abc"], ["null", null], ["'2' (string)", "2"]])(
    "generate_team_playoffs with a stored invalid qualifierCount %s: refused, no fallback, nothing generated",
    async (_label, count) => {
      const admin = begLow({ qualifierCount: count });
      const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
      expect(err.code).toBe("INVALID_QUALIFIER_COUNT");
      expect(admin.tables.stages.filter((s) => s.kind === "team_knockout")).toHaveLength(0);
    },
  );

  test("generate_team_playoffs: more qualifiers per team than pairs per team is refused", async () => {
    const admin = begLow({ qualifierCount: 6, progressionMode: "playoffs" });
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("INVALID_QUALIFIER_COUNT");
    expect(err.message).toContain("cannot exceed the number of pairs per team (5)");
  });
});

// ---- hardening: retired qualifier modes ----------------------------------------
describe("retired qualifier modes are rejected on write, never rewritten", () => {
  const RETIRED = ["top_x", "top_x_overall", "manual", "something_else"];

  test.each(RETIRED)("create_division with qualifierMode %s: rejected, nothing saved", async (qualifierMode) => {
    const admin = begLow();
    const before = admin.tables.divisions.length;
    const err = await sendErr(admin, "create_division", { tournament_id: T, name: "Old", format: "team_elimination", config: { qualifierMode, qualifierCount: 2 } });
    expect(err.code).toBe("INVALID_QUALIFIER_MODE");
    expect(err.status).toBe(400);
    expect(admin.tables.divisions.length).toBe(before);
  });

  test.each(RETIRED)("update_division with qualifierMode %s: rejected, row unchanged", async (qualifierMode) => {
    const admin = begLow();
    const before = JSON.stringify(admin.tables.divisions.find((d) => d.id === D));
    const err = await sendErr(admin, "update_division", { division_id: D, config: { qualifierMode, qualifierCount: 2 } });
    expect(err.code).toBe("INVALID_QUALIFIER_MODE");
    expect(JSON.stringify(admin.tables.divisions.find((d) => d.id === D))).toBe(before);
  });

  test("top_x_per_team is accepted on create and update", async () => {
    const admin = begLow();
    const res = await send(admin, "create_division", { tournament_id: T, name: "New", format: "team_elimination", config: { qualifierMode: "top_x_per_team", qualifierCount: 2 } });
    expect(res.result.division.config.qualifierMode).toBe("top_x_per_team");
    await send(admin, "update_division", { division_id: D, config: { qualifierMode: "top_x_per_team", qualifierCount: 2 } });
    expect(admin.tables.divisions.find((d) => d.id === D).config.qualifierMode).toBe("top_x_per_team");
  });

  test("single elimination divisions are unaffected by team qualification validation", async () => {
    const admin = begLow();
    const res = await send(admin, "create_division", { tournament_id: T, name: "Singles", format: "single_elim", config: { bestOf: 1 } });
    expect(res.result.division.format).toBe("single_elim");
  });
});

// ---- hardening: legacy / current production configurations ----------------------
describe("existing stored configurations (fixtures of the current production state)", () => {
  test("BEG LOW as stored today (top_x_per_team, 4, Direct Semifinals): blocked until the organizer saves 2, then generates 2 per team", async () => {
    const admin = begLow({ qualifierCount: 4 });
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("DIRECT_SEMIS_INVALID_COUNT");
    expect(admin.tables.stages.filter((s) => s.kind === "team_knockout")).toHaveLength(0);
    // Organizer explicitly saves "Qualifiers per team = 2" (what the Operator sends).
    await send(admin, "update_division", {
      division_id: D,
      config: { qualifierMode: "top_x_per_team", qualifierCount: 2, sameTeamPolicy: "avoid_semis", progressionMode: "direct_semifinals" },
    });
    const res = await send(admin, "generate_team_playoffs", { division_id: D });
    expect(new Set(res.result.qualifiers)).toEqual(new Set([id("KEN"), id("JEFF"), id("CARL"), id("AKI")]));
  });

  test("BEG HIGH as stored today (same config, no qualification matches): blocked, nothing generated", async () => {
    const admin = begLow({ qualifierCount: 4 }, { withMatches: false });
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("RR_INCOMPLETE");
    expect(admin.tables.stages.filter((s) => s.kind === "team_knockout")).toHaveLength(0);
    expect(admin.tables.matches).toHaveLength(0);
  });

  test.each([
    ["top_x", 4, "playoffs"],
    ["top_x", 4, "direct_semifinals"],
    ["top_x_overall", 2, "direct_semifinals"],
    ["manual", 2, "direct_semifinals"],
  ])("legacy stored mode %s (count %s, %s): stays readable and untouched; generation refused until re-saved", async (qualifierMode, qualifierCount, progressionMode) => {
    const admin = begLow({ qualifierMode, qualifierCount, progressionMode });
    const rowBefore = JSON.stringify(admin.tables.divisions.find((d) => d.id === D));
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("QUALIFICATION_NOT_CONFIGURED");
    expect(err.message).toContain(`(${qualifierMode})`);
    // Reading/generating never mutates the stored row, and nothing is generated.
    expect(JSON.stringify(admin.tables.divisions.find((d) => d.id === D))).toBe(rowBefore);
    expect(admin.tables.stages.filter((s) => s.kind === "team_knockout")).toHaveLength(0);
  });

  test("legacy top_x division: after the organizer explicitly saves per-team, progression uses per-team semantics", async () => {
    const admin = begLow({ qualifierMode: "top_x", qualifierCount: 4, progressionMode: "direct_semifinals" });
    await send(admin, "update_division", { division_id: D, config: { qualifierMode: "top_x_per_team", qualifierCount: 2 } });
    const res = await send(admin, "generate_team_playoffs", { division_id: D });
    expect(res.result.qualifiers).toHaveLength(4);
    expect(new Set(res.result.qualifiers)).toEqual(new Set([id("KEN"), id("JEFF"), id("CARL"), id("AKI")]));
  });

  test("legacy top_x division: saving only the count (without the mode) keeps it blocked", async () => {
    const admin = begLow({ qualifierMode: "top_x", qualifierCount: 4 });
    await send(admin, "update_division", { division_id: D, config: { qualifierCount: 2 } });
    expect(admin.tables.divisions.find((d) => d.id === D).config.qualifierMode).toBe("top_x");
    const err = await sendErr(admin, "generate_team_playoffs", { division_id: D });
    expect(err.code).toBe("QUALIFICATION_NOT_CONFIGURED");
  });
});

// ---- hardening: empty / invalid playoff slots --------------------------------------
describe("playoff matches cannot be started or scored until both slots are validly filled", () => {
  const COMMANDS = ["start_match", "score_event", "coin_toss", "complete_match"];
  const payloadFor = (type, matchId) => {
    if (type === "score_event") return { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, type: "point", payload: { team: "A" } };
    if (type === "coin_toss") return { match_id: matchId, event_id: crypto.randomUUID(), seq: 1, result: "A" };
    return { match_id: matchId };
  };
  // start/coin toss need a pre-start status; score/complete need in_progress —
  // so each command reaches the slot check rather than a status error.
  const statusFor = (type) => (type === "start_match" || type === "coin_toss" ? "ready" : "in_progress");
  async function generated() {
    const admin = begLow();
    await send(admin, "generate_team_playoffs", { division_id: D });
    return admin;
  }
  const setStatus = (admin, matchId, status) => { admin.tables.matches.find((m) => m.id === matchId).status = status; };
  const expectNotReady = async (admin, type, matchId) => {
    const err = await sendErr(admin, type, payloadFor(type, matchId));
    expect(err.code, `${type} on ${matchId}`).toBe("MATCH_NOT_READY");
    expect(err.status).toBe(409);
  };

  for (const label of ["final", "bronze"]) {
    test.each(COMMANDS)(`empty ${label} slot (the ${label} shell): %s refused`, async (type) => {
      const admin = await generated();
      const [shell] = parents(admin, label);
      expect(pairsIn(admin, shell.id)).toEqual([null, null]);
      setStatus(admin, shell.id, statusFor(type));
      await expectNotReady(admin, type, shell.id);
      expect(admin.tables.score_events).toHaveLength(0);
    });

    test.each(COMMANDS)(`${label} pair match with only one slot filled: %s refused`, async (type) => {
      const admin = await generated();
      const [shell] = parents(admin, label);
      // A half-filled slot plus a pair match written for it directly — not
      // reachable through the normal flow, which waits for both slots.
      side(admin, shell.id, "A").participant_id = id("KEN");
      const template = childOf(admin, parents(admin, "semifinal")[0].id)[0];
      admin.tables.matches.push({ ...template, id: `${label}-child`, parent_match_id: shell.id, stage_label: label, status: statusFor(type) });
      admin.tables.match_participants.push({ id: `${label}-child-A`, match_id: `${label}-child`, slot: "A", participant_id: id("KEN"), team_id: NEXTG });
      admin.tables.match_participants.push({ id: `${label}-child-B`, match_id: `${label}-child`, slot: "B", participant_id: null, team_id: null });
      await expectNotReady(admin, type, `${label}-child`);
    });
  }

  test.each(COMMANDS)("semifinal team-matchup shell (never played directly): %s refused", async (type) => {
    const admin = await generated();
    const [sf] = parents(admin, "semifinal");
    setStatus(admin, sf.id, statusFor(type));
    await expectNotReady(admin, type, sf.id);
  });

  test.each(COMMANDS)("semifinal pair match with an emptied slot: %s refused", async (type) => {
    const admin = await generated();
    const [child] = childOf(admin, parents(admin, "semifinal")[0].id);
    side(admin, child.id, "B").participant_id = null;
    setStatus(admin, child.id, statusFor(type));
    await expectNotReady(admin, type, child.id);
  });

  test("semifinal pair match whose pairs differ from its bracket slot, or reference a pair outside the division: refused", async () => {
    const admin = await generated();
    const [child] = childOf(admin, parents(admin, "semifinal")[0].id);
    setStatus(admin, child.id, "ready");
    const original = side(admin, child.id, "B").participant_id;
    side(admin, child.id, "B").participant_id = id("GRACE"); // not the pair in this bracket slot
    await expectNotReady(admin, "start_match", child.id);
    side(admin, child.id, "B").participant_id = original;
    admin.tables.participants.find((p) => p.id === original).division_id = "another-division";
    await expectNotReady(admin, "start_match", child.id);
  });

  test("a correctly filled semifinal pair match can be started (the guard does not block normal play)", async () => {
    const admin = await generated();
    const [child] = childOf(admin, parents(admin, "semifinal")[0].id);
    setStatus(admin, child.id, "ready");
    const res = await send(admin, "start_match", { match_id: child.id });
    expect(res.result.match.status).toBe("in_progress");
  });

  test("round-robin pair matches (qualification) are unaffected by the guard", async () => {
    const admin = begLow();
    const rr = admin.tables.matches.find((m) => m.id === "rr-pm-1");
    rr.status = "ready";
    const res = await send(admin, "start_match", { match_id: rr.id });
    expect(res.result.match.status).toBe("in_progress");
  });
});

// ---- hardening: concurrent Generate Playoffs -----------------------------------------
describe("concurrent Generate Playoffs (two organizer devices at once)", () => {
  const knockout = (admin) => ({
    stages: admin.tables.stages.filter((s) => s.kind === "team_knockout").length,
    semifinals: parents(admin, "semifinal").length,
    finals: parents(admin, "final").length,
    bronzes: parents(admin, "bronze").length,
  });
  const both = (admin) => Promise.allSettled([
    send(admin, "generate_team_playoffs", { division_id: D }),
    send(admin, "generate_team_playoffs", { division_id: D }),
  ]);

  test("two simultaneous requests: one succeeds, the other gets PLAYOFFS_EXIST; exactly one bracket, no duplicates", async () => {
    const admin = begLow();
    const results = await both(admin);
    const failed = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason.code).toBe("PLAYOFFS_EXIST");
    expect(failed[0].reason.status).toBe(409);
    expect(knockout(admin)).toEqual({ stages: 1, semifinals: 2, finals: 1, bronzes: 1 });
    const knockoutIds = new Set(admin.tables.matches.filter((m) => !m.parent_match_id && m.stage_label !== "round_robin").map((m) => m.id));
    expect(admin.tables.matches.filter((m) => knockoutIds.has(m.parent_match_id))).toHaveLength(2);
    expect(new Set(parents(admin, "semifinal").flatMap((m) => pairsIn(admin, m.id))).size).toBe(4);
    const [stage] = admin.tables.stages.filter((s) => s.kind === "team_knockout");
    const knockoutRows = admin.tables.matches.filter((m) => knockoutIds.has(m.id) || knockoutIds.has(m.parent_match_id));
    expect(knockoutRows.every((m) => m.stage_id === stage.id)).toBe(true);
  });

  test("the race is real: without the one-knockout-stage index both requests would create a bracket", async () => {
    const admin = begLow({}, { knockoutUniqueIndex: false });
    const results = await both(admin);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(knockout(admin)).toEqual({ stages: 2, semifinals: 4, finals: 2, bronzes: 2 });
  });
});
