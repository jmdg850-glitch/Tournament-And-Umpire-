// The Edge Function runs the BUNDLE (supabase/functions/command/handleCommand.js),
// not packages/api/src. These tests make sure the artifact that gets deployed
// is (1) exactly what the current source builds to, (2) exports everything
// index.ts imports, and (3) itself behaves per the Phase F contract when driven
// through the real supabase-js client (network answered locally in PostgREST's
// error format).
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const bundlePath = resolve(root, "supabase/functions/command/handleCommand.js");
const indexPath = resolve(root, "supabase/functions/command/index.ts");

// Same arguments as scripts/bundle-command.mjs, but --no-install: this can
// never download a package. Where esbuild isn't available locally the check is
// skipped (reported), not failed.
function rebuild(entry) {
  const r = spawnSync("npx", ["--no-install", "esbuild", entry, "--bundle", "--format=esm", "--platform=neutral", "--log-level=error"], {
    cwd: root,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return r.status === 0 ? r.stdout : null;
}

describe("Edge Function bundle", () => {
  test("the checked-in command bundle is exactly what the current source builds to", (ctx) => {
    const fresh = rebuild("packages/api/src/handleCommand.js");
    if (fresh == null) ctx.skip();
    const onDisk = readFileSync(bundlePath, "utf8").replace(/\r\n/g, "\n");
    expect(fresh.replace(/\r\n/g, "\n"), "run the bundle step (npx --no-install esbuild …) — the bundle is stale").toBe(onDisk);
  }, 60_000);

  test("the checked-in pair-station bundle is exactly what the current source builds to", (ctx) => {
    const fresh = rebuild("packages/api/src/stationAuth.js");
    if (fresh == null) ctx.skip();
    const onDisk = readFileSync(resolve(root, "supabase/functions/pair-station/stationAuth.js"), "utf8").replace(/\r\n/g, "\n");
    expect(fresh.replace(/\r\n/g, "\n")).toBe(onDisk);
  }, 60_000);

  test("the bundle exports every name index.ts imports from it", async () => {
    const m = /import\s*\{([^}]+)\}\s*from\s*"\.\/handleCommand\.js"/.exec(readFileSync(indexPath, "utf8"));
    const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    const bundle = await import(pathToFileURL(bundlePath).href);
    for (const name of names) expect(typeof bundle[name], name).toBe("function");
  });
});

// ---- the bundle's own behaviour ---------------------------------------------
const USER = { kind: "user", id: "66666666-6666-4666-8666-666666666666", email: "organizer@example.com" };
const T = "11111111-1111-4111-8111-111111111111";
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fakeDatabase() {
  const tables = {
    tournaments: [{ id: T, name: "Spring Open", status: "in_progress" }],
    tournament_members: [{ id: "tm-1", tournament_id: T, user_id: USER.id, role: "organizer" }],
    licenses: [{ status: "active", expires_at: null, email: USER.email, created_at: "2026-01-01T00:00:00Z" }],
    command_receipts: [],
    courts: [],
    audit_logs: [],
  };
  const script = [];
  let rpcCalls = 0;
  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    if (url.pathname === "/rest/v1/rpc/apply_official_writes") {
      rpcCalls += 1;
      const payload = JSON.parse(init.body).payload;
      const next = script.shift();
      if (next) return next(payload);
      for (const r of payload.upserts?.command_receipts || []) {
        if (tables.command_receipts.some((x) => x.id === r.id)) return json(400, { code: "TC001", message: "command already applied", details: r.id, hint: null });
      }
      for (const [name, rows] of Object.entries(payload.upserts || {})) (tables[name] ||= []).push(...rows);
      return json(200, { ok: true });
    }
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (m && method === "GET") {
      const rows = (tables[m[1]] || []).filter((row) => [...url.searchParams.entries()].every(([k, v]) => ["select", "order", "limit"].includes(k) || !v.startsWith("eq.") || String(row[k]) === v.slice(3)));
      return json(200, rows);
    }
    return json(404, { message: `unexpected ${method} ${url.pathname}` });
  }
  const admin = createClient("http://supabase.test", "service-role-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  });
  return { admin, tables, script, get rpcCalls() { return rpcCalls; } };
}

describe("bundle behaviour (the deployed artifact, not the source)", () => {
  let n = 0;
  const cmdId = () => `cccccccc-cccc-4ccc-8ccc-${String(++n).padStart(12, "0")}`;
  const load = () => import(pathToFileURL(bundlePath).href);
  const run = async (db, body) => {
    const { handleCommand, errorResponse } = await load();
    try {
      return { status: 200, body: await handleCommand({ admin: db.admin, actor: USER, body }) };
    } catch (err) {
      return errorResponse(err, body.command_id);
    }
  };
  const court = (id, name = "Court 1", extra = {}) => ({ command_id: id, type: "create_court", payload: { tournament_id: T, name, ...extra } });

  test("success, exact replay, and same-id/different-payload rejection", async () => {
    const db = fakeDatabase();
    const id = cmdId();
    const first = await run(db, court(id));
    expect(first).toMatchObject({ status: 200, body: { ok: true, idempotent: false } });
    const again = await run(db, court(id));
    expect(again).toMatchObject({ status: 200, body: { ok: true, idempotent: true, result: first.body.result } });
    const reused = await run(db, court(id, "Court 2"));
    expect(reused.status).toBe(409);
    expect(reused.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", command_id: id });
    expect(db.tables.courts).toHaveLength(1);
  });

  test("TC001 from PostgREST (a concurrent duplicate won the claim) → 200 replay of the winner", async () => {
    const db = fakeDatabase();
    const id = cmdId();
    db.script.push((payload) => {
      db.tables.command_receipts.push({ ...payload.upserts.command_receipts[0], result: { court: { id: "winner" } } });
      return json(400, { code: "TC001", message: "command already applied", details: id, hint: null });
    });
    const r = await run(db, court(id));
    expect(r).toMatchObject({ status: 200, body: { idempotent: true, result: { court: { id: "winner" } } } });
    expect(db.tables.courts).toHaveLength(0);
  });

  test("TC409 → 409 STALE_STATE with current_revision; TC412 ×3 → 503 RETRY_LATER after exactly 3 writes", async () => {
    const db = fakeDatabase();
    db.script.push(() => json(400, { code: "TC409", message: "stale state", details: "2026-09-28T01:02:03.456789+00:00", hint: null }));
    const stale = await run(db, court(cmdId()));
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "STALE_STATE", current_revision: "2026-09-28T01:02:03.456789+00:00" });
    const tc412 = () => json(400, { code: "TC412", message: "row changed since it was read", details: "", hint: null });
    db.script.push(tc412, tc412, tc412);
    const before = db.rpcCalls;
    const busy = await run(db, court(cmdId()));
    expect(db.rpcCalls - before).toBe(3);
    expect(busy.status).toBe(503);
    expect(busy.body.error.code).toBe("RETRY_LATER");
  });

  test("unique violation → 409 without internals; unsupported precondition → 400", async () => {
    const db = fakeDatabase();
    db.script.push(() => json(409, { code: "23505", message: 'duplicate key value violates unique constraint "courts_station_public_id_key"', details: "Key (station_public_id)=(x) already exists.", hint: null }));
    const dup = await run(db, court(cmdId()));
    expect(dup.status).toBe(409);
    expect(JSON.stringify(dup.body)).not.toMatch(/station_public_id|duplicate key|Key \(/);
    const pre = await run(db, court(cmdId(), "Court 3", { precondition: { match_updated_at: "2026-09-28T00:00:00Z" } }));
    expect(pre.status).toBe(400);
    expect(pre.body.error.code).toBe("INVALID_COMMAND");
  });
});
