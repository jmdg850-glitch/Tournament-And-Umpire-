// Phase F end to end on REAL PostgreSQL: the real handleCommand() (receipt
// fast path, request fingerprint, claim resolution, stale-write re-run, error
// mapping) running against the real migrations — no in-memory database.
//
// A tiny admin adapter turns the handlers' supabase-js calls (.from().select()
// .eq()…, .rpc("apply_official_writes")) into SQL executed by psql, one
// process per call, and reports failures the way PostgREST does
// ({ code: <SQLSTATE>, message, details }). Each simulated client gets its own
// adapter, so two commands genuinely run at the same time in two database
// sessions. Hooks let a test pause one client right before its write to force
// an exact interleaving (the only way to make a race deterministic).
//
// Runs only when LOCAL_PG_BIN points at a PostgreSQL bin directory; it creates
// a throwaway cluster in the OS temp dir on its own port and deletes it after.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { classifySendError } from "@tournament/client";
import { errorResponse, handleCommand } from "./handleCommand.js";

const PG_BIN = process.env.LOCAL_PG_BIN;
const PORT = String(process.env.LOCAL_PG_FLOW_PORT || 55443);
const exe = (name) => join(PG_BIN || "", process.platform === "win32" ? `${name}.exe` : name);
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");
const env = { ...process.env, PGTZ: "UTC" }; // Supabase serves timestamps in UTC

let dir;
const baseArgs = () => ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"];
function sqlFile(sql) {
  const file = join(dir, `q-${randomUUID()}.sql`);
  writeFileSync(file, `\\set VERBOSITY verbose\n${sql}`);
  return file;
}
function psqlSync(sql) {
  return execFileSync(exe("psql"), [...baseArgs(), "-f", sqlFile(sql)], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
}
function psqlRun(sql) {
  return new Promise((done) => {
    const p = spawn(exe("psql"), [...baseArgs(), "-f", sqlFile(sql)], { env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => done({ code, stdout, stderr }));
  });
}
const scalar = (sql) => psqlSync(sql).trim();

// psql's verbose error → the PostgREST error object supabase-js hands the API.
function pgError(stderr) {
  const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
  const d = /DETAIL:\s+(.*)/.exec(stderr);
  return { code: m ? m[1] : "", message: m ? m[2].trim() : stderr.trim(), details: d ? d[1].trim() : null, hint: null };
}
const lit = (v) => (v === null || v === undefined ? "null" : `'${String(v).replace(/'/g, "''")}'`);
const ident = (c) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw new Error(`unsafe identifier ${c}`);
  return c;
};

function createPgAdmin({ beforeRpc, afterCommit } = {}) {
  let rpcCalls = 0;
  function from(table) {
    const where = [];
    const order = [];
    let cols = "*";
    let limit = null;
    let mode = "many";
    const run = async () => {
      const sql = `select coalesce(json_agg(t), '[]'::json) from (select ${cols} from public.${ident(table)}`
        + ` where ${where.length ? where.join(" and ") : "true"}`
        + (order.length ? ` order by ${order.join(", ")}` : "")
        + (limit != null ? ` limit ${Number(limit)}` : "") + ") t;";
      const r = await psqlRun(sql);
      if (r.code !== 0) return { data: null, error: pgError(r.stderr) };
      const rows = JSON.parse(r.stdout.trim() || "[]");
      if (mode === "many") return { data: rows, error: null };
      if (rows.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
      if (mode === "single" && rows.length === 0) return { data: null, error: { code: "PGRST116", message: "no rows" } };
      return { data: rows[0] ?? null, error: null };
    };
    const b = {
      select(c = "*") { cols = c.split(",").map((x) => (x.trim() === "*" ? "*" : ident(x.trim()))).join(", "); return b; },
      eq(c, v) { where.push(`${ident(c)} = ${lit(v)}`); return b; },
      in(c, vs) { where.push(vs.length ? `${ident(c)} in (${vs.map(lit).join(", ")})` : "false"); return b; },
      is(c, v) { where.push(v === null ? `${ident(c)} is null` : `${ident(c)} is ${v ? "true" : "false"}`); return b; },
      order(c, o = {}) { order.push(`${ident(c)} ${o.ascending === false ? "desc" : "asc"}`); return b; },
      limit(n) { limit = n; return b; },
      maybeSingle() { mode = "maybe"; return run(); },
      single() { mode = "single"; return run(); },
      then(res, rej) { return run().then(res, rej); },
    };
    return b;
  }
  return {
    get rpcCalls() { return rpcCalls; },
    from,
    async rpc(fn, { payload }) {
      if (fn !== "apply_official_writes") throw new Error(`unexpected rpc ${fn}`);
      rpcCalls += 1;
      if (beforeRpc) await beforeRpc(payload, rpcCalls);
      const tag = `p${randomUUID().replace(/-/g, "")}`;
      const r = await psqlRun(`select public.apply_official_writes($${tag}$${JSON.stringify(payload)}$${tag}$::jsonb);`);
      if (r.code !== 0) return { data: null, error: pgError(r.stderr) };
      if (afterCommit) return afterCommit(payload) || { data: { ok: true }, error: null };
      return { data: { ok: true }, error: null };
    },
  };
}

// ---- fixture ---------------------------------------------------------------
const ORG = { kind: "user", id: randomUUID(), email: "organizer@example.com" };
const ORG2 = { kind: "user", id: randomUUID(), email: "organizer@example.com" };
const UMP = { kind: "user", id: randomUUID(), email: "umpire@example.com" };
const T = randomUUID(), D = randomUUID(), PA = randomUUID(), PB = randomUUID();

function newMatch(status = "assigned") {
  const id = randomUUID();
  psqlSync(`insert into public.matches (id, tournament_id, division_id, round, bracket_position, status, score_state)
              values ('${id}', '${T}', '${D}', 1, 0, '${status}', '{}');
            insert into public.match_participants (id, match_id, slot, participant_id) values
              ('${randomUUID()}', '${id}', 'A', '${PA}'), ('${randomUUID()}', '${id}', 'B', '${PB}');
            insert into public.umpire_assignments (id, match_id, user_id) values ('${randomUUID()}', '${id}', '${UMP.id}');`);
  return id;
}
const send = (admin, actor, type, payload, command_id = randomUUID()) => handleCommand({ admin, actor, body: { command_id, type, payload } });
const point = (matchId, seq, team = "A") => ({ match_id: matchId, event_id: randomUUID(), seq, type: "point", payload: { team } });
const count = (sql) => Number(scalar(sql));
const auditCount = (id) => count(`select count(*) from public.audit_logs where command_id = '${id}';`);
const receiptCount = (id) => count(`select count(*) from public.command_receipts where id = '${id}';`);
const courtsNamed = (name) => count(`select count(*) from public.courts where name = ${lit(name)};`);
const matchState = (id) => JSON.parse(scalar(`select json_build_object('status', status, 'lastSeq', (score_state->>'lastSeq')::int, 'v', to_json(updated_at)#>>'{}') from public.matches where id = '${id}';`));
async function started() {
  const m = newMatch();
  await send(createPgAdmin(), UMP, "start_match", { match_id: m });
  return m;
}
// Both clients reach their write before either is allowed to proceed.
function barrier(n) {
  let arrived = 0;
  let open;
  const gate = new Promise((r) => { open = r; });
  return async () => { arrived += 1; if (arrived === n) open(); await gate; };
}

describe.skipIf(!PG_BIN)("Phase F end to end — real handleCommand on real PostgreSQL", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "flow-pg-"));
    const data = join(dir, "data");
    execFileSync(exe("initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(exe("pg_ctl"), ["-D", data, "-l", join(dir, "pg.log"), "-w", "-o", `-p ${PORT} -c listen_addresses=127.0.0.1 -c timezone=UTC`, "start"], { stdio: "ignore" });
    psqlSync(`create role service_role; create role anon; create role authenticated;
              create schema auth; create table auth.users (id uuid primary key);
              create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
              create extension if not exists pgcrypto;
              create schema private;
              create function private.is_tournament_member(uuid) returns boolean language sql as $$ select true $$;`);
    for (const f of ["0001_initial_schema.sql", "0005_touch_updated_at_search_path.sql", "0006_court_stations.sql",
      "0007_official_writes_present_columns.sql", "0011_score_correction_event.sql", "0017_one_team_knockout_stage_per_division.sql",
      "0018_atomic_command_idempotency.sql", "0019_match_timer.sql"]) {
      psqlSync(readFileSync(join(migrations, f), "utf8"));
    }
    // Read-only stand-in for the licensing table (only these columns are read).
    psqlSync(`create table public.licenses (id uuid primary key default gen_random_uuid(), email text, status text, expires_at timestamptz, created_at timestamptz default now());
              create trigger matches_touch before update on public.matches for each row execute function private.touch_updated_at();
              insert into auth.users values ('${ORG.id}'), ('${ORG2.id}'), ('${UMP.id}');
              insert into public.profiles (id, display_name) values ('${ORG.id}', 'Org'), ('${ORG2.id}', 'Org2'), ('${UMP.id}', 'Ump');
              insert into public.tournaments (id, name, owner_id) values ('${T}', 'T', '${ORG.id}');
              insert into public.tournament_members (id, tournament_id, user_id, role) values
                ('${randomUUID()}', '${T}', '${ORG.id}', 'organizer'), ('${randomUUID()}', '${T}', '${ORG2.id}', 'organizer'),
                ('${randomUUID()}', '${T}', '${UMP.id}', 'umpire');
              insert into public.licenses (email, status) values ('organizer@example.com', 'active');
              insert into public.divisions (id, tournament_id, name, format) values ('${D}', '${T}', 'Open', 'single_elim');
              insert into public.participants (id, tournament_id, division_id, kind, display_name) values
                ('${PA}', '${T}', '${D}', 'doubles', 'A'), ('${PB}', '${T}', '${D}', 'doubles', 'B');`);
  }, 180_000);

  afterAll(() => {
    if (!dir) return;
    try { execFileSync(exe("pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("A — same command_id + same payload, truly concurrent: one effect, one receipt, one audit row, both callers get the result", async () => {
    const id = randomUUID();
    const payload = { tournament_id: T, name: "A-court" };
    const both = barrier(2);
    const [r1, r2] = await Promise.all([
      send(createPgAdmin({ beforeRpc: both }), ORG, "create_court", payload, id),
      send(createPgAdmin({ beforeRpc: both }), ORG, "create_court", payload, id),
    ]);
    expect([r1.idempotent, r2.idempotent].sort()).toEqual([false, true]); // one executed, one replayed the claim winner
    expect(r1.result).toEqual(r2.result);
    expect(courtsNamed("A-court")).toBe(1);
    expect(receiptCount(id)).toBe(1);
    expect(auditCount(id)).toBe(1);
  }, 60_000);

  test("B — same command_id + different payload, concurrent: one executes, the other 409 IDEMPOTENCY_KEY_REUSED, no second effect", async () => {
    const id = randomUUID();
    const both = barrier(2);
    const results = await Promise.allSettled([
      send(createPgAdmin({ beforeRpc: both }), ORG, "create_court", { tournament_id: T, name: "B-one" }, id),
      send(createPgAdmin({ beforeRpc: both }), ORG, "create_court", { tournament_id: T, name: "B-two" }, id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(courtsNamed("B-one") + courtsNamed("B-two")).toBe(1);
    expect(auditCount(id)).toBe(1);
  }, 60_000);

  test("C — same command_id from a different actor (concurrent and sequential): 409, no second effect, no result leaked", async () => {
    const id = randomUUID();
    const both = barrier(2);
    const payload = { tournament_id: T, name: "C-court" };
    const results = await Promise.allSettled([
      send(createPgAdmin({ beforeRpc: both }), ORG, "create_court", payload, id),
      send(createPgAdmin({ beforeRpc: both }), ORG2, "create_court", payload, id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected").reason;
    expect(refused).toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(courtsNamed("C-court")).toBe(1);
    expect(auditCount(id)).toBe(1);
    // sequential: another actor replaying someone's command id gets nothing back
    const id2 = randomUUID();
    await send(createPgAdmin(), ORG, "create_court", { tournament_id: T, name: "C-seq" }, id2);
    const stolen = await send(createPgAdmin(), ORG2, "create_court", { tournament_id: T, name: "C-seq" }, id2).catch((e) => e);
    expect(stolen).toMatchObject({ status: 409, code: "IDEMPOTENCY_KEY_REUSED" });
    expect(JSON.stringify(errorResponse(stolen, id2).body)).not.toMatch(/C-seq|station_public_id/);
    expect(courtsNamed("C-seq")).toBe(1);
    expect(auditCount(id2)).toBe(1);
  }, 60_000);

  test("D — lost HTTP response: the database committed, the retry replays it; exactly one effect", async () => {
    const id = randomUUID();
    const payload = { tournament_id: T, name: "D-court" };
    // The commit happens for real; only the answer is lost on the way back.
    const lossy = createPgAdmin({ afterCommit: () => ({ data: null, error: { code: "", message: "fetch failed", details: null } }) });
    const lost = await send(lossy, ORG, "create_court", payload, id).catch((e) => e);
    expect(lost.status).toBe(500);
    expect(classifySendError(lost)).toBe("retry");
    expect(errorResponse(lost, id).body.error.message).not.toMatch(/fetch failed/);
    const retry = await send(createPgAdmin(), ORG, "create_court", payload, id);
    expect(retry.idempotent).toBe(true);
    expect(courtsNamed("D-court")).toBe(1);
    expect(receiptCount(id)).toBe(1);
    expect(auditCount(id)).toBe(1);
  }, 60_000);

  test("E — stale writer: an operator hold that read version v1 while a point committed v2 is re-run, and BOTH writes survive", async () => {
    const m = await started();
    let release;
    const pointCommitted = new Promise((r) => { release = r; });
    // The hold reads the match, then waits right before writing until the
    // umpire's point has committed — the exact lost-update interleaving.
    let reached;
    const holdAtWrite = new Promise((r) => { reached = r; });
    const holdAdmin = createPgAdmin({ beforeRpc: async (_p, n) => { if (n === 1) { reached(); await pointCommitted; } } });
    const hold = send(holdAdmin, ORG, "transition_match", { match_id: m, status: "postponed" });
    await holdAtWrite; // the hold has read v1 and is about to write
    await send(createPgAdmin(), UMP, "score_event", point(m, 1));
    release();
    const out = await hold;
    expect(out.ok).toBe(true);
    expect(holdAdmin.rpcCalls).toBe(2); // 1st write refused as stale (TC412), re-run once
    const s = matchState(m);
    expect(s.status).toBe("postponed"); // the hold
    expect(s.lastSeq).toBe(1); // the point — not overwritten by the stale snapshot
    expect(count(`select count(*) from public.score_events where match_id = '${m}';`)).toBe(1);
  }, 90_000);

  test("E (control) — the same interleaving WITHOUT the version check loses the point: the test really detects lost updates", async () => {
    const m = await started();
    let release;
    const pointCommitted = new Promise((r) => { release = r; });
    let reached;
    const holdAtWrite = new Promise((r) => { reached = r; });
    const noVersionCheck = createPgAdmin({
      beforeRpc: async (payload, n) => { if (n === 1) { reached(); await pointCommitted; } delete payload.expect; },
    });
    const hold = send(noVersionCheck, ORG, "transition_match", { match_id: m, status: "postponed" });
    await holdAtWrite;
    await send(createPgAdmin(), UMP, "score_event", point(m, 1));
    release();
    await hold;
    const s = matchState(m);
    expect(s.status).toBe("postponed");
    expect(s.lastSeq ?? 0).toBe(0); // the committed point was silently overwritten
    expect(count(`select count(*) from public.score_events where match_id = '${m}';`)).toBe(1);
  }, 90_000);

  test("F — persistent stale conflict: exactly 3 attempts, then 503 RETRY_LATER (retryable); nothing from the command is kept", async () => {
    const m = await started();
    const id = randomUUID();
    // Before every write attempt another session changes the match first.
    const admin = createPgAdmin({ beforeRpc: async () => { await psqlRun(`update public.matches set serving_team = serving_team where id = '${m}';`); } });
    const err = await send(admin, ORG, "transition_match", { match_id: m, status: "postponed" }, id).catch((e) => e);
    expect(admin.rpcCalls).toBe(3);
    expect(err).toMatchObject({ status: 503, code: "RETRY_LATER" });
    expect(classifySendError(err)).toBe("retry");
    expect(matchState(m).status).toBe("in_progress");
    expect(receiptCount(id)).toBe(0);
    expect(auditCount(id)).toBe(0);
  }, 90_000);

  test("two devices score the same seq at the same instant: one event, the other 409 OUT_OF_ORDER (not a retryable 500)", async () => {
    const m = await started();
    const both = barrier(2);
    const results = await Promise.allSettled([
      send(createPgAdmin({ beforeRpc: both }), UMP, "score_event", point(m, 1, "A")),
      send(createPgAdmin({ beforeRpc: both }), ORG, "score_event", { match_id: m, event_id: randomUUID(), seq: 1, type: "correction", payload: { scoreA: 3, scoreB: 0 } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected").reason;
    expect(loser).toMatchObject({ status: 409, code: "OUT_OF_ORDER" });
    expect(classifySendError(loser)).toBe("rejected");
    expect(count(`select count(*) from public.score_events where match_id = '${m}';`)).toBe(1);
    expect(matchState(m).lastSeq).toBe(1);
  }, 90_000);

  test("client precondition: stale → 409 STALE_STATE with the current revision in API format; current → applies", async () => {
    const m = await started();
    const seen = matchState(m).v;
    await send(createPgAdmin(), UMP, "score_event", point(m, 1));
    const now = matchState(m).v;
    const id = randomUUID();
    const err = await send(createPgAdmin(), ORG, "transition_match", { match_id: m, status: "postponed", precondition: { match_updated_at: seen } }, id).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "STALE_STATE" });
    expect(errorResponse(err, id).body.error).toMatchObject({ code: "STALE_STATE", command_id: id, current_revision: now });
    expect(matchState(m).status).toBe("in_progress");
    expect(receiptCount(id)).toBe(0);
    await send(createPgAdmin(), ORG, "transition_match", { match_id: m, status: "postponed", precondition: { match_updated_at: now } });
    expect(matchState(m).status).toBe("postponed");
  }, 90_000);

  test("a precondition the server can't fully enforce is refused (400), never silently ignored", async () => {
    const id = randomUUID();
    const err = await send(createPgAdmin(), ORG, "create_court", { tournament_id: T, name: "P-court", precondition: { match_updated_at: new Date().toISOString() } }, id).catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: "INVALID_COMMAND" });
    expect(classifySendError(err)).toBe("rejected");
    expect(courtsNamed("P-court")).toBe(0);
  }, 60_000);
  test("game timer on real PostgreSQL: set before start, starts with start_match, an override racing a point keeps both, Hold banks time", async () => {
    const m = newMatch();
    const timerOf = () => JSON.parse(scalar(`select coalesce(timer, 'null'::jsonb) from public.matches where id = '${m}';`));
    await send(createPgAdmin(), ORG, "set_match_timer", { match_id: m, action: "set", duration_seconds: 600 });
    expect(timerOf()).toMatchObject({ v: 1, durationSec: 600, remainingMs: 600000, runningSince: null });
    // The assigned umpire may set up the game time before the start; it still
    // doesn't start counting.
    await send(createPgAdmin(), UMP, "set_match_timer", { match_id: m, action: "set", duration_seconds: 600 });
    expect(timerOf()).toMatchObject({ durationSec: 600, remainingMs: 600000, runningSince: null });
    await send(createPgAdmin(), UMP, "start_match", { match_id: m });
    const startedTimer = timerOf();
    expect(startedTimer.runningSince).toBeTruthy();
    // Once started, only the organizer may change it.
    const refused = await send(createPgAdmin(), UMP, "set_match_timer", { match_id: m, action: "adjust", delta_seconds: 60 }).catch((e) => e);
    expect(refused).toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(timerOf()).toEqual(startedTimer);
    // +1 min read the match, then a point commits before it writes: the
    // override is re-run (TC412) and both the point and the added time survive.
    let release;
    const pointCommitted = new Promise((r) => { release = r; });
    let reached;
    const atWrite = new Promise((r) => { reached = r; });
    const orgAdmin = createPgAdmin({ beforeRpc: async (_p, n) => { if (n === 1) { reached(); await pointCommitted; } } });
    const adjust = send(orgAdmin, ORG, "set_match_timer", { match_id: m, action: "adjust", delta_seconds: 60 });
    await atWrite;
    await send(createPgAdmin(), UMP, "score_event", point(m, 1));
    release();
    await adjust;
    expect(orgAdmin.rpcCalls).toBe(2);
    expect(matchState(m).lastSeq).toBe(1);
    expect(timerOf().remainingMs).toBeGreaterThan(600000);
    // the point write carried the timer through unchanged
    await send(createPgAdmin(), UMP, "score_event", point(m, 2));
    expect(timerOf().runningSince).toBeTruthy();
    await send(createPgAdmin(), UMP, "transition_match", { match_id: m, status: "postponed" });
    const held = timerOf();
    expect(held.runningSince).toBeNull();
    expect(held.remainingMs).toBeGreaterThan(0);
    expect(held.remainingMs).toBeLessThanOrEqual(660000);
  }, 120_000);
});
