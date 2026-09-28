// Phase F — command idempotency, sequence and stale-write safety, driven
// through the real handleCommand() with an in-memory stand-in for the
// Supabase admin client whose apply_official_writes mirrors migration 0018:
//   - one batch is atomic (all rows or none);
//   - the receipt row is CLAIMED first (insert-only) → TC001 if already there;
//   - payload.expect / payload.precondition check matches.updated_at (TC412 /
//     TC409) before anything is written;
//   - score_events has unique (match_id, seq) → 23505;
//   - matches.updated_at changes on every write (the touch trigger).
// `legacy: true` switches to the pre-0018 behaviour (receipt upsert, no
// version checks) to prove each race is real before proving it is fixed.
// The same guarantees are proven against real PostgreSQL in
// commandIdempotency.pg.test.js.
import { describe, expect, test } from "vitest";
import { classifySendError } from "@tournament/client";
import { errorResponse, handleCommand } from "./handleCommand.js";
import { writeError } from "./writes.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

function createMemoryAdmin(seed, { legacy = false } = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const table = (name) => (tables[name] ||= []);
  let clock = Date.parse("2026-09-28T00:00:00.000Z");
  const nextTs = () => new Date(++clock).toISOString();
  const faults = []; // queued rpc behaviours: "commit-then-lose-response" | "transient" | "stale"
  let rpcCalls = 0;

  function query(name) {
    const filters = [];
    let orderBy = null;
    const run = () => {
      let rows = table(name).filter((r) => filters.every((f) => f(r)));
      if (orderBy) rows = [...rows].sort((a, b) => (a[orderBy.col] < b[orderBy.col] ? -1 : a[orderBy.col] > b[orderBy.col] ? 1 : 0) * (orderBy.asc ? 1 : -1));
      return rows.map((r) => structuredClone(r));
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

  function fail(code, message, details = null) {
    return { data: null, error: { code, message, details } };
  }

  // Everything below runs synchronously after one tick: one atomic transaction.
  function apply(payload) {
    const receipts = payload.upserts?.command_receipts || [];
    if (!legacy) {
      for (const r of receipts) {
        if (table("command_receipts").some((x) => x.id === r.id)) return fail("TC001", "command already applied", r.id);
      }
      for (const e of payload.expect || []) {
        const row = table("matches").find((m) => m.id === e.id);
        if (!row || row.updated_at !== e.updated_at) return fail("TC412", "row changed since it was read", row?.updated_at ?? "");
      }
      for (const e of payload.precondition || []) {
        const row = table("matches").find((m) => m.id === e.id);
        if (!row || row.updated_at !== e.updated_at) return fail("TC409", "stale state", row?.updated_at ?? "");
      }
    }
    for (const ev of payload.upserts?.score_events || []) {
      const clash = table("score_events").find((x) => x.match_id === ev.match_id && x.seq === ev.seq && x.id !== ev.id);
      if (clash) return fail("23505", 'duplicate key value violates unique constraint "score_events_match_id_seq_key"');
    }
    for (const [name, rows] of Object.entries(payload.upserts || {})) {
      for (const row of rows) {
        const list = table(name);
        const stored = name === "matches" ? { ...row, updated_at: nextTs() } : { ...row };
        const i = list.findIndex((r) => r.id === row.id);
        if (i >= 0) list[i] = { ...list[i], ...structuredClone(stored) }; else list.push(structuredClone(stored));
      }
    }
    return { data: { ok: true }, error: null };
  }

  return {
    tables,
    faults,
    get rpcCalls() { return rpcCalls; },
    from: (name) => query(name),
    async rpc(fn, { payload }) {
      rpcCalls += 1;
      await tick();
      const fault = faults.shift();
      if (fault === "transient") return fail("08006", "connection failure");
      if (fault === "stale") return fail("TC412", "row changed since it was read");
      const out = apply(payload);
      // The transaction committed, but the answer never reached the API
      // (e.g. the connection dropped): the API sees a plain error.
      if (fault === "commit-then-lose-response" && !out.error) return fail("", "fetch failed");
      return out;
    },
  };
}

// ---- fixture ---------------------------------------------------------------
const T = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";
const PA = "44444444-4444-4444-8444-444444444444";
const PB = "55555555-5555-4555-8555-555555555555";
const ORGANIZER = { kind: "user", id: "66666666-6666-4666-8666-666666666666", email: "organizer@example.com" };
const UMPIRE = { kind: "user", id: "77777777-7777-4777-8777-777777777777", email: "umpire@example.com" };
const OTHER_ORGANIZER = { kind: "user", id: "88888888-8888-4888-8888-888888888888", email: "organizer@example.com" };
const TS = "2026-09-27T00:00:00.000Z";

function fixture(opts) {
  return createMemoryAdmin({
    tournaments: [{ id: T, name: "Spring Open", status: "in_progress" }],
    tournament_members: [
      { id: "tm-o", tournament_id: T, user_id: ORGANIZER.id, role: "organizer" },
      { id: "tm-o2", tournament_id: T, user_id: OTHER_ORGANIZER.id, role: "organizer" },
      { id: "tm-u", tournament_id: T, user_id: UMPIRE.id, role: "umpire" },
    ],
    licenses: [{ id: "lic-1", email: ORGANIZER.email, status: "active", expires_at: null, created_at: TS }],
    divisions: [{ id: D, tournament_id: T, name: "Open", format: "single_elim", config: {} }],
    participants: [
      { id: PA, tournament_id: T, division_id: D, display_name: "A" },
      { id: PB, tournament_id: T, division_id: D, display_name: "B" },
    ],
    matches: [{
      id: M, tournament_id: T, division_id: D, stage_id: null, stage_label: null, parent_match_id: null,
      round: 1, bracket_position: 0, status: "assigned", score_state: {}, serving_team: null, coin_toss: null,
      next_match_id: null, created_at: TS, updated_at: TS,
    }],
    match_participants: [
      { id: "mp-a", match_id: M, slot: "A", participant_id: PA, team_id: null },
      { id: "mp-b", match_id: M, slot: "B", participant_id: PB, team_id: null },
    ],
    umpire_assignments: [{ id: "ua-1", match_id: M, user_id: UMPIRE.id }],
    court_assignments: [],
    score_events: [],
    command_receipts: [],
    audit_logs: [],
    courts: [],
  }, opts);
}

let n = 0;
const cmdId = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, "0")}`;
const send = (admin, actor, type, payload, command_id = cmdId()) => handleCommand({ admin, actor, body: { command_id, type, payload } });
const point = (seq, team = "A", event_id = cmdId()) => ({ match_id: M, event_id, seq, type: "point", payload: { team } });
const courtsNamed = (admin, name) => admin.tables.courts.filter((c) => c.name === name);
const matchRow = (admin) => admin.tables.matches.find((m) => m.id === M);
async function started() {
  const admin = fixture();
  await send(admin, UMPIRE, "start_match", { match_id: M });
  return admin;
}

// ---- idempotency -----------------------------------------------------------
describe("command idempotency (one command_id → at most one effect)", () => {
  test("Case A — first command executes once and records a fingerprinted receipt", async () => {
    const admin = fixture();
    const id = cmdId();
    const out = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id);
    expect(out.idempotent).toBe(false);
    expect(courtsNamed(admin, "Court 1")).toHaveLength(1);
    const receipt = admin.tables.command_receipts.find((r) => r.id === id);
    expect(receipt.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.actor_id).toBe(ORGANIZER.id);
  });

  test("Case B — an exact retry replays the stored result and does not execute again", async () => {
    const admin = fixture();
    const id = cmdId();
    const first = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id);
    const calls = admin.rpcCalls;
    const again = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id);
    expect(again).toEqual({ ok: true, idempotent: true, result: first.result });
    expect(admin.rpcCalls).toBe(calls);
    expect(courtsNamed(admin, "Court 1")).toHaveLength(1);
  });

  test("Case C — lost response: the server committed, the client retries, no second effect", async () => {
    const admin = fixture();
    const id = cmdId();
    admin.faults.push("commit-then-lose-response");
    const lost = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id).catch((e) => e);
    expect(lost.status).toBe(500); // retryable, and nothing leaks
    expect(lost.message).not.toMatch(/fetch failed/);
    const retry = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id);
    expect(retry.idempotent).toBe(true);
    expect(courtsNamed(admin, "Court 1")).toHaveLength(1);
    expect(retry.result.court.id).toBe(courtsNamed(admin, "Court 1")[0].id);
    expect(admin.tables.audit_logs.filter((l) => l.command_id === id)).toHaveLength(1);
    expect(admin.tables.command_receipts.filter((r) => r.id === id)).toHaveLength(1);
  });

  test("Case D — concurrent duplicates: BEFORE 0018 both execute (the race is real)", async () => {
    const admin = fixture({ legacy: true });
    const id = cmdId();
    const payload = { tournament_id: T, name: "Court 1" };
    await Promise.all([send(admin, ORGANIZER, "create_court", payload, id), send(admin, ORGANIZER, "create_court", payload, id)]);
    expect(courtsNamed(admin, "Court 1")).toHaveLength(2); // two effects from one command_id
    expect(admin.tables.command_receipts.filter((r) => r.id === id)).toHaveLength(1); // receipt overwritten
  });

  test("Case D — concurrent duplicates: exactly one execution; both callers get the same result", async () => {
    const admin = fixture();
    const id = cmdId();
    const payload = { tournament_id: T, name: "Court 1" };
    const [a, b] = await Promise.all([send(admin, ORGANIZER, "create_court", payload, id), send(admin, ORGANIZER, "create_court", payload, id)]);
    expect(courtsNamed(admin, "Court 1")).toHaveLength(1);
    expect([a.idempotent, b.idempotent].sort()).toEqual([false, true]);
    expect(a.result).toEqual(b.result);
    expect(admin.tables.audit_logs.filter((l) => l.command_id === id)).toHaveLength(1);
  });

  test("Case E — same command_id with a different payload is rejected, never overwritten", async () => {
    const admin = fixture();
    const id = cmdId();
    await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id);
    const err = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 2" }, id).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(courtsNamed(admin, "Court 2")).toHaveLength(0);
    expect(admin.tables.command_receipts.find((r) => r.id === id).result.court.name).toBe("Court 1");
  });

  test("Case E — concurrent same id / different payloads: one executes, the other is rejected", async () => {
    const admin = fixture();
    const id = cmdId();
    const results = await Promise.allSettled([
      send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id),
      send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 2" }, id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(admin.tables.courts).toHaveLength(1);
  });

  test("a different actor can't replay (or read) someone else's command_id", async () => {
    const admin = fixture();
    const id = cmdId();
    await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id);
    const err = await send(admin, OTHER_ORGANIZER, "create_court", { tournament_id: T, name: "Court 1" }, id).catch((e) => e);
    expect(err.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(err.message).not.toMatch(/Court 1/);
  });

  test("the fingerprint ignores payload key order", async () => {
    const admin = fixture();
    const id = cmdId();
    await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "Court 1", sort_order: 2 }, id);
    const again = await send(admin, ORGANIZER, "create_court", { sort_order: 2, name: "Court 1", tournament_id: T }, id);
    expect(again.idempotent).toBe(true);
  });

  test("receipts written before 0018 (no fingerprint) still replay for the same type, and are refused for another", async () => {
    const admin = fixture();
    const id = cmdId();
    admin.tables.command_receipts.push({ id, actor_id: ORGANIZER.id, actor_device_id: null, command_type: "create_court", result: { court: { id: "old" } }, created_at: TS });
    expect((await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "X" }, id)).result).toEqual({ court: { id: "old" } });
    expect((await send(admin, ORGANIZER, "create_division", { tournament_id: T, name: "X", format: "single_elim" }, id).catch((e) => e)).code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  test("a rejected command writes no receipt and has no effect (retrying it re-evaluates it)", async () => {
    const admin = fixture();
    const id = cmdId();
    const err = await send(admin, ORGANIZER, "create_court", { tournament_id: T, name: "  " }, id).catch((e) => e);
    expect(err.status).toBe(400);
    expect(admin.tables.command_receipts).toHaveLength(0);
    expect(admin.tables.courts).toHaveLength(0);
  });
});

// ---- sequence --------------------------------------------------------------
describe("score sequence safety (scoring rules unchanged)", () => {
  test("normal: seq 1, 2, 3 apply in order", async () => {
    const admin = await started();
    for (const s of [1, 2, 3]) await send(admin, UMPIRE, "score_event", point(s));
    expect(matchRow(admin).score_state.lastSeq).toBe(3);
    expect(admin.tables.score_events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("duplicate retry of seq 3 (same command) is a replay; a resend of the same event_id is a no-op", async () => {
    const admin = await started();
    await send(admin, UMPIRE, "score_event", point(1));
    await send(admin, UMPIRE, "score_event", point(2));
    const ev = point(3);
    const id = ev.event_id; // the umpire lane uses event_id as command_id
    await send(admin, UMPIRE, "score_event", ev, id);
    expect((await send(admin, UMPIRE, "score_event", ev, id)).idempotent).toBe(true);
    const resent = await send(admin, UMPIRE, "score_event", ev); // new command_id, same event
    expect(resent.result.duplicate).toBe(true);
    expect(admin.tables.score_events).toHaveLength(3);
  });

  test("concurrent duplicate of seq 3 (same command twice at once): one event", async () => {
    const admin = await started();
    await send(admin, UMPIRE, "score_event", point(1));
    await send(admin, UMPIRE, "score_event", point(2));
    const ev = point(3);
    const [a, b] = await Promise.all([send(admin, UMPIRE, "score_event", ev, ev.event_id), send(admin, UMPIRE, "score_event", ev, ev.event_id)]);
    // Depending on timing the second is answered by the receipt claim
    // (idempotent) or by the existing event_id dedupe (duplicate) — either
    // way it succeeds and adds nothing.
    for (const r of [a, b]) expect(r.ok).toBe(true);
    expect(a.idempotent || b.idempotent || a.result.duplicate || b.result.duplicate).toBe(true);
    expect(admin.tables.score_events.filter((e) => e.seq === 3)).toHaveLength(1);
    expect(admin.tables.score_events).toHaveLength(3);
    expect(matchRow(admin).score_state.lastSeq).toBe(3);
  });

  test("stale client (server at 3, client sends 2): 409 OUT_OF_ORDER with the server's lastSeq, nothing written", async () => {
    const admin = await started();
    for (const s of [1, 2, 3]) await send(admin, UMPIRE, "score_event", point(s));
    const err = await send(admin, UMPIRE, "score_event", point(2)).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("OUT_OF_ORDER");
    expect(err.message).toContain("lastSeq=3");
    expect(admin.tables.score_events).toHaveLength(3);
  });

  test("future seq (server at 3, client sends 8): accepted — gaps are allowed by the existing engine rule (documented, unchanged)", async () => {
    const admin = await started();
    for (const s of [1, 2, 3]) await send(admin, UMPIRE, "score_event", point(s));
    await send(admin, UMPIRE, "score_event", point(8));
    expect(matchRow(admin).score_state.lastSeq).toBe(8);
    // …and after it, anything at or below 8 is stale
    expect((await send(admin, UMPIRE, "score_event", point(4)).catch((e) => e)).code).toBe("OUT_OF_ORDER");
  });

  test("two devices send DIFFERENT events at the same seq concurrently: one wins, the other gets 409 OUT_OF_ORDER", async () => {
    const admin = await started();
    await send(admin, UMPIRE, "score_event", point(1));
    const results = await Promise.allSettled([
      send(admin, UMPIRE, "score_event", point(2, "A")),
      send(admin, ORGANIZER, "score_event", { match_id: M, event_id: cmdId(), seq: 2, type: "correction", payload: { scoreA: 5, scoreB: 0 } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected").reason;
    expect(loser.status).toBe(409);
    expect(loser.code).toBe("OUT_OF_ORDER");
    expect(admin.tables.score_events.filter((e) => e.seq === 2)).toHaveLength(1);
    expect(matchRow(admin).score_state.lastSeq).toBe(2);
  });

  test("a raw (match_id, seq) unique violation is reported as OUT_OF_ORDER 409, never a retryable 500", async () => {
    const admin = await started();
    await send(admin, UMPIRE, "score_event", point(1));
    // inconsistent row already holding seq 2 while score_state still says 1
    admin.tables.score_events.push({ id: cmdId(), match_id: M, seq: 2, type: "point", payload: {} });
    const err = await send(admin, UMPIRE, "score_event", point(2)).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("OUT_OF_ORDER");
    expect(classifySendError(err)).toBe("rejected");
  });
});

// ---- stale writes / preconditions --------------------------------------------
describe("stale-state protection on matches", () => {
  test("BEFORE 0018: an operator hold racing an umpire point — both 'succeed', one write is silently lost", async () => {
    const admin = fixture({ legacy: true });
    await send(admin, UMPIRE, "start_match", { match_id: M });
    await send(admin, UMPIRE, "score_event", point(1));
    const results = await Promise.allSettled([
      send(admin, UMPIRE, "score_event", point(2)),
      send(admin, ORGANIZER, "transition_match", { match_id: M, status: "postponed" }),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const row = matchRow(admin);
    const holdKept = row.status === "postponed";
    const pointKept = row.score_state.lastSeq === 2;
    expect(holdKept && pointKept).toBe(false); // whichever committed last overwrote the other's change
  });

  test("an operator hold racing an umpire point never loses either write", async () => {
    const admin = await started();
    await send(admin, UMPIRE, "score_event", point(1));
    const results = await Promise.allSettled([
      send(admin, UMPIRE, "score_event", point(2)),
      send(admin, ORGANIZER, "transition_match", { match_id: M, status: "postponed" }),
    ]);
    const row = matchRow(admin);
    const maxSeq = Math.max(...admin.tables.score_events.map((e) => e.seq));
    expect(row.score_state.lastSeq).toBe(maxSeq); // score_state always matches the stored events
    expect(row.status).toBe("postponed");
    // if the point lost the race it was re-run and refused cleanly (match on hold), not dropped silently
    for (const r of results) if (r.status === "rejected") expect(r.reason.status).toBe(409);
  });

  test("a persistent read/write race gives up after exactly 3 attempts with a retryable 503, having written nothing", async () => {
    const admin = await started();
    const before = admin.rpcCalls;
    admin.faults.push("stale", "stale", "stale", "stale");
    const err = await send(admin, UMPIRE, "score_event", point(1)).catch((e) => e);
    expect(admin.rpcCalls - before).toBe(3); // bounded: never loops forever
    expect(err.status).toBe(503);
    expect(err.code).toBe("RETRY_LATER");
    expect(classifySendError(err)).toBe("retry");
    expect(admin.tables.score_events).toHaveLength(0);
    expect(admin.tables.command_receipts.filter((r) => r.command_type === "score_event")).toHaveLength(0);
    // the client's later retry of the SAME command applies it exactly once
    admin.faults.length = 0;
    const ev = point(1);
    await send(admin, UMPIRE, "score_event", ev, ev.event_id);
    expect(admin.tables.score_events).toHaveLength(1);
  });

  test("one stale attempt, then the re-run succeeds on fresh state: exactly one event, one receipt", async () => {
    const admin = await started();
    const before = admin.rpcCalls;
    admin.faults.push("stale");
    const ev = point(1);
    const out = await send(admin, UMPIRE, "score_event", ev, ev.event_id);
    expect(out.idempotent).toBe(false);
    expect(admin.rpcCalls - before).toBe(2);
    expect(admin.tables.score_events).toHaveLength(1);
    expect(admin.tables.command_receipts.filter((r) => r.id === ev.event_id)).toHaveLength(1);
    expect(matchRow(admin).score_state.lastSeq).toBe(1);
  });

  test("a client precondition on an older match version → 409 STALE_STATE, nothing written", async () => {
    const admin = await started();
    const seen = matchRow(admin).updated_at;
    await send(admin, UMPIRE, "score_event", point(1)); // match moves on
    const id = cmdId();
    const err = await send(admin, ORGANIZER, "transition_match", { match_id: M, status: "postponed", precondition: { match_updated_at: seen } }, id).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("STALE_STATE");
    expect(matchRow(admin).status).toBe("in_progress");
    expect(admin.tables.command_receipts.find((r) => r.id === id)).toBeUndefined();
    const { status, body } = errorResponse(err, id);
    expect(status).toBe(409);
    expect(body.error).toMatchObject({ code: "STALE_STATE", command_id: id, current_revision: matchRow(admin).updated_at });
  });

  test("a precondition is only accepted where it is fully enforced — otherwise 400, never silently ignored", async () => {
    const admin = await started();
    const v = matchRow(admin).updated_at;
    const refused = async (type, payload) => {
      const err = await send(admin, ORGANIZER, type, payload).catch((e) => e);
      expect(err.status, `${type} ${JSON.stringify(payload.precondition)}`).toBe(400);
      expect(err.code).toBe("INVALID_COMMAND");
      expect(classifySendError(err)).toBe("rejected");
    };
    // commands whose writes the match version does not fully cover
    await refused("create_court", { tournament_id: T, name: "X", precondition: { match_updated_at: v } });
    await refused("assign_court", { match_id: M, court_id: cmdId(), precondition: { match_updated_at: v } });
    await refused("assign_umpire", { match_id: M, user_id: UMPIRE.id, precondition: { match_updated_at: v } });
    // malformed preconditions on a supported command
    await refused("transition_match", { match_id: M, status: "postponed", precondition: "yesterday" });
    await refused("transition_match", { match_id: M, status: "postponed", precondition: { match_updated_at: "not a time" } });
    await refused("transition_match", { match_id: M, status: "postponed", precondition: { match_updated_at: v, court_updated_at: v } });
    await refused("transition_match", { status: "postponed", precondition: { match_updated_at: v } });
    expect(admin.tables.courts).toHaveLength(0);
    expect(matchRow(admin).status).toBe("in_progress");
    // a valid one on a supported command still applies
    const ev = point(1);
    await send(admin, UMPIRE, "score_event", { ...ev, precondition: { match_updated_at: v } }, ev.event_id);
    expect(matchRow(admin).score_state.lastSeq).toBe(1);
  });

  test("a client precondition on the current version applies normally", async () => {
    const admin = await started();
    const current = matchRow(admin).updated_at;
    await send(admin, ORGANIZER, "transition_match", { match_id: M, status: "postponed", precondition: { match_updated_at: current } });
    expect(matchRow(admin).status).toBe("postponed");
  });
});

// ---- error contract ------------------------------------------------------------
describe("error classification (HTTP status + client retry decision)", () => {
  const cases = [
    [{ code: "TC001" }, 409, "COMMAND_ALREADY_APPLIED"],
    [{ code: "TC412" }, 409, "STALE_WRITE"],
    [{ code: "TC409" }, 409, "STALE_STATE"],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "score_events_match_id_seq_key"' }, 409, "SEQ_CONFLICT"],
    [{ code: "23505", message: 'duplicate key value violates unique constraint "courts_station_public_id_key"' }, 409, "CONFLICT"],
    [{ message: 'duplicate key value violates unique constraint "x_uidx"' }, 409, "CONFLICT"],
    [{ code: "23503" }, 409, "CONFLICT"],
    [{ code: "23514" }, 400, "INVALID_COMMAND"],
    [{ code: "22P02" }, 400, "INVALID_COMMAND"],
    [{ code: "40001" }, 503, "RETRY_LATER"],
    [{ code: "40P01" }, 503, "RETRY_LATER"],
    [{ code: "08006" }, 503, "RETRY_LATER"],
    [{ code: "XX000", message: "internal error in relation secret_table" }, 500, "WRITE_FAILED"],
  ];
  test.each(cases)("%o → %i %s, with no database text in the message", (dbError, status, code) => {
    const err = writeError({ message: "", ...dbError, details: "Key (match_id, seq)=(…) already exists." });
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(err.message).not.toMatch(/constraint|duplicate key|relation|Key \(|secret_table|_key|uidx/i);
  });

  test("the client's existing classification: conflicts stop, transient failures retry, auth refreshes", () => {
    const e = (status) => Object.assign(new Error("x"), { status });
    expect(classifySendError(e(409))).toBe("rejected");
    expect(classifySendError(e(400))).toBe("rejected");
    expect(classifySendError(e(403))).toBe("rejected");
    expect(classifySendError(e(401))).toBe("auth");
    expect(classifySendError(e(503))).toBe("retry");
    expect(classifySendError(e(500))).toBe("retry");
    expect(classifySendError(e(429))).toBe("retry");
    expect(classifySendError(new TypeError("Failed to fetch"))).toBe("network");
  });

  test("errorResponse: deliberate API errors keep their code; raw internals are hidden", () => {
    expect(errorResponse(Object.assign(new Error("Match not found"), { status: 404, code: "NOT_FOUND" })).body.error).toEqual({ code: "NOT_FOUND", message: "Match not found" });
    const raw = errorResponse(Object.assign(new Error('relation "public.secret" does not exist'), { code: "42P01" }));
    expect(raw.status).toBe(500);
    expect(raw.body.error.code).toBe("INTERNAL");
    expect(raw.body.error.message).not.toMatch(/relation|secret/);
    const conflict = errorResponse(Object.assign(new Error("x"), { status: 409, code: "IDEMPOTENCY_KEY_REUSED" }), "cmd-1");
    expect(conflict.body.error.command_id).toBe("cmd-1");
  });

  test("malformed / unknown commands are permanent 400s (never retried forever)", async () => {
    const admin = fixture();
    const bad = await handleCommand({ admin, actor: ORGANIZER, body: { command_id: "not-a-uuid", type: "create_court", payload: {} } }).catch((e) => e);
    expect(bad.status).toBe(400);
    const unknown = await handleCommand({ admin, actor: ORGANIZER, body: { command_id: cmdId(), type: "drop_tables", payload: {} } }).catch((e) => e);
    expect(unknown.status).toBe(400);
    expect(classifySendError(bad)).toBe("rejected");
  });
});
