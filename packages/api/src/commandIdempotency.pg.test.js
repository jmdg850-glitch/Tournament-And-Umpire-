// Real-PostgreSQL proof of migration 0018 (atomic command claim + match
// version checks). Runs only when LOCAL_PG_BIN points at a PostgreSQL bin
// directory (initdb/pg_ctl/psql). It creates a throwaway cluster in the OS
// temp dir on its own port — never a shared or remote database — loads the
// real migrations, first PROVES the duplicate-command race on the pre-0018
// function, then applies 0018 on top of that existing data and proves each
// guarantee with genuinely overlapping transactions.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PG_BIN = process.env.LOCAL_PG_BIN;
const PORT = String(process.env.LOCAL_PG_IDEMPOTENCY_PORT || 55441);
const exe = (name) => join(PG_BIN || "", process.platform === "win32" ? `${name}.exe` : name);
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

let dir;
const args = () => ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"];
function sqlFile(sql) {
  const file = join(dir, `q-${randomUUID()}.sql`);
  // VERBOSITY verbose makes psql print the SQLSTATE ("ERROR:  TC001: …").
  writeFileSync(file, `\\set VERBOSITY verbose\n${sql}`);
  return file;
}
function psql(sql, { allowError = false } = {}) {
  try {
    return execFileSync(exe("psql"), [...args(), "-f", sqlFile(sql)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowError) return { error: String(err.stderr || err.message) };
    throw new Error(String(err.stderr || err.message));
  }
}
function psqlAsync(sql) {
  return new Promise((done) => {
    const p = spawn(exe("psql"), [...args(), "-f", sqlFile(sql)]);
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => done({ code, stderr }));
  });
}
const scalar = (sql) => String(psql(sql)).trim();
const q = (payload) => `$payload$${JSON.stringify(payload)}$payload$::jsonb`;
// Two transactions that each write, then hold before committing, so they
// genuinely overlap inside the database.
const overlapping = (payload) => `begin; select public.apply_official_writes(${q(payload)}); select pg_sleep(1); commit;`;

const OWNER = randomUUID(), T = randomUUID(), D = randomUUID(), M = randomUUID();

function receipt(id) {
  return { id, actor_id: OWNER, command_type: "create_court", result: { ok: true }, created_at: new Date().toISOString() };
}
// Same shape commit() sends: domain rows + receipt + an audit row with a fresh id.
function courtBatch(commandId, name) {
  return {
    upserts: {
      courts: [{ id: randomUUID(), tournament_id: T, name }],
      command_receipts: [receipt(commandId)],
      audit_logs: [{ id: randomUUID(), actor_id: OWNER, command_id: commandId, command_type: "create_court", detail: { ok: true } }],
    },
  };
}
const courts = (name) => scalar(`select count(*) from public.courts where name = '${name}';`);
const audits = (commandId) => scalar(`select count(*) from public.audit_logs where command_id = '${commandId}';`);
const matchVersion = () => scalar(`select to_json(updated_at)#>>'{}' from public.matches where id = '${M}';`);

describe.skipIf(!PG_BIN)("atomic command idempotency — migration 0018 (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "idem-pg-"));
    const data = join(dir, "data");
    execFileSync(exe("initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(exe("pg_ctl"), ["-D", data, "-l", join(dir, "pg.log"), "-w", "-o", `-p ${PORT} -c listen_addresses=127.0.0.1`, "start"], { stdio: "ignore" });
    // Minimal stand-ins for the Supabase-provided pieces the migrations reference.
    psql(`create role service_role; create role anon; create role authenticated;
          create schema auth; create table auth.users (id uuid primary key);
          create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
          create extension if not exists pgcrypto;
          create schema private;
          create function private.is_tournament_member(uuid) returns boolean language sql as $$ select true $$;`);
    for (const f of ["0001_initial_schema.sql", "0005_touch_updated_at_search_path.sql", "0006_court_stations.sql",
      "0007_official_writes_present_columns.sql", "0011_score_correction_event.sql", "0017_one_team_knockout_stage_per_division.sql"]) {
      psql(readFileSync(join(migrations, f), "utf8"));
    }
    psql(`insert into auth.users values ('${OWNER}');
          insert into public.profiles (id, display_name) values ('${OWNER}', 'Owner');
          insert into public.tournaments (id, name, owner_id) values ('${T}', 'T', '${OWNER}');
          insert into public.divisions (id, tournament_id, name, format) values ('${D}', '${T}', 'Open', 'single_elim');
          insert into public.matches (id, tournament_id, division_id, status, score_state)
            values ('${M}', '${T}', '${D}', 'in_progress', '{"lastSeq": 0}');
          create trigger matches_touch before update on public.matches
            for each row execute function private.touch_updated_at();`);
  }, 180_000);

  afterAll(() => {
    if (!dir) return;
    try { execFileSync(exe("pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("BEFORE 0018: two overlapping executions of ONE command_id both commit (the race is real)", async () => {
    const id = randomUUID();
    const [r1, r2] = await Promise.all([psqlAsync(overlapping(courtBatch(id, "race-before"))), psqlAsync(overlapping(courtBatch(id, "race-before")))]);
    expect([r1.code, r2.code]).toEqual([0, 0]);
    expect(courts("race-before")).toBe("2"); // two domain effects
    expect(audits(id)).toBe("2"); // …and two audit rows
    expect(scalar(`select count(*) from public.command_receipts where id = '${id}';`)).toBe("1"); // receipt silently overwritten
  }, 60_000);

  test("0018 applies on top of existing data: existing receipts kept, new column nullable, grants unchanged", () => {
    const before = scalar("select count(*) from public.command_receipts;");
    // PK already guarantees receipt ids are unique — there can be no duplicates to clean up.
    expect(scalar("select count(*) - count(distinct id) from public.command_receipts;")).toBe("0");
    psql(readFileSync(join(migrations, "0018_atomic_command_idempotency.sql"), "utf8"));
    expect(scalar("select count(*) from public.command_receipts;")).toBe(before);
    expect(scalar("select count(*) from public.command_receipts where request_hash is not null;")).toBe("0");
    expect(scalar(`select is_nullable from information_schema.columns where table_name = 'command_receipts' and column_name = 'request_hash';`)).toBe("YES");
    expect(scalar(`select has_function_privilege('service_role', 'public.apply_official_writes(jsonb)', 'execute');`)).toBe("t");
    expect(scalar(`select has_function_privilege('anon', 'public.apply_official_writes(jsonb)', 'execute');`)).toBe("f");
    expect(scalar(`select has_function_privilege('authenticated', 'public.apply_official_writes(jsonb)', 'execute');`)).toBe("f");
    // re-running the migration is harmless
    psql(readFileSync(join(migrations, "0018_atomic_command_idempotency.sql"), "utf8"));
  });

  test("concurrent duplicate: exactly one execution commits; the other fails with TC001 and keeps nothing", async () => {
    const id = randomUUID();
    const [r1, r2] = await Promise.all([psqlAsync(overlapping(courtBatch(id, "race-after"))), psqlAsync(overlapping(courtBatch(id, "race-after")))]);
    expect([r1.code === 0, r2.code === 0].sort()).toEqual([false, true]);
    expect([r1, r2].find((r) => r.code !== 0).stderr).toContain("TC001");
    expect(courts("race-after")).toBe("1");
    expect(audits(id)).toBe("1"); // the losing transaction left no receipt claim, domain row or audit row
  }, 60_000);

  test("sequential duplicate (retry after a lost response): TC001, no second effect, stored receipt untouched", () => {
    const id = randomUUID();
    psql(`select public.apply_official_writes(${q(courtBatch(id, "seq-dup"))});`);
    const stored = scalar(`select created_at from public.command_receipts where id = '${id}';`);
    const again = psql(`select public.apply_official_writes(${q(courtBatch(id, "seq-dup"))});`, { allowError: true });
    expect(again.error).toContain("TC001");
    expect(courts("seq-dup")).toBe("1");
    expect(audits(id)).toBe("1");
    expect(scalar(`select created_at from public.command_receipts where id = '${id}';`)).toBe(stored);
  });

  test("receipt and domain writes are one transaction: a failed batch keeps neither, and the command can run again", () => {
    const id = randomUUID();
    const bad = courtBatch(id, "atomic");
    bad.upserts.score_events = [{ id: randomUUID(), match_id: randomUUID(), seq: 1, type: "point", payload: {}, actor_id: OWNER }]; // FK violation
    expect(psql(`select public.apply_official_writes(${q(bad)});`, { allowError: true }).error).toContain("23503");
    expect(courts("atomic")).toBe("0");
    expect(audits(id)).toBe("0"); // the failed attempt left no audit row either
    expect(scalar(`select count(*) from public.command_receipts where id = '${id}';`)).toBe("0");
    psql(`select public.apply_official_writes(${q(courtBatch(id, "atomic"))});`);
    expect(courts("atomic")).toBe("1");
    expect(audits(id)).toBe("1");
  });

  test("a domain write can't commit without its receipt either (receipt failure rolls back the domain rows)", () => {
    const batch = courtBatch(randomUUID(), "no-receipt");
    batch.upserts.command_receipts[0].actor_id = randomUUID(); // unknown profile → FK violation on the receipt
    expect(psql(`select public.apply_official_writes(${q(batch)});`, { allowError: true }).error).toContain("23503");
    expect(courts("no-receipt")).toBe("0");
  });

  test("two devices, same (match_id, seq), different events, overlapping: one commits, the other gets 23505 on score_events_match_id_seq_key", async () => {
    const ev = () => ({ upserts: { score_events: [{ id: randomUUID(), match_id: M, seq: 7, type: "point", payload: {}, actor_id: OWNER }], command_receipts: [receipt(randomUUID())] } });
    const [r1, r2] = await Promise.all([psqlAsync(overlapping(ev())), psqlAsync(overlapping(ev()))]);
    expect([r1.code === 0, r2.code === 0].sort()).toEqual([false, true]);
    const failed = [r1, r2].find((r) => r.code !== 0).stderr;
    expect(failed).toContain("23505");
    expect(failed).toContain("score_events_match_id_seq_key"); // the name writes.js maps to SEQ_CONFLICT
    expect(scalar(`select count(*) from public.score_events where match_id = '${M}' and seq = 7;`)).toBe("1");
  }, 60_000);

  test("version check (expect): two overlapping read-modify-writes of the same match — one commits, the other TC412, nothing lost", async () => {
    const seen = matchVersion();
    const ids = [randomUUID(), randomUUID()];
    const write = (status, id) => ({
      upserts: { matches: [{ id: M, tournament_id: T, division_id: D, status }], command_receipts: [receipt(id)] },
      expect: [{ table: "matches", id: M, updated_at: seen }],
    });
    const [r1, r2] = await Promise.all([psqlAsync(overlapping(write("postponed", ids[0]))), psqlAsync(overlapping(write("in_progress", ids[1])))]);
    expect([r1.code === 0, r2.code === 0].sort()).toEqual([false, true]);
    expect([r1, r2].find((r) => r.code !== 0).stderr).toContain("TC412");
    // the loser's receipt claim was rolled back with it, so its re-run can still claim
    const loserId = r1.code === 0 ? ids[1] : ids[0];
    expect(scalar(`select count(*) from public.command_receipts where id = '${loserId}';`)).toBe("0");
    expect(matchVersion()).not.toBe(seen);
    const winner = r1.code === 0 ? "postponed" : "in_progress";
    expect(scalar(`select status from public.matches where id = '${M}';`)).toBe(winner);
  }, 60_000);

  test("client precondition: stale → TC409 with the current version in DETAIL, nothing written; current → applies", () => {
    const current = matchVersion();
    const stale = {
      upserts: { matches: [{ id: M, tournament_id: T, division_id: D, status: "abandoned" }], command_receipts: [receipt(randomUUID())] },
      precondition: [{ table: "matches", id: M, updated_at: "2000-01-01T00:00:00Z" }],
    };
    const out = psql(`select public.apply_official_writes(${q(stale)});`, { allowError: true });
    expect(out.error).toContain("TC409");
    // DETAIL is the current version in the same JSON format the API reads it in
    expect(/DETAIL:\s+(\S+)/.exec(out.error)?.[1]).toBe(current);
    expect(scalar(`select status from public.matches where id = '${M}';`)).not.toBe("abandoned");
    const ok = { ...stale, precondition: [{ table: "matches", id: M, updated_at: current }] };
    psql(`select public.apply_official_writes(${q(ok)});`);
    expect(scalar(`select status from public.matches where id = '${M}';`)).toBe("abandoned");
  });

  test("two batches checking the same two matches in OPPOSITE order never deadlock (rows are locked in id order)", async () => {
    const M2 = randomUUID();
    psql(`insert into public.matches (id, tournament_id, division_id, status, score_state) values ('${M2}', '${T}', '${D}', 'scheduled', '{}');`);
    const v1 = matchVersion();
    const v2 = scalar(`select to_json(updated_at)#>>'{}' from public.matches where id = '${M2}';`);
    const rows = [{ id: M, tournament_id: T, division_id: D, status: "abandoned" }, { id: M2, tournament_id: T, division_id: D, status: "scheduled" }];
    const e1 = { table: "matches", id: M, updated_at: v1 };
    const e2 = { table: "matches", id: M2, updated_at: v2 };
    const batch = (checks, upsertRows) => ({ upserts: { matches: upsertRows, command_receipts: [receipt(randomUUID())] }, expect: checks });
    const [r1, r2] = await Promise.all([
      psqlAsync(overlapping(batch([e1, e2], rows))),
      psqlAsync(overlapping(batch([e2, e1], [...rows].reverse()))),
    ]);
    const errs = [r1, r2].filter((r) => r.code !== 0).map((r) => r.stderr).join(" | ");
    expect(errs).not.toContain("40P01"); // no deadlock
    expect([r1.code === 0, r2.code === 0].sort()).toEqual([false, true]);
    expect(errs).toContain("TC412"); // the second saw the first's committed versions
  }, 60_000);

  test("version checks only accept matches; batches without receipts/checks behave exactly as before", () => {
    const bad = { upserts: {}, expect: [{ table: "courts", id: randomUUID(), updated_at: "2000-01-01T00:00:00Z" }] };
    expect(psql(`select public.apply_official_writes(${q(bad)});`, { allowError: true }).error).toContain("22023");
    // no receipt, no checks, repeated upsert of the same id: still an idempotent upsert
    const row = { upserts: { courts: [{ id: randomUUID(), tournament_id: T, name: "plain" }] } };
    psql(`select public.apply_official_writes(${q(row)});`);
    psql(`select public.apply_official_writes(${q(row)});`);
    expect(courts("plain")).toBe("1");
  });

  test("request_hash is stored when the API sends it", () => {
    const id = randomUUID();
    const batch = courtBatch(id, "hashed");
    batch.upserts.command_receipts[0].request_hash = "a".repeat(64);
    psql(`select public.apply_official_writes(${q(batch)});`);
    expect(scalar(`select request_hash from public.command_receipts where id = '${id}';`)).toBe("a".repeat(64));
  });
});
