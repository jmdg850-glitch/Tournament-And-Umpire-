// Multi-device licensing on REAL PostgreSQL: migration 0020 applied on top of
// the real 0015 -> 0016 history (with a 0016-style single-PC license already in
// place, to prove the backfill), then public.license_register_device exercised
// directly — including two and five database sessions racing for the last slot.
//
// Runs only when LOCAL_PG_BIN points at a PostgreSQL bin directory; it creates
// a throwaway cluster in the OS temp dir on its own port and deletes it after.
//   LOCAL_PG_BIN="C:\Program Files\PostgreSQL\17\bin" node --test supabase/functions/license/licenseDevices.pg.test.js
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const PG_BIN = process.env.LOCAL_PG_BIN;
const PORT = String(process.env.LOCAL_PG_LICENSE_PORT || 55447);
const exe = (name) => join(PG_BIN || "", process.platform === "win32" ? `${name}.exe` : name);
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const env = { ...process.env, PGTZ: "UTC" };

let dir;
const baseArgs = () => ["-h", "127.0.0.1", "-p", PORT, "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-t", "-A"];
function sqlFile(sql) {
  const file = join(dir, `q-${randomUUID()}.sql`);
  writeFileSync(file, sql);
  return file;
}
function psql(sql, { allowError = false } = {}) {
  try {
    return execFileSync(exe("psql"), [...baseArgs(), "-f", sqlFile(sql)], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (allowError) return { error: String(err.stderr || err.message) };
    throw new Error(`psql failed: ${err.stderr || err.message}`);
  }
}
function psqlAsync(sql) {
  return new Promise((done) => {
    const p = spawn(exe("psql"), [...baseArgs(), "-f", sqlFile(sql)], { env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; });
    p.on("close", (code) => done({ code, stdout, stderr }));
  });
}
const lines = (out) => String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const one = (out) => lines(out)[0];

const OWNER = randomUUID();
const OLD = randomUUID(); // a 0016-era license bound to one PC before 0020
const L = randomUUID(); // multi-device test license
let codeN = 0;
const code = () => `ABCD-EFGH-${"23456789ABCDEFGHJKMNPQRSTVWXYZ".charAt(codeN++ % 30)}${"23456789".charAt(Math.floor(codeN / 30) % 8)}JK`;

// Register as the service role (the only caller the Edge Function uses).
const reg = (license, device, { firstOnly = false, user = null } = {}) =>
  `set role service_role; select public.license_register_device('${license}', '${device}', 'label-${device}', ${user ? `'${user}'` : "null"}, ${firstOnly});`;
const register = (license, device, opts) => JSON.parse(one(psql(reg(license, device, opts))));
const activeCount = (license) => Number(one(psql(`select count(*) from public.license_devices where license_id = '${license}' and released_at is null;`)));
const newLicense = (max, extra = "") => {
  const id = randomUUID();
  psql(`insert into public.licenses (id, email, access_code, max_devices${extra ? ", " + extra.split("=")[0] : ""})
        values ('${id}', 'c-${id}@example.com', '${code()}', ${max}${extra ? ", " + extra.split("=").slice(1).join("=") : ""});`);
  return id;
};

describe("multi-device licensing on real PostgreSQL (0015 -> 0016 -> 0020 -> 0021)", { skip: !PG_BIN && "set LOCAL_PG_BIN to run" }, () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "lic-pg-"));
    const data = join(dir, "data");
    execFileSync(exe("initdb"), ["-D", data, "-U", "postgres", "-A", "trust", "-E", "UTF8"], { stdio: "ignore" });
    execFileSync(exe("pg_ctl"), ["-D", data, "-l", join(dir, "pg.log"), "-w", "-o", `-p ${PORT} -c listen_addresses=127.0.0.1 -c timezone=UTC`, "start"], { stdio: "ignore" });
    // Stand-ins for what Supabase provides: roles (service_role bypasses RLS,
    // as on Supabase), the auth schema, and the private schema.
    psql(`create role service_role bypassrls; create role anon; create role authenticated;
          create schema auth; create table auth.users (id uuid primary key);
          create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
          create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
          create schema private; create extension if not exists pgcrypto;`);
    for (const f of ["0015_licensing.sql", "0016_simple_licensing.sql"]) psql(readFileSync(join(migrations, f), "utf8"));
    // Supabase grants the API roles broad default privileges; mirror that so the
    // test proves the migrations' own REVOKEs are what keeps clients out.
    psql(`grant usage on schema public to anon, authenticated, service_role;
          grant all on all tables in schema public to anon, authenticated, service_role;
          revoke all on public.licenses, public.license_admins from anon, authenticated;
          insert into auth.users values ('${OWNER}');
          insert into public.licenses (id, email, access_code, status, device_id, device_label, activated_at, activated_user_id)
            values ('${OLD}', 'old@example.com', 'ZZZZ-ZZZZ-ZZZZ', 'active', 'win-oldpc-1234567890', 'OLD-PC', now() - interval '3 days', '${OWNER}');
          insert into public.licenses (email, access_code, status, revoked_at) values ('gone@example.com', 'YYYY-YYYY-YYYY', 'revoked', now());`);
    psql(readFileSync(join(migrations, "0020_multi_device_licensing.sql"), "utf8"));
    psql(`grant all on public.license_devices to service_role;
          insert into public.licenses (id, email, access_code, max_devices) values ('${L}', 'multi@example.com', 'MMMM-MMMM-MMMM', 3);
          insert into public.licenses (email, access_code, expires_at) values ('dated@example.com', 'DDDD-DDDD-DDDD', '2031-05-06T07:08:09Z');`);
    // 0021 (plans) on top of the populated 0020 schema, as in production.
    psql(readFileSync(join(migrations, "0021_license_plans.sql"), "utf8"));
  });

  after(() => {
    if (!dir) return;
    try { execFileSync(exe("pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  });

  test("backfill: existing licenses get max_devices = 1 and the bound PC becomes the one registered device", () => {
    assert.deepEqual(lines(psql(`select email || '|' || max_devices from public.licenses where email in ('old@example.com', 'gone@example.com') order by email;`)),
      ["gone@example.com|1", "old@example.com|1"]);
    assert.equal(one(psql(`select device_id || '|' || device_label || '|' || (user_id = '${OWNER}') || '|' || (released_at is null)
      from public.license_devices where license_id = '${OLD}';`)), "win-oldpc-1234567890|OLD-PC|true|true");
    assert.equal(one(psql(`select count(*) from public.license_devices d join public.licenses l on l.id = d.license_id where l.status = 'revoked';`)), "0");
    // The migrated single-PC license behaves exactly as before: same PC ok, second PC blocked.
    assert.equal(register(OLD, "win-oldpc-1234567890").outcome, "already_here");
    assert.equal(register(OLD, "win-newpc-1234567890").code, "DEVICE_LIMIT");
  });

  test("1-5: registration up to max_devices; same device takes no new slot; over max -> DEVICE_LIMIT", () => {
    assert.deepEqual(register(L, "pc-a-00000001", { user: OWNER }), { ok: true, outcome: "registered", active_devices: 1, max_devices: 3 });
    assert.equal(one(psql(`select status || '|' || (activated_user_id = '${OWNER}') || '|' || (activated_at is not null) from public.licenses where id = '${L}';`)), "active|true|true");
    assert.equal(register(L, "pc-b-00000002").outcome, "registered");
    assert.equal(register(L, "pc-a-00000001").outcome, "already_here");
    assert.equal(register(L, "pc-c-00000003").active_devices, 3);
    const full = register(L, "pc-d-00000004");
    assert.deepEqual(full, { ok: false, code: "DEVICE_LIMIT", active_devices: 3, max_devices: 3 });
    assert.equal(activeCount(L), 3);
  });

  test("6-8: release frees exactly one slot; the released PC can come back only when a slot is free", () => {
    psql(`update public.license_devices set released_at = now() where license_id = '${L}' and device_id = 'pc-b-00000002';`);
    assert.equal(activeCount(L), 2);
    assert.equal(register(L, "pc-d-00000004").outcome, "registered");
    assert.equal(register(L, "pc-b-00000002").code, "DEVICE_LIMIT");
    assert.equal(one(psql(`select count(*) from public.license_devices where license_id = '${L}' and device_id = 'pc-b-00000002';`)), "1", "released row kept");
  });

  test("a device can hold only one live slot per license (unique index)", () => {
    const dup = psql(`insert into public.license_devices (license_id, device_id) values ('${L}', 'pc-a-00000001');`, { allowError: true });
    assert.match(dup.error, /license_devices_one_active/);
  });

  test("10-13: raise and lower max_devices; lowering deletes nothing and blocks only NEW devices", () => {
    psql(`update public.licenses set max_devices = 5 where id = '${L}';`);
    assert.equal(register(L, "pc-e-00000005").outcome, "registered");
    assert.equal(register(L, "pc-f-00000006").outcome, "registered");
    assert.equal(register(L, "pc-g-00000007").code, "DEVICE_LIMIT");
    psql(`update public.licenses set max_devices = 3 where id = '${L}';`);
    assert.equal(activeCount(L), 5, "nothing released or deleted");
    assert.equal(register(L, "pc-a-00000001").outcome, "already_here", "existing device keeps working");
    assert.equal(register(L, "pc-g-00000007").code, "DEVICE_LIMIT");
    psql(`update public.license_devices set released_at = now() where license_id = '${L}' and device_id in ('pc-e-00000005', 'pc-f-00000006');`);
    assert.equal(register(L, "pc-g-00000007").code, "DEVICE_LIMIT", "3 of 3: still full");
    psql(`update public.license_devices set released_at = now() where license_id = '${L}' and device_id = 'pc-d-00000004';`);
    assert.equal(register(L, "pc-g-00000007").outcome, "registered");
    assert.equal(activeCount(L), 3);
    const bad = psql(`update public.licenses set max_devices = 0 where id = '${L}';`, { allowError: true });
    assert.match(bad.error, /licenses_max_devices_range/);
    assert.match(psql(`update public.licenses set max_devices = 101 where id = '${L}';`, { allowError: true }).error, /licenses_max_devices_range/);
  });

  test("9, 15: revoked and expired licenses register nothing; unknown license -> NOT_FOUND", () => {
    const rev = newLicense(3);
    psql(`update public.licenses set status = 'revoked', revoked_at = now() where id = '${rev}';`);
    assert.equal(register(rev, "pc-x-00000001").code, "REVOKED");
    const exp = newLicense(3, "expires_at=now() - interval '1 minute'");
    assert.equal(register(exp, "pc-x-00000001").code, "EXPIRED");
    assert.equal(register(randomUUID(), "pc-x-00000001").code, "NOT_FOUND");
    assert.equal(activeCount(rev) + activeCount(exp), 0);
  });

  test("17b: first_only registers the first device but never a second", () => {
    const id = newLicense(5);
    assert.equal(register(id, "pc-1-00000001", { firstOnly: true }).outcome, "registered");
    assert.equal(register(id, "pc-1-00000001", { firstOnly: true }).outcome, "already_here");
    assert.equal(register(id, "pc-2-00000002", { firstOnly: true }).code, "ALREADY_ACTIVATED");
    assert.equal(activeCount(id), 1);
  });

  test("18: two sessions racing for the LAST slot -> exactly one registered, one DEVICE_LIMIT", async () => {
    const id = newLicense(2);
    assert.equal(register(id, "pc-1-00000001").outcome, "registered");
    // Each session registers inside a transaction and holds it open, so the
    // two calls genuinely overlap: the second blocks on the license row lock
    // until the first commits, then counts the committed row.
    const txn = (device) => `set role service_role; begin; select public.license_register_device('${id}', '${device}', null, null, false); select pg_sleep(1); commit;`;
    const [r1, r2] = await Promise.all([psqlAsync(txn("pc-2-00000002")), psqlAsync(txn("pc-3-00000003"))]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r2.code, 0, r2.stderr);
    const outcomes = [r1, r2].map((r) => JSON.parse(one(r.stdout))).map((o) => o.outcome || o.code).sort();
    assert.deepEqual(outcomes, ["DEVICE_LIMIT", "registered"]);
    assert.equal(activeCount(id), 2, "never two successful registrations for one slot");
  });

  test("18b: five sessions racing for one remaining slot -> exactly one wins", async () => {
    const id = newLicense(3);
    register(id, "pc-1-00000001");
    register(id, "pc-2-00000002");
    const txn = (device) => `set role service_role; begin; select public.license_register_device('${id}', '${device}', null, null, false); select pg_sleep(0.5); commit;`;
    const results = await Promise.all([3, 4, 5, 6, 7].map((n) => psqlAsync(txn(`pc-${n}-0000000${n}`))));
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const outcomes = results.map((r) => JSON.parse(one(r.stdout))).map((o) => o.outcome || o.code);
    assert.equal(outcomes.filter((o) => o === "registered").length, 1);
    assert.equal(outcomes.filter((o) => o === "DEVICE_LIMIT").length, 4);
    assert.equal(activeCount(id), 3);
  });

  test("the same device racing itself takes one slot", async () => {
    const id = newLicense(5);
    const txn = `set role service_role; begin; select public.license_register_device('${id}', 'pc-same-0001', null, null, false); select pg_sleep(0.5); commit;`;
    const results = await Promise.all([psqlAsync(txn), psqlAsync(txn)]);
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(results.map((r) => JSON.parse(one(r.stdout)).outcome).sort(), ["already_here", "registered"]);
    assert.equal(activeCount(id), 1);
  });

  test("0021: every existing license becomes 'legacy' with its expiry, status and devices untouched", () => {
    assert.deepEqual(lines(psql(`select distinct plan from public.licenses;`)), ["legacy"]);
    assert.equal(one(psql(`select coalesce(to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), 'none') from public.licenses where email = 'dated@example.com';`)),
      "2031-05-06T07:08:09");
    assert.equal(one(psql(`select count(*) from public.licenses where email in ('old@example.com', 'multi@example.com') and expires_at is null;`)), "2");
    assert.equal(one(psql(`select status from public.licenses where email = 'gone@example.com';`)), "revoked");
    assert.equal(register(OLD, "win-oldpc-1234567890").outcome, "already_here", "registration is unchanged by 0021");
  });

  test("0021: plan values are constrained, and a plan license must have an expiry", () => {
    const ok = randomUUID();
    psql(`insert into public.licenses (id, email, access_code, plan, expires_at) values ('${ok}', 'p-${ok}@example.com', '${code()}', 'trial_30', now() + interval '30 days');`);
    assert.equal(one(psql(`select plan from public.licenses where id = '${ok}';`)), "trial_30");
    assert.match(psql(`insert into public.licenses (email, access_code, plan, expires_at) values ('bad1@example.com', '${code()}', 'weekly', now());`, { allowError: true }).error,
      /licenses_plan_valid/);
    assert.match(psql(`insert into public.licenses (email, access_code, plan) values ('bad2@example.com', '${code()}', 'monthly');`, { allowError: true }).error,
      /licenses_plan_has_expiry/);
    assert.match(psql(`update public.licenses set expires_at = null where id = '${ok}';`, { allowError: true }).error, /licenses_plan_has_expiry/);
  });

  test("13: deleting a license deletes its device rows (ON DELETE CASCADE) and nothing else", () => {
    const gone = newLicense(3);
    const kept = newLicense(2);
    for (const d of ["pc-del-0001", "pc-del-0002"]) register(gone, d);
    psql(`update public.license_devices set released_at = now() where license_id = '${gone}' and device_id = 'pc-del-0002';`);
    register(kept, "pc-keep-0001");
    assert.equal(one(psql(`set role service_role; delete from public.licenses where id = '${gone}' returning id;`)), gone);
    assert.equal(one(psql(`select count(*) from public.license_devices where license_id = '${gone}';`)), "0", "no orphaned device rows (active or released)");
    assert.equal(one(psql(`select count(*) from public.license_devices d left join public.licenses l on l.id = d.license_id where l.id is null;`)), "0");
    assert.equal(activeCount(kept), 1, "another license's devices are untouched");
  });

  test("change_plan: two sessions converting the same legacy license at once -> exactly one applies, devices untouched", async () => {
    const id = newLicense(2);
    register(id, "pc-plan-0001");
    // The same conditional UPDATE the license function sends for change_plan.
    const change = (plan, period) => `set role service_role; begin;
      update public.licenses set plan = '${plan}', expires_at = now() + interval '${period}'
        where id = '${id}' and plan = 'legacy' and status <> 'revoked' and expires_at is null returning plan;
      select pg_sleep(0.5); commit;`;
    const results = await Promise.all([psqlAsync(change("monthly", "1 month")), psqlAsync(change("yearly", "1 year"))]);
    for (const r of results) assert.equal(r.code, 0, r.stderr);
    const winners = results.map((r) => lines(r.stdout).filter((l) => l === "monthly" || l === "yearly")).flat();
    assert.equal(winners.length, 1, `exactly one change applied: ${JSON.stringify(winners)}`);
    const row = one(psql(`select plan || '|' || (expires_at > now()) || '|' || max_devices from public.licenses where id = '${id}';`));
    assert.equal(row, `${winners[0]}|true|2`, "one consistent plan + expiry, limit unchanged");
    assert.equal(activeCount(id), 1, "device registration unchanged");
  });

  test("clients (anon/authenticated) cannot execute the function or touch the tables", () => {
    for (const role of ["anon", "authenticated"]) {
      assert.match(psql(`set role ${role}; select public.license_register_device('${L}', 'pc-evil-0001', null, null, false);`, { allowError: true }).error,
        /permission denied for function license_register_device/, role);
      assert.match(psql(`set role ${role}; select count(*) from public.license_devices;`, { allowError: true }).error, /permission denied/, role);
      assert.match(psql(`set role ${role}; update public.licenses set max_devices = 100;`, { allowError: true }).error, /permission denied/, role);
      assert.match(psql(`set role ${role}; update public.licenses set plan = 'yearly', expires_at = now() + interval '99 years';`, { allowError: true }).error, /permission denied/, role);
      assert.match(psql(`set role ${role}; delete from public.licenses;`, { allowError: true }).error, /permission denied/, role);
      assert.match(psql(`set role ${role}; delete from public.license_devices;`, { allowError: true }).error, /permission denied/, role);
      assert.match(psql(`set role ${role}; insert into public.license_devices (license_id, device_id) values ('${L}', 'pc-evil-0002');`, { allowError: true }).error,
        /permission denied/, role);
    }
    assert.equal(one(psql(`select relforcerowsecurity from pg_class where oid = 'public.license_devices'::regclass;`)), "t");
    assert.equal(one(psql(`select count(*) from public.license_devices where device_id like 'pc-evil%';`)), "0");
  });
});
