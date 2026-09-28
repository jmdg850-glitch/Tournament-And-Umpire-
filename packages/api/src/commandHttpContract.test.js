// Phase F — the command API's HTTP contract, end to end through the REAL
// layers: the Hono app (server.js, same error contract as the Edge Function's
// index.ts via errorResponse) → handleCommand → the REAL supabase-js client.
// Only the network is replaced: `fetch` is answered locally in the exact wire
// format GoTrue and PostgREST use (PostgREST database errors are JSON
// `{ code: <SQLSTATE>, message, details, hint }`; an unmapped SQLSTATE such
// as TC001 arrives as HTTP 400 — see Supabase "PostgREST Error Codes").
// This proves supabase-js hands the SQLSTATE to the API as `error.code` and
// the API turns it into the documented HTTP answer. It does NOT prove what a
// live PostgREST sends — that still needs a dev/staging project.
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "./server.js";

const BASE = "http://supabase.test";
const USER = { id: "66666666-6666-4666-8666-666666666666", email: "organizer@example.com" };
const T = "11111111-1111-4111-8111-111111111111";
const GOOD_JWT = "good-user-jwt";

let tables;
let rpcScript; // queued responses for the next apply_official_writes calls
let rpcCalls;

function reset() {
  tables = {
    tournaments: [{ id: T, name: "Spring Open", status: "in_progress" }],
    tournament_members: [{ id: "tm-1", tournament_id: T, user_id: USER.id, role: "organizer" }],
    licenses: [{ status: "active", expires_at: null, email: USER.email, created_at: "2026-01-01T00:00:00Z" }],
    command_receipts: [],
    courts: [],
  };
  rpcScript = [];
  rpcCalls = 0;
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const pgError = (status, code, message, details = null) => json(status, { code, message, details, hint: null });

function matches(row, params) {
  for (const [col, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(col)) continue;
    if (raw.startsWith("eq.")) { if (String(row[col]) !== raw.slice(3)) return false; }
    else if (raw === "is.null") { if (row[col] != null) return false; }
    else if (raw.startsWith("in.(")) { if (!raw.slice(4, -1).split(",").includes(String(row[col]))) return false; }
  }
  return true;
}

// The one place the "database" is: apply a batch like apply_official_writes.
function applyBatch(payload) {
  for (const r of payload.upserts?.command_receipts || []) {
    if (tables.command_receipts.some((x) => x.id === r.id)) return pgError(400, "TC001", "command already applied", r.id);
  }
  for (const [name, rows] of Object.entries(payload.upserts || {})) {
    tables[name] ||= [];
    for (const row of rows) tables[name].push({ ...row });
  }
  return json(200, { ok: true });
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  const headers = new Headers(init.headers || {});
  if (url.pathname === "/auth/v1/user") {
    const token = (headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    if (token === GOOD_JWT) return json(200, { id: USER.id, email: USER.email, aud: "authenticated", role: "authenticated" });
    return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
  }
  if (url.pathname === "/rest/v1/rpc/apply_official_writes" && method === "POST") {
    rpcCalls += 1;
    const next = rpcScript.shift();
    const payload = JSON.parse(init.body).payload;
    if (typeof next === "function") return next(payload);
    return applyBatch(payload);
  }
  const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
  if (m && method === "GET") {
    const rows = (tables[m[1]] || []).filter((r) => matches(r, [...url.searchParams.entries()]));
    if ((headers.get("Accept") || "").includes("vnd.pgrst.object")) {
      return rows.length === 1 ? json(200, rows[0]) : pgError(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
    }
    return json(200, rows);
  }
  return json(404, { message: `unexpected ${method} ${url.pathname}` });
}

let app;
let n = 0;
const cmdId = () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, "0")}`;
async function post(body, { jwt = GOOD_JWT, raw = false } = {}) {
  const res = await app.request("http://local/command", {
    method: "POST",
    headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}
const createCourt = (command_id, name = "Court 1") => ({ command_id, type: "create_court", payload: { tournament_id: T, name } });

beforeAll(() => {
  vi.stubGlobal("fetch", fakeFetch);
  process.env.STATION_JWT_SECRET ||= "test-only-station-secret";
  app = createApp({ supabaseUrl: BASE, serviceRoleKey: "service-role-test-key" });
});
afterAll(() => vi.unstubAllGlobals());
beforeEach(reset);

describe("command API HTTP contract (real Hono app + real supabase-js)", () => {
  test("success → 200, idempotent:false", async () => {
    const r = await post(createCourt(cmdId()));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, idempotent: false });
    expect(tables.courts).toHaveLength(1);
  });

  test("exact duplicate → 200, idempotent:true, same result, no second write", async () => {
    const id = cmdId();
    const first = await post(createCourt(id));
    const calls = rpcCalls;
    const again = await post(createCourt(id));
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, idempotent: true, result: first.body.result });
    expect(rpcCalls).toBe(calls);
    expect(tables.courts).toHaveLength(1);
  });

  test("TC001 through supabase-js (concurrent duplicate lost the claim) → 200 replay of the winner", async () => {
    const id = cmdId();
    // The fast-path read finds nothing; meanwhile the "other request" commits
    // and this request's RPC gets PostgREST's TC001 error body.
    rpcScript.push((payload) => {
      const winner = { ...payload.upserts.command_receipts[0], result: { court: { id: "winner-court" } } };
      tables.command_receipts.push(winner);
      return pgError(400, "TC001", "command already applied", id);
    });
    const r = await post(createCourt(id));
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, idempotent: true, result: { court: { id: "winner-court" } } });
    expect(tables.courts).toHaveLength(0); // the loser wrote nothing
  });

  test("same command_id, different payload → 409 IDEMPOTENCY_KEY_REUSED (+ command_id)", async () => {
    const id = cmdId();
    await post(createCourt(id, "Court 1"));
    const r = await post(createCourt(id, "Court 2"));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED", command_id: id });
    expect(tables.courts.map((c) => c.name)).toEqual(["Court 1"]);
  });

  test("TC409 through supabase-js → 409 STALE_STATE with current_revision", async () => {
    rpcScript.push(() => pgError(400, "TC409", "stale state", "2026-09-28 01:02:03.456789+00"));
    const id = cmdId();
    const r = await post(createCourt(id));
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "STALE_STATE", command_id: id, current_revision: "2026-09-28 01:02:03.456789+00" });
  });

  test("TC412 through supabase-js → re-run; after 3 stale attempts → 503 RETRY_LATER", async () => {
    rpcScript.push(() => pgError(400, "TC412", "row changed since it was read"), () => pgError(400, "TC412", "row changed since it was read"), () => pgError(400, "TC412", "row changed since it was read"));
    const r = await post(createCourt(cmdId()));
    expect(rpcCalls).toBe(3);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("RETRY_LATER");
  });

  test("TC412 once, then success on the re-run → 200, exactly one write", async () => {
    rpcScript.push(() => pgError(400, "TC412", "row changed since it was read"));
    const r = await post(createCourt(cmdId()));
    expect(rpcCalls).toBe(2);
    expect(r.status).toBe(200);
    expect(tables.courts).toHaveLength(1);
  });

  test("unique violation (PostgREST 409 / 23505) → 409 CONFLICT, no constraint name leaked", async () => {
    rpcScript.push(() => pgError(409, "23505", 'duplicate key value violates unique constraint "courts_station_public_id_key"', "Key (station_public_id)=(abc) already exists."));
    const r = await post(createCourt(cmdId()));
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("CONFLICT");
    expect(JSON.stringify(r.body)).not.toMatch(/station_public_id|duplicate key|Key \(/);
  });

  test("database temporarily unreachable (PostgREST 503 PGRST000) → 5xx, generic message", async () => {
    rpcScript.push(() => pgError(503, "PGRST000", "Could not connect with the database", "connection refused 10.0.0.5:5432"));
    const r = await post(createCourt(cmdId()));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(r.body)).not.toMatch(/10\.0\.0\.5|5432|connect with/);
  });

  test("network failure between API and database → 5xx (retryable), generic message", async () => {
    rpcScript.push(() => { throw new TypeError("fetch failed"); });
    const r = await post(createCourt(cmdId()));
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(r.body.error.message).not.toMatch(/fetch failed/);
  });

  test("invalid JSON body → 400 INVALID_COMMAND", async () => {
    const r = await post("{not json", { raw: true });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_COMMAND");
  });

  test("invalid envelope → 400", async () => {
    expect((await post({ command_id: "nope", type: "create_court", payload: {} })).status).toBe(400);
    expect((await post({ command_id: cmdId(), type: "drop_everything", payload: {} })).status).toBe(400);
  });

  test("authentication failure → 401 (missing and invalid token)", async () => {
    expect((await post(createCourt(cmdId()), { jwt: null })).status).toBe(401);
    const bad = await post(createCourt(cmdId()), { jwt: "not-a-valid-token" });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("UNAUTHENTICATED");
  });

  test("authorization failure → 403 (not an organizer of this tournament)", async () => {
    tables.tournament_members = [];
    const r = await post(createCourt(cmdId()));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("FORBIDDEN");
    expect(tables.courts).toHaveLength(0);
  });
});
