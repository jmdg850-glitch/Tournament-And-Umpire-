// License revocation, end to end, with no mocked decisions:
//   - server rules: the real `license` Edge Function module (handleLicense)
//   - server enforcement: the real /command dispatcher (handleCommand) and
//     its real requireLicense / requireOrganizerLicensed checks
//   - client: the Operator's real callLicense + createLicenseMonitor (the
//     logic behind useLicense/LicenseGate), talking HTTP-shaped JSON
// All three share ONE in-memory `licenses` table, so a revoke written by the
// admin action is exactly what the client check and the command gate read.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { handleLicense } from "../../../supabase/functions/license/license.js";
import { handleCommand } from "../../../packages/api/src/handleCommand.js";
import {
  DENIED_MESSAGE, OFFLINE_ALLOWANCE_MS, RECHECK_MS, callLicense, createLicenseMonitor, isLicenseDenial, offlineAllowed, rememberActive,
} from "./license.js";

const COMMAND_URL = "https://x.supabase.co/functions/v1/command";
const PC = { id: "win-pc1-aaaaaaaaaa", label: "FRONT-DESK" };
const ADMIN = { id: "00000000-0000-4000-8000-00000000000a", email: "seller@example.com", emailConfirmed: true };
let userCounter = 0;
const newUser = (tag) => {
  userCounter += 1;
  const n = String(userCounter).padStart(12, "0");
  return { id: `00000000-0000-4000-8000-${n}`, email: `${tag}-${userCounter}@example.com`, emailConfirmed: true };
};
const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
const uuid = () => globalThis.crypto.randomUUID();

// ---------------------------------------------------------------------------
// In-memory service-role client: the query shapes license.js, authz.js and
// handleCommand use. Anything past the license gate (tournament writes, the
// apply_official_writes RPC) throws WRITE_PATH_REACHED, so a test can prove
// the gate let a command through without faking a whole tournament database.
// ---------------------------------------------------------------------------
class WritePathReached extends Error { constructor(what) { super(`WRITE_PATH_REACHED:${what}`); this.code = "WRITE_PATH_REACHED"; } }

function createDb() {
  let clock = 0;
  const tables = { licenses: [], license_admins: [{ user_id: ADMIN.id }], profiles: [], tournaments: [], tournament_members: [], command_receipts: [] };
  const readable = new Set(Object.keys(tables));
  const writable = new Set(["licenses"]);

  function from(table) {
    if (!readable.has(table)) throw new WritePathReached(`from(${table})`);
    const filters = [];
    let op = "select";
    let patch = null;
    let orderDesc = false;
    const match = (r) => filters.every(([kind, k, v]) => (kind === "neq" ? r[k] !== v : r[k] === v));
    const run = () => {
      const rows = tables[table];
      if (op === "update") {
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, patch);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (op === "insert") {
        const row = { id: uuid(), status: "unused", device_id: null, device_label: null, activated_at: null, activated_user_id: null, revoked_at: null, expires_at: null, created_at: new Date(1_800_000_000_000 + ++clock).toISOString(), ...patch };
        if (table === "licenses" && rows.some((r) => r.email === row.email && r.status !== "revoked")) {
          return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"licenses_one_live_per_email\"" } };
        }
        rows.push(row);
        return { data: [{ ...row }], error: null };
      }
      if (op === "delete") {
        tables[table] = rows.filter((r) => !match(r));
        return { data: null, error: null };
      }
      let out = rows.filter(match).map((r) => ({ ...r }));
      if (orderDesc) out = out.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return { data: out, error: null };
    };
    const guardWrite = (what) => { if (!writable.has(table)) throw new WritePathReached(`${what}(${table})`); };
    const api = {
      select() { return api; },
      insert(row) { guardWrite("insert"); op = "insert"; patch = row; return api; },
      update(p) { guardWrite("update"); op = "update"; patch = p; return api; },
      upsert() { throw new WritePathReached(`upsert(${table})`); },
      delete() { guardWrite("delete"); op = "delete"; return api; },
      eq(k, v) { filters.push(["eq", k, v]); return api; },
      is(k, v) { filters.push(["eq", k, v]); return api; },
      neq(k, v) { filters.push(["neq", k, v]); return api; },
      order(_k, opts) { orderDesc = opts?.ascending === false; return api; },
      limit() { return api; },
      async maybeSingle() { const r = run(); return { data: r.data?.[0] ?? null, error: r.error }; },
      async single() { const r = run(); return r.error ? r : { data: r.data?.[0] ?? null, error: null }; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return api;
  }
  return {
    tables,
    admin: { from, rpc: async (name) => { throw new WritePathReached(`rpc(${name})`); } },
  };
}

// The `license` function's HTTP contract (supabase/functions/license/index.ts):
// a JWT -> actor, LicenseError -> { ok:false, error:{code,message} } + status.
function licenseServer(db, sessions) {
  const net = { down: false };
  const fetchImpl = async (_url, init) => {
    if (net.down) throw new TypeError("fetch failed");
    const token = (init.headers.Authorization || "").replace(/^Bearer\s+/, "");
    const actor = sessions.get(token) || null;
    let status = 200;
    let body;
    try {
      body = await handleLicense({ admin: db.admin, actor, body: JSON.parse(init.body) });
    } catch (err) {
      status = Number(err.status) || 500;
      body = { ok: false, error: { code: err.code, message: err.publicMessage || "error" } };
    }
    return { ok: status < 400, status, json: async () => body };
  };
  return { net, fetchImpl };
}

function world() {
  const db = createDb();
  const sessions = new Map([["jwt-admin", ADMIN]]);
  const server = licenseServer(db, sessions);
  const call = (token, action, body = {}) => callLicense({ commandUrl: COMMAND_URL, publishableKey: "pk", accessToken: token, action, body, fetchImpl: server.fetchImpl });

  async function customer(tag) {
    const user = newUser(tag);
    const token = `jwt-${user.id}`;
    sessions.set(token, user);
    db.tables.profiles.push({ id: user.id });
    const { code, license } = await call("jwt-admin", "create", { email: user.email });
    await call(token, "activate", { code, device: PC });
    return { user, token, licenseId: license.id, code };
  }

  // What Operator's useLicense does, minus React: a monitor per app launch.
  function launch(c, storage, timers = { setInterval: () => 1, clearInterval: () => {} }) {
    const states = [];
    const monitor = createLicenseMonitor({
      userId: c.user.id, storage, timers,
      check: () => call(c.token, "check", { device: PC }),
      onState: (s) => states.push(s),
    });
    return { monitor, states, last: () => states[states.length - 1] };
  }

  // A real /command request as this user (create_tournament: license-gated).
  async function command(c, type = "create_tournament", payload = { name: "Club Open" }) {
    const actor = { kind: "user", id: c.user.id, email: c.user.email };
    return handleCommand({ admin: db.admin, actor, body: { command_id: uuid(), type, payload } });
  }

  return { db, server, call, customer, launch, command, revoke: (id) => call("jwt-admin", "revoke", { id }) };
}

// The license gate let the command through iff execution reached the write path.
async function commandOutcome(promise) {
  try { await promise; return "ALLOWED"; } catch (err) {
    if (err.code === "WRITE_PATH_REACHED") return "ALLOWED";
    return err.code;
  }
}

// ---------------------------------------------------------------------------

test("TEST 1 — a valid license: the client gate is active and licensed commands pass the server gate", async () => {
  const w = world();
  const a = await w.customer("valid");
  const app = w.launch(a, mem());
  await app.monitor.start();
  assert.equal(app.last().phase, "active");
  assert.equal(app.last().view.status, "active");
  assert.equal(await commandOutcome(w.command(a)), "ALLOWED");
});

test("TEST 2 — admin revoke writes status=revoked + revoked_at on exactly that license row", async () => {
  const w = world();
  const a = await w.customer("revoke-db");
  const b = await w.customer("bystander-db");
  const res = await w.revoke(a.licenseId);
  assert.equal(res.license.status, "revoked");
  const rowA = w.db.tables.licenses.find((l) => l.id === a.licenseId);
  const rowB = w.db.tables.licenses.find((l) => l.id === b.licenseId);
  assert.equal(rowA.status, "revoked");
  assert.ok(Number.isFinite(Date.parse(rowA.revoked_at)));
  assert.equal(rowB.status, "active");
  assert.equal(rowB.revoked_at, null);
});

test("TEST 3 — the next client validation after a revoke blocks access and says why", async () => {
  const w = world();
  const a = await w.customer("validate");
  const app = w.launch(a, mem());
  await app.monitor.start();
  assert.equal(app.last().phase, "active");
  await w.revoke(a.licenseId);
  await app.monitor.refresh();
  assert.equal(app.last().phase, "blocked");
  assert.equal(app.last().view.status, "revoked");
  assert.match(app.last().view.message, /revoked/);
});

test("TEST 4 — an already-open, idle client is blocked by the periodic check (every RECHECK_MS <= 5 min)", async () => {
  assert.ok(RECHECK_MS <= 5 * 60 * 1000, `open-app re-check interval is ${RECHECK_MS} ms`);
  const w = world();
  const a = await w.customer("open");
  let tick = null;
  let intervalMs = null;
  const timers = { setInterval: (fn, ms) => { tick = fn; intervalMs = ms; return 7; }, clearInterval: () => {} };
  const app = w.launch(a, mem(), timers);
  await app.monitor.start();
  assert.equal(intervalMs, RECHECK_MS);
  assert.equal(app.last().phase, "active");

  await w.revoke(a.licenseId);           // no user action in the open app
  assert.equal(app.last().phase, "active", "not blocked before the interval fires");
  tick();                                // the interval elapses
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(app.last().phase, "blocked");
  assert.equal(app.last().view.status, "revoked");
});

test("TEST 4b — an open client is blocked IMMEDIATELY when the server refuses a licensed command", async () => {
  const w = world();
  const a = await w.customer("deny");
  const storage = mem();
  const app = w.launch(a, storage);
  await app.monitor.start();
  await w.revoke(a.licenseId);

  let err;
  try { await w.command(a); } catch (e) { err = e; }
  assert.equal(err.code, "LICENSE_INVALID");
  assert.equal(err.status, 403);
  assert.ok(isLicenseDenial(err), "App.jsx treats this as a license denial");

  const pending = app.monitor.reportDenial();   // what App.jsx's command() wrapper calls
  assert.equal(app.last().phase, "blocked", "blocked synchronously, before any re-check returns");
  assert.equal(app.last().error, DENIED_MESSAGE);
  await pending;
  assert.equal(app.last().view.status, "revoked");
});

test("TEST 5 — restarting the app with a revoked license does not restore access", async () => {
  const w = world();
  const a = await w.customer("restart");
  const storage = mem();                         // survives the restart, like localStorage
  const first = w.launch(a, storage);
  await first.monitor.start();
  assert.equal(first.last().phase, "active");
  first.monitor.stop();

  await w.revoke(a.licenseId);
  const second = w.launch(a, storage);           // fresh process, same PC, same account
  await second.monitor.start();
  assert.equal(second.last().phase, "blocked");
  assert.equal(second.last().view.status, "revoked");
  const third = w.launch(a, storage);
  await third.monitor.start();
  assert.equal(third.last().phase, "blocked");
});

test("TEST 6 — a fresh local 'last verified active' entry never overrides the server's revoked answer", async () => {
  const w = world();
  const a = await w.customer("stale");
  const storage = mem();
  await w.revoke(a.licenseId);
  rememberActive(a.user.id, Date.now(), storage);          // stale local entitlement, verified "just now"
  assert.equal(offlineAllowed(a.user.id, Date.now(), storage), true);

  const app = w.launch(a, storage);
  await app.monitor.start();
  assert.equal(app.last().phase, "blocked", "server answer wins over local cache");
  assert.equal(offlineAllowed(a.user.id, Date.now(), storage), false, "revoked answer clears the offline allowance");

  w.server.net.down = true;                                // then the network drops
  await app.monitor.refresh();
  assert.equal(app.last().phase, "blocked", "going offline cannot resurrect access");
});

test("TEST 6b — a slow pre-revoke 'active' answer arriving after the denial is ignored", async () => {
  const w = world();
  const a = await w.customer("race");
  const storage = mem();
  let release;
  const states = [];
  let calls = 0;
  const monitor = createLicenseMonitor({
    userId: a.user.id, storage, timers: { setInterval: () => 1, clearInterval: () => {} },
    check: async () => {
      calls += 1;
      if (calls === 1) { await new Promise((r) => { release = r; }); return { status: "active" }; }
      return w.call(a.token, "check", { device: PC });
    },
    onState: (s) => states.push(s),
  });
  const lastActiveKey = `tournament.license.lastActive.${a.user.id}`;
  rememberActive(a.user.id, Date.now() - 60_000, storage); // verified active a minute ago (legit grace)
  const slow = monitor.start();                             // in flight, will answer "active"
  await w.revoke(a.licenseId);
  await monitor.reportDenial();                             // server refused a command meanwhile
  assert.equal(storage.getItem(lastActiveKey), null, "denial cleared the remembered-active timestamp");
  const statesBeforeStale = states.length;

  release();                                                // the stale "active" finally arrives
  const staleResult = await slow;
  assert.equal(staleResult, null, "stale result discarded");
  assert.equal(storage.getItem(lastActiveKey), null, "stale active did NOT re-save the remembered-active timestamp");
  assert.equal(offlineAllowed(a.user.id, Date.now(), storage), false, "stale active did NOT reopen the offline grace");
  assert.equal(states.length, statesBeforeStale, "stale active did not change the gate at all");
  assert.equal(states[states.length - 1].phase, "blocked");
  assert.equal(states[states.length - 1].view.status, "revoked", "newer revoked result not overwritten");
  assert.ok(!states.some((s, i) => i > 0 && s.phase === "active"), "stale active never applied");

  w.server.net.down = true;                                 // connectivity then lost
  await monitor.refresh();
  assert.equal(states[states.length - 1].phase, "blocked", "offline after the race: still blocked");
  const restartedOffline = w.launch(a, storage);
  await restartedOffline.monitor.start();
  assert.equal(restartedOffline.last().phase, "blocked", "offline restart after the race: still blocked");
  w.server.net.down = false;                                // reconnect
  await monitor.refresh();
  assert.equal(states[states.length - 1].phase, "blocked");
  assert.equal(states[states.length - 1].view.status, "revoked");
});

test("TEST 6c — a stale 'active' from ANOTHER window (shared storage) cannot re-save the offline grace either", async () => {
  const w = world();
  const a = await w.customer("race-window");
  const storage = mem();                                    // one localStorage shared by the main + a popped-out window
  const main = w.launch(a, storage);
  await main.monitor.start();
  assert.equal(offlineAllowed(a.user.id, Date.now(), storage), true, "legit grace while active");

  let release;
  const popped = createLicenseMonitor({
    userId: a.user.id, storage, timers: { setInterval: () => 1, clearInterval: () => {} }, onState: () => {},
    check: async () => { await new Promise((r) => { release = r; }); return { status: "active" }; },  // sent pre-revoke
  });
  const slow = popped.start();
  await new Promise((r) => setTimeout(r, 2));
  await w.revoke(a.licenseId);
  await main.monitor.reportDenial();                        // main window learns of the revoke
  release();
  await slow;                                               // popped window's stale "active" lands
  assert.equal(offlineAllowed(a.user.id, Date.now(), storage), false, "cross-window stale active did not reopen the grace");
  w.server.net.down = true;
  await main.monitor.refresh();
  assert.equal(main.last().phase, "blocked");
});

test("TEST 6d — the 7-day grace for a legitimately active license is unchanged", async () => {
  const w = world();
  const a = await w.customer("grace-legit");
  const storage = mem();
  const app = w.launch(a, storage);
  await app.monitor.start();
  assert.equal(app.last().phase, "active");
  const last = Number(storage.getItem(`tournament.license.lastActive.${a.user.id}`));
  assert.ok(last > 0, "active check saved the remembered-active timestamp");
  w.server.net.down = true;
  await app.monitor.refresh();
  assert.equal(app.last().phase, "active", "offline within the grace keeps working");
  assert.equal(offlineAllowed(a.user.id, last + OFFLINE_ALLOWANCE_MS - 1000, storage), true);
  assert.equal(offlineAllowed(a.user.id, last + OFFLINE_ALLOWANCE_MS + 1000, storage), false);
});

test("TEST 7 — protected /command operations are rejected after revocation (real handleCommand)", async () => {
  const w = world();
  const a = await w.customer("server");
  const tournamentId = uuid();
  w.db.tables.tournaments.push({ id: tournamentId, name: "Club Open", status: "draft", owner_id: a.user.id });
  w.db.tables.tournament_members.push({ tournament_id: tournamentId, user_id: a.user.id, role: "organizer" });

  await w.revoke(a.licenseId);                              // this email was never cached as allowed
  assert.equal(await commandOutcome(w.command(a, "create_tournament", { name: "New" })), "LICENSE_INVALID");
  assert.equal(await commandOutcome(w.command(a, "update_tournament", { tournament_id: tournamentId, name: "Renamed" })), "LICENSE_INVALID");
});

test("TEST 7b — server allow-cache: an account allowed just before a revoke is denied once the <=60 s window passes", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  try {
    const w = world();
    const a = await w.customer("cache");
    assert.equal(await commandOutcome(w.command(a)), "ALLOWED");      // caches a positive result
    await w.revoke(a.licenseId);
    mock.timers.tick(10_000);
    assert.equal(await commandOutcome(w.command(a)), "ALLOWED", "documented: warm-instance positive cache (<=60 s)");
    mock.timers.tick(51_000);
    assert.equal(await commandOutcome(w.command(a)), "LICENSE_INVALID");
    assert.equal(await commandOutcome(w.command(a)), "LICENSE_INVALID", "denials are never cached as allowed");
  } finally {
    mock.timers.reset();
  }
});

test("TEST 8 — issuing a new code to the same email and activating it restores access everywhere", async () => {
  const w = world();
  const a = await w.customer("restore");
  const storage = mem();
  const app = w.launch(a, storage);
  await app.monitor.start();
  await w.revoke(a.licenseId);
  await app.monitor.refresh();
  assert.equal(app.last().phase, "blocked");
  assert.equal(await commandOutcome(w.command(a)), "LICENSE_INVALID");

  const { code } = await w.call("jwt-admin", "create", { email: a.user.email });   // a revoked row does not block a new code
  const view = await w.call(a.token, "activate", { code, device: PC });
  assert.equal(view.status, "active");
  await app.monitor.refresh();
  assert.equal(app.last().phase, "active");
  assert.equal(await commandOutcome(w.command(a)), "ALLOWED");
  const restarted = w.launch(a, storage);
  await restarted.monitor.start();
  assert.equal(restarted.last().phase, "active");
});

test("TEST 9 — offline follows the documented 7-day allowance, and a revoke seen once removes it for good", async () => {
  const w = world();
  const a = await w.customer("offline");
  const storage = mem();
  const app = w.launch(a, storage);
  await app.monitor.start();                                // verified active -> allowance starts
  assert.equal(app.last().phase, "active");

  // Revoked while this PC is offline: the documented grace applies (no server answer yet).
  await w.revoke(a.licenseId);
  w.server.net.down = true;
  await app.monitor.refresh();
  assert.equal(app.last().phase, "active", "documented offline allowance (server unreachable)");

  // Never beyond 7 days from the last verified-active check.
  const lastActive = Number(storage.getItem(`tournament.license.lastActive.${a.user.id}`));
  assert.equal(offlineAllowed(a.user.id, lastActive + OFFLINE_ALLOWANCE_MS + 1000, storage), false);

  // Reconnect: the revoked answer blocks and removes the allowance permanently.
  w.server.net.down = false;
  await app.monitor.refresh();
  assert.equal(app.last().phase, "blocked");
  w.server.net.down = true;
  await app.monitor.refresh();
  assert.equal(app.last().phase, "blocked", "offline again: still blocked");
  const restarted = w.launch(a, storage);
  await restarted.monitor.start();
  assert.equal(restarted.last().phase, "blocked", "offline restart: still blocked");
});

test("TEST 10 — revoking one account leaves another account's valid license untouched", async () => {
  const w = world();
  const a = await w.customer("revoked-one");
  const b = await w.customer("other-valid");
  const appB = w.launch(b, mem());
  await appB.monitor.start();
  await w.revoke(a.licenseId);
  await appB.monitor.refresh();
  assert.equal(appB.last().phase, "active");
  assert.equal(await commandOutcome(w.command(b)), "ALLOWED");
  assert.equal(await commandOutcome(w.command(a)), "LICENSE_INVALID");
});

test("isLicenseDenial matches only the command layer's license refusals", () => {
  assert.equal(isLicenseDenial({ status: 403, code: "LICENSE_INVALID" }), true);
  assert.equal(isLicenseDenial({ status: 403, code: "LICENSE_REQUIRED" }), true);
  assert.equal(isLicenseDenial({ status: 403, code: "FORBIDDEN" }), false);
  assert.equal(isLicenseDenial({ status: 500, code: "LICENSE_INVALID" }), false);
  assert.equal(isLicenseDenial({ code: "LICENSE_INVALID" }), false, "no status = network error, not a server answer");
  assert.equal(isLicenseDenial(null), false);
});
