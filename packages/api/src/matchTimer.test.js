// Game timer through the real handleCommand(): who may change it, when the
// countdown starts, Hold/resume, and that scoring/completion never touch it.
// In-memory admin mirrors apply_official_writes the same way as
// commandIdempotency.test.js (atomic batch, receipt claim, matches.updated_at
// version check, touch trigger).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { handleCommand } from "./handleCommand.js";
import { timerView } from "@tournament/engine";

const tick = () => new Promise((r) => setTimeout(r, 0));

function createMemoryAdmin(seed) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const table = (name) => (tables[name] ||= []);
  let clock = 0;
  const nextTs = () => new Date(Date.now() + (++clock)).toISOString();

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
      update() { return builder; },
      async maybeSingle() { await tick(); return { data: run()[0] ?? null, error: null }; },
      async single() { await tick(); return { data: run()[0] ?? null, error: null }; },
      then(resolve, reject) { return tick().then(() => ({ data: run(), error: null })).then(resolve, reject); },
    };
    return builder;
  }

  function apply(payload) {
    for (const r of payload.upserts?.command_receipts || []) {
      if (table("command_receipts").some((x) => x.id === r.id)) return { data: null, error: { code: "TC001", message: "dup", details: r.id } };
    }
    for (const e of payload.expect || []) {
      const row = table("matches").find((m) => m.id === e.id);
      if (!row || row.updated_at !== e.updated_at) return { data: null, error: { code: "TC412", message: "changed", details: row?.updated_at ?? "" } };
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
    from: (name) => query(name),
    async rpc(_fn, { payload }) { await tick(); return apply(payload); },
  };
}

const T = "11111111-1111-4111-8111-111111111111";
const D = "22222222-2222-4222-8222-222222222222";
const M = "33333333-3333-4333-8333-333333333333";
const PA = "44444444-4444-4444-8444-444444444444";
const PB = "55555555-5555-4555-8555-555555555555";
const ORGANIZER = { kind: "user", id: "66666666-6666-4666-8666-666666666666", email: "organizer@example.com" };
const UMPIRE = { kind: "user", id: "77777777-7777-4777-8777-777777777777", email: "umpire@example.com" };
const STATION = { kind: "station", id: "99999999-9999-4999-8999-999999999999", deviceId: "99999999-9999-4999-8999-999999999999", courtId: "c-1", tournamentId: T };
const TS = "2026-09-27T00:00:00.000Z";
const T0 = Date.parse("2026-09-28T10:00:00.000Z");

// withTimerColumn=false models a database where migration 0019 isn't applied
// (select * returns no `timer` key at all).
function fixture({ withTimerColumn = true, timer = null, status = "assigned", divisionConfig = {} } = {}) {
  const match = {
    id: M, tournament_id: T, division_id: D, stage_id: null, stage_label: null, parent_match_id: null,
    round: 1, bracket_position: 0, status, score_state: {}, serving_team: null, coin_toss: null,
    next_match_id: null, winner: null, started_at: null, completed_at: null, created_at: TS, updated_at: TS,
  };
  if (withTimerColumn) match.timer = timer;
  return createMemoryAdmin({
    tournaments: [{ id: T, name: "Spring Open", status: "in_progress" }],
    tournament_members: [
      { id: "tm-o", tournament_id: T, user_id: ORGANIZER.id, role: "organizer" },
      { id: "tm-u", tournament_id: T, user_id: UMPIRE.id, role: "umpire" },
    ],
    licenses: [{ id: "lic-1", email: ORGANIZER.email, status: "active", expires_at: null, created_at: TS }],
    divisions: [{ id: D, tournament_id: T, name: "Open", format: "single_elim", config: divisionConfig }],
    participants: [
      { id: PA, tournament_id: T, division_id: D, display_name: "A" },
      { id: PB, tournament_id: T, division_id: D, display_name: "B" },
    ],
    matches: [match],
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
    match_results: [],
  });
}

let n = 0;
const cmdId = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`;
const send = (admin, actor, type, payload) => handleCommand({ admin, actor, body: { command_id: cmdId(), type, payload } });
const fail = (p) => p.then(() => { throw new Error("expected failure"); }, (e) => e);
const row = (admin) => admin.tables.matches.find((m) => m.id === M);
const setTimer = (admin, actor, seconds) => send(admin, actor, "set_match_timer", { match_id: M, action: "set", duration_seconds: seconds });
const advance = (sec) => vi.setSystemTime(Date.now() + sec * 1000);
const remaining = (admin) => timerView(row(admin), Date.now()).remainingMs;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("set_match_timer — before the game starts", () => {
  test("organizer configures the game time; it does not start counting", async () => {
    const admin = fixture();
    const out = await setTimer(admin, ORGANIZER, 600);
    expect(out.result.match.timer).toMatchObject({ durationSec: 600, remainingMs: 600000, runningSince: null });
    expect(row(admin).status).toBe("assigned");
    expect(row(admin).started_at).toBeNull();
    advance(3600);
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "configured", remainingMs: 600000 });
  });

  test("the duration can be changed and cleared before start", async () => {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    await setTimer(admin, ORGANIZER, 900);
    expect(row(admin).timer.durationSec).toBe(900);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "clear" });
    expect(row(admin).timer).toBeNull();
  });

  test("invalid durations are rejected and nothing is written", async () => {
    const admin = fixture();
    for (const bad of [0, -600, 30, 10801, 90.5, "600", null, undefined]) {
      const err = await fail(setTimer(admin, ORGANIZER, bad));
      expect(err.status).toBe(400);
      expect(err.code).toBe("INVALID_GAME_TIME");
    }
    expect(row(admin).timer).toBeNull();
    expect(admin.tables.audit_logs).toHaveLength(0);
  });

  test("unknown action is rejected", async () => {
    const err = await fail(send(fixture(), ORGANIZER, "set_match_timer", { match_id: M, action: "start" }));
    expect(err.status).toBe(400);
  });

  test("adjust/reset before start are refused", async () => {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    const err = await fail(send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 }));
    expect(err).toMatchObject({ status: 409, code: "MATCH_NOT_ACTIVE" });
  });
});

describe("set_match_timer — assigned umpire, before the match starts", () => {
  const OTHER_UMPIRE = { kind: "user", id: "88888888-8888-4888-8888-888888888888", email: "other.umpire@example.com" };
  const withOtherUmpire = (admin) => {
    admin.tables.tournament_members.push({ id: "tm-u2", tournament_id: T, user_id: OTHER_UMPIRE.id, role: "umpire" });
    return admin;
  };

  test("sets the game time without starting the countdown; status untouched", async () => {
    const admin = fixture();
    await setTimer(admin, UMPIRE, 600);
    expect(row(admin).timer).toMatchObject({ durationSec: 600, remainingMs: 600000, runningSince: null, updatedBy: UMPIRE.id });
    expect(row(admin).status).toBe("assigned");
    advance(3600);
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "configured", remainingMs: 600000 });
  });

  test("can change and remove it before the start; invalid values are rejected", async () => {
    const admin = fixture();
    await setTimer(admin, UMPIRE, 600);
    await setTimer(admin, UMPIRE, 720);
    expect(row(admin).timer.durationSec).toBe(720);
    const bad = await fail(setTimer(admin, UMPIRE, 30));
    expect(bad).toMatchObject({ status: 400, code: "INVALID_GAME_TIME" });
    await send(admin, UMPIRE, "set_match_timer", { match_id: M, action: "clear" });
    expect(row(admin).timer).toBeNull();
  });

  test("the countdown starts only through the real start_match", async () => {
    const admin = fixture();
    await setTimer(admin, UMPIRE, 600);
    advance(120); // setting the time never starts it
    await send(admin, UMPIRE, "start_match", { match_id: M });
    advance(30);
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "running", remainingMs: 570000 });
  });

  test("an umpire not assigned to this match is rejected", async () => {
    const admin = withOtherUmpire(fixture());
    const err = await fail(setTimer(admin, OTHER_UMPIRE, 600));
    expect(err).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(row(admin).timer).toBeNull();
  });

  test("once started, the assigned umpire has no override: adjust, reset, set and clear are refused", async () => {
    const admin = fixture();
    await setTimer(admin, UMPIRE, 600);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    const before = row(admin).timer;
    for (const payload of [
      { action: "adjust", delta_seconds: 60 },
      { action: "adjust", delta_seconds: -60 },
      { action: "reset" },
      { action: "set", duration_seconds: 900 },
      { action: "clear" },
    ]) {
      const err = await fail(send(admin, UMPIRE, "set_match_timer", { match_id: M, ...payload }));
      expect(err).toMatchObject({ status: 403, code: "FORBIDDEN" });
    }
    expect(row(admin).timer).toEqual(before);
    // the Operator/SA override is untouched
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 });
    expect(row(admin).timer.remainingMs).toBe(660000);
  });

  test("a completed match stays protected from the umpire", async () => {
    const admin = fixture({ status: "completed" });
    const err = await fail(setTimer(admin, UMPIRE, 600));
    expect(err.status).toBe(409);
    expect(row(admin).timer).toBeNull();
  });
});

describe("set_match_timer — authorization (server-side)", () => {

  test("a court station cannot change the timer", async () => {
    const admin = fixture();
    const err = await fail(setTimer(admin, STATION, 600));
    expect(err).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(row(admin).timer).toBeNull();
  });

  test("a non-member cannot change the timer", async () => {
    const stranger = { kind: "user", id: "12121212-1212-4212-8212-121212121212", email: "x@example.com" };
    const err = await fail(setTimer(fixture(), stranger, 600));
    expect(err.status).toBe(403);
  });
});

describe("start_match starts the timer — exactly once, and only there", () => {
  test("countdown begins at the real start", async () => {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    advance(120); // time before start does not count
    await send(admin, UMPIRE, "start_match", { match_id: M });
    const m = row(admin);
    expect(m.status).toBe("in_progress");
    expect(m.timer.runningSince).toBe(m.started_at);
    advance(18);
    expect(remaining(admin)).toBe(582000);
  });

  test("the division default applies when the match has no timer of its own", async () => {
    const admin = fixture({ divisionConfig: { gameTimeSeconds: 480 } });
    await send(admin, UMPIRE, "start_match", { match_id: M });
    expect(row(admin).timer).toMatchObject({ durationSec: 480, remainingMs: 480000, runningSince: row(admin).started_at });
  });

  test("a match timer wins over the division default", async () => {
    const admin = fixture({ divisionConfig: { gameTimeSeconds: 480 } });
    await setTimer(admin, ORGANIZER, 600);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    expect(row(admin).timer.durationSec).toBe(600);
  });

  test("no timer configured: the match starts exactly as before", async () => {
    const admin = fixture();
    await send(admin, UMPIRE, "start_match", { match_id: M });
    expect(row(admin).status).toBe("in_progress");
    expect(row(admin).timer).toBeNull();
  });

  test("database without the timer column: start unchanged, timer command refused", async () => {
    const admin = fixture({ withTimerColumn: false, divisionConfig: { gameTimeSeconds: 480 } });
    const err = await fail(setTimer(admin, ORGANIZER, 600));
    expect(err).toMatchObject({ status: 409, code: "TIMER_UNAVAILABLE" });
    await send(admin, UMPIRE, "start_match", { match_id: M });
    expect(Object.hasOwn(row(admin), "timer")).toBe(false);
  });

  test("a second start is refused and does not restart the countdown", async () => {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    const anchor = row(admin).timer.runningSince;
    advance(60);
    const err = await fail(send(admin, UMPIRE, "start_match", { match_id: M }));
    expect(err.status).toBe(409);
    expect(row(admin).timer.runningSince).toBe(anchor);
    expect(remaining(admin)).toBe(540000);
  });

  test("set after the game started is refused when the match already has a timer", async () => {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    const err = await fail(setTimer(admin, ORGANIZER, 900));
    expect(err).toMatchObject({ status: 409, code: "MATCH_ALREADY_STARTED" });
    expect(row(admin).timer.durationSec).toBe(600);
  });
});

describe("during the game", () => {
  async function live(seconds = 600) {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, seconds);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    return admin;
  }

  test("organizer adds and removes time while running", async () => {
    const admin = await live();
    advance(100);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 });
    expect(remaining(admin)).toBe(560000);
    advance(10);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: -60 });
    expect(remaining(admin)).toBe(490000);
    expect(row(admin).status).toBe("in_progress");
  });

  test("removing time near expiry clamps at 00:00 and leaves the match live", async () => {
    const admin = await live();
    advance(570);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: -60 });
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "expired", remainingMs: 0 });
    expect(row(admin).status).toBe("in_progress");
  });

  test("reset restarts from the full duration", async () => {
    const admin = await live();
    advance(300);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "reset" });
    expect(remaining(admin)).toBe(600000);
  });

  test("the umpire cannot adjust a running timer", async () => {
    const admin = await live();
    const err = await fail(send(admin, UMPIRE, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 600 }));
    expect(err.status).toBe(403);
  });

  test("invalid adjustments are rejected", async () => {
    const admin = await live();
    for (const bad of [0, 3601, 1.5, "60"]) {
      const err = await fail(send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: bad }));
      expect(err.status).toBe(400);
    }
  });

  test("expiry changes nothing: scoring continues normally after 00:00", async () => {
    const admin = await live(60);
    advance(600);
    expect(timerView(row(admin), Date.now()).state).toBe("expired");
    await send(admin, UMPIRE, "score_event", { match_id: M, event_id: cmdId(), seq: 1, type: "point", payload: { team: "A" } });
    expect(row(admin).status).toBe("in_progress");
    expect(row(admin).winner).toBeNull();
  });

  test("scoring leaves the timer untouched", async () => {
    const admin = await live();
    const before = row(admin).timer;
    advance(30);
    await send(admin, UMPIRE, "score_event", { match_id: M, event_id: cmdId(), seq: 1, type: "point", payload: { team: "A" } });
    expect(row(admin).timer).toEqual(before);
  });

  test("Hold banks the remaining time; restart resumes from it", async () => {
    const admin = await live();
    advance(100);
    await send(admin, UMPIRE, "transition_match", { match_id: M, status: "postponed", reason: "rain" });
    expect(row(admin).timer).toMatchObject({ remainingMs: 500000, runningSince: null });
    advance(1800); // time on hold does not count
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "paused", remainingMs: 500000 });
    // organizer may still add time while held
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 });
    await send(admin, ORGANIZER, "transition_match", { match_id: M, status: "ready" });
    await send(admin, UMPIRE, "start_match", { match_id: M });
    advance(10);
    expect(remaining(admin)).toBe(550000);
  });
});

describe("resumed match (Hold → Resume → ready) keeps its banked time", () => {
  async function resumed() {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    advance(120);
    await send(admin, UMPIRE, "transition_match", { match_id: M, status: "postponed" });
    await send(admin, ORGANIZER, "transition_match", { match_id: M, status: "ready" });
    expect(row(admin).status).toBe("ready");
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "paused", remainingMs: 480000 });
    return admin;
  }

  test("set and clear are refused; the banked 08:00 is untouched", async () => {
    const admin = await resumed();
    const set = await fail(setTimer(admin, ORGANIZER, 600));
    expect(set).toMatchObject({ status: 409, code: "MATCH_ALREADY_STARTED" });
    const clear = await fail(send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "clear" }));
    expect(clear).toMatchObject({ status: 409, code: "MATCH_ALREADY_STARTED" });
    expect(row(admin).timer).toMatchObject({ remainingMs: 480000, runningSince: null });
  });

  test("+1 min and reset work in ready; the restart continues from the adjusted time", async () => {
    const admin = await resumed();
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 });
    expect(row(admin).timer).toMatchObject({ remainingMs: 540000, runningSince: null });
    advance(600); // still not running while in ready
    await send(admin, UMPIRE, "start_match", { match_id: M });
    advance(40);
    expect(remaining(admin)).toBe(500000);
  });

  test("reset in ready restores the full duration without starting it", async () => {
    const admin = await resumed();
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "reset" });
    expect(row(admin).timer).toMatchObject({ remainingMs: 600000, runningSince: null });
    expect(row(admin).status).toBe("ready");
  });

  test("a match postponed before it ever started can still be given a game time", async () => {
    const admin = fixture({ status: "postponed" });
    await setTimer(admin, ORGANIZER, 600);
    expect(row(admin).timer).toMatchObject({ durationSec: 600, runningSince: null });
  });

  test("division default never attaches a fresh timer on a restart after Hold", async () => {
    const admin = fixture();
    await send(admin, UMPIRE, "start_match", { match_id: M }); // no timer, no default
    admin.tables.divisions[0].config = { gameTimeSeconds: 480 }; // default added mid-match
    await send(admin, UMPIRE, "transition_match", { match_id: M, status: "postponed" });
    await send(admin, ORGANIZER, "transition_match", { match_id: M, status: "ready" });
    await send(admin, UMPIRE, "start_match", { match_id: M });
    expect(row(admin).status).toBe("in_progress");
    expect(row(admin).timer).toBeNull();
  });
});

describe("Operator takes over a started match that has no timer", () => {
  async function liveNoTimer() {
    const admin = fixture(); // no timer, no division default
    await send(admin, UMPIRE, "start_match", { match_id: M });
    expect(row(admin).timer).toBeNull();
    return admin;
  }

  test("set on a live match starts counting from now; score and status untouched", async () => {
    const admin = await liveNoTimer();
    advance(300); // the match has been live for 5 minutes
    const before = { status: row(admin).status, score_state: row(admin).score_state, started_at: row(admin).started_at };
    await setTimer(admin, ORGANIZER, 600);
    expect(row(admin).timer).toMatchObject({ durationSec: 600, remainingMs: 600000, runningSince: new Date(Date.now()).toISOString() });
    expect(row(admin)).toMatchObject(before);
    advance(90);
    expect(timerView(row(admin), Date.now())).toMatchObject({ state: "running", remainingMs: 510000 });
  });

  test("once set, +1 / −1 / reset work and a second set or clear is refused", async () => {
    const admin = await liveNoTimer();
    await setTimer(admin, ORGANIZER, 600);
    advance(120);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 });
    expect(remaining(admin)).toBe(540000);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: -60 });
    expect(remaining(admin)).toBe(480000);
    await send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "reset" });
    expect(remaining(admin)).toBe(600000);
    expect(row(admin).timer.runningSince).toBeTruthy(); // reset keeps it running
    const again = await fail(setTimer(admin, ORGANIZER, 900));
    expect(again).toMatchObject({ status: 409, code: "MATCH_ALREADY_STARTED" });
    const clear = await fail(send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "clear" }));
    expect(clear).toMatchObject({ status: 409, code: "MATCH_ALREADY_STARTED" });
    expect(row(admin).timer.durationSec).toBe(600);
  });

  test("set on a held match stays paused; the restart counts from the full duration", async () => {
    const admin = await liveNoTimer();
    await send(admin, UMPIRE, "transition_match", { match_id: M, status: "postponed" });
    await setTimer(admin, ORGANIZER, 600);
    expect(row(admin).timer).toMatchObject({ remainingMs: 600000, runningSince: null });
    advance(900);
    await send(admin, ORGANIZER, "transition_match", { match_id: M, status: "ready" });
    await send(admin, UMPIRE, "start_match", { match_id: M });
    advance(30);
    expect(remaining(admin)).toBe(570000);
  });

  test("the umpire still cannot set it, and a completed match stays refused", async () => {
    const admin = await liveNoTimer();
    const err = await fail(setTimer(admin, UMPIRE, 600));
    expect(err.status).toBe(403);
    expect(row(admin).timer).toBeNull();
    const done = fixture({ status: "completed" });
    const err2 = await fail(setTimer(done, ORGANIZER, 600));
    expect(err2).toMatchObject({ status: 409, code: "MATCH_NOT_ACTIVE" });
  });
});

describe("completion", () => {
  test("game finishes before the timer: frozen, never restarts, cannot be adjusted", async () => {
    const admin = fixture();
    await setTimer(admin, ORGANIZER, 600);
    await send(admin, UMPIRE, "start_match", { match_id: M });
    let seq = 0;
    // side-out scoring: alternate rallies until A wins the game
    for (let i = 0; i < 200 && row(admin).status !== "completed"; i += 1) {
      advance(1);
      await send(admin, UMPIRE, "score_event", { match_id: M, event_id: cmdId(), seq: ++seq, type: "point", payload: { team: "A" } });
    }
    const done = row(admin);
    expect(done.status).toBe("completed");
    const frozen = timerView(done, Date.now());
    expect(frozen.state).toBe("finished");
    advance(5000);
    expect(timerView(row(admin), Date.now())).toEqual(frozen);
    const err = await fail(send(admin, ORGANIZER, "set_match_timer", { match_id: M, action: "adjust", delta_seconds: 60 }));
    expect(err).toMatchObject({ status: 409, code: "MATCH_NOT_ACTIVE" });
    const err2 = await fail(setTimer(admin, ORGANIZER, 600));
    expect(err2.status).toBe(409);
  });
});
