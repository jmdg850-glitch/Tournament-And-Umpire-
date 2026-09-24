// Real-PostgreSQL proof that two simultaneous Generate Playoffs writes cannot
// both land. Runs only when LOCAL_PG_BIN points at a PostgreSQL bin directory
// (initdb/pg_ctl/psql). It creates a throwaway cluster in the OS temp dir on
// its own port — never a shared or remote database — loads the real
// migrations that matter (tables, apply_official_writes, the 0017 index), and
// fires two apply_official_writes calls whose transactions overlap.
import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PG_BIN = process.env.LOCAL_PG_BIN;
const PORT = String(process.env.LOCAL_PG_PORT || 55439);
const exe = (name) => join(PG_BIN || "", process.platform === "win32" ? `${name}.exe` : name);
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations");

let dir;
function psql(sql, { allowError = false } = {}) {
  const file = join(dir, `q-${randomUUID()}.sql`);
  writeFileSync(file, sql);
  try {
    return execFileSync(exe("psql"), ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-f", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowError) return { error: String(err.stderr || err.message) };
    throw new Error(String(err.stderr || err.message));
  }
}
function psqlAsync(sql) {
  const file = join(dir, `q-${randomUUID()}.sql`);
  writeFileSync(file, sql);
  return new Promise((done) => {
    const p = spawn(exe("psql"), ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A", "-f", file]);
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => done({ code, stderr }));
  });
}

const T = randomUUID(), D = randomUUID(), OWNER = randomUUID();
// One Generate Playoffs write: a team_knockout stage plus its semifinal,
// final and bronze shells — the same shape handleGenerateTeamPlayoffs sends.
function playoffPayload() {
  const stageId = randomUUID();
  const match = (label, pos) => ({
    id: randomUUID(), tournament_id: T, division_id: D, stage_id: stageId, parent_match_id: null,
    round: 2, bracket_position: pos, bracket_side: label, stage_label: label, status: "scheduled",
    score_state: {}, team_a_wins: 0, team_b_wins: 0,
  });
  const matches = [match("semifinal", 0), match("semifinal", 1), match("final", 0), match("bronze", 1)];
  return {
    upserts: {
      stages: [{ id: stageId, division_id: D, kind: "team_knockout", name: "Team playoffs", config: {} }],
      matches,
      match_participants: matches.flatMap((m) => ["A", "B"].map((slot) => ({ id: randomUUID(), match_id: m.id, slot }))),
    },
  };
}
const q = (payload) => `$payload$${JSON.stringify(payload)}$payload$::jsonb`;

describe.skipIf(!PG_BIN)("one team_knockout stage per division (real PostgreSQL)", () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "te-pg-"));
    const data = join(dir, "data");
    execFileSync(exe("initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(exe("pg_ctl"), ["-D", data, "-l", join(dir, "pg.log"), "-w", "-o", `-p ${PORT} -c listen_addresses=127.0.0.1`, "start"], { stdio: "ignore" });
    // Minimal stand-ins for the Supabase-provided pieces the migrations reference.
    psql(`create role service_role; create role anon; create role authenticated;
          create schema auth; create table auth.users (id uuid primary key);
          create function auth.role() returns text language sql as $$ select 'service_role'::text $$;`);
    for (const f of ["0001_initial_schema.sql", "0005_touch_updated_at_search_path.sql",
      "0007_official_writes_present_columns.sql", "0017_one_team_knockout_stage_per_division.sql"]) {
      psql(readFileSync(join(migrations, f), "utf8"));
    }
    psql(`insert into auth.users values ('${OWNER}');
          insert into public.profiles (id, display_name) values ('${OWNER}', 'Owner');
          insert into public.tournaments (id, name, owner_id) values ('${T}', 'T', '${OWNER}');
          insert into public.divisions (id, tournament_id, name, format) values ('${D}', '${T}', 'BEG LOW', 'team_elimination');
          insert into public.stages (division_id, kind) values ('${D}', 'team_round_robin');`);
  }, 120_000);

  afterAll(() => {
    if (!dir) return;
    try { execFileSync(exe("pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("two overlapping Generate Playoffs writes: exactly one knockout stage and one set of playoff matches", async () => {
    // Both transactions write, then hold for a moment before committing, so
    // they genuinely overlap: the second blocks on the index until the first
    // commits, then fails — and its whole batch rolls back.
    const txn = (payload) => `begin; select public.apply_official_writes(${q(payload)}); select pg_sleep(1); commit;`;
    const [r1, r2] = await Promise.all([psqlAsync(txn(playoffPayload())), psqlAsync(txn(playoffPayload()))]);
    const outcomes = [r1, r2].map((r) => r.code === 0 ? "ok" : "rejected");
    expect(outcomes.sort()).toEqual(["ok", "rejected"]);
    const rejected = [r1, r2].find((r) => r.code !== 0);
    expect(rejected.stderr).toContain("stages_one_team_knockout_per_division_uidx");

    const counts = psql(`select
      (select count(*) from public.stages where division_id = '${D}' and kind = 'team_knockout'),
      (select count(*) from public.matches where division_id = '${D}' and stage_label = 'semifinal'),
      (select count(*) from public.matches where division_id = '${D}' and stage_label = 'final'),
      (select count(*) from public.matches where division_id = '${D}' and stage_label = 'bronze'),
      (select count(*) from public.match_participants mp join public.matches m on m.id = mp.match_id where m.division_id = '${D}');`).trim();
    expect(counts).toBe("1|2|1|1|8");
  }, 60_000);

  test("a later sequential attempt is rejected too, and other stage kinds are unaffected", () => {
    const again = psql(`select public.apply_official_writes(${q(playoffPayload())});`, { allowError: true });
    expect(again.error).toContain("stages_one_team_knockout_per_division_uidx");
    psql(`insert into public.stages (division_id, kind) values ('${D}', 'team_round_robin'), ('${D}', 'bracket'), ('${D}', 'bracket');`);
    expect(psql(`select count(*) from public.stages where division_id = '${D}' and kind = 'team_knockout';`).trim()).toBe("1");
  });
});
