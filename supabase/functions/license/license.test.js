import test from "node:test";
import assert from "node:assert/strict";
import {
  LicenseError, MAX_DEVICES_MAX, customerView, decideActivation, generateCode, handleLicense, maskEmail,
  normalizeCode, normalizeEmail, validateDevice, validateMaxDevices,
} from "./license.js";

const CODE_RE = /^[2-9A-HJKMNP-TV-Z]{4}(-[2-9A-HJKMNP-TV-Z]{4}){2}$/;
const NOW = Date.parse("2026-09-22T12:00:00Z");
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

test("generated codes are XXXX-XXXX-XXXX from the unambiguous alphabet, and unique", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generateCode();
    assert.match(c, CODE_RE);
    assert.equal(normalizeCode(c), c);
    seen.add(c);
  }
  assert.equal(seen.size, 2000);
  for (const bad of "01ILOU") assert.ok(![...seen].some((c) => c.includes(bad)), `no ${bad}`);
});

test("rejection sampling discards biased bytes", () => {
  let first = true;
  const feed = [250, 255, ...Array.from({ length: 12 }, (_, i) => i)];
  const code = generateCode(() => { if (!first) return new Uint8Array(24); first = false; return Uint8Array.from(feed); });
  assert.equal(code, "2345-6789-ABCD");
});

test("normalizeCode accepts harmless variation", () => {
  for (const v of ["ab2d-3fgh-jk4m", "  AB2D-3FGH-JK4M \n", "AB2D 3FGH JK4M", "ab2d3fghjk4m", "ab2d_3fgh_jk4m"]) {
    assert.equal(normalizeCode(v), "AB2D-3FGH-JK4M", v);
  }
});

test("normalizeCode rejects malformed, truncated and ambiguous codes", () => {
  for (const v of ["", "   ", "hello", "AB2D-3FGH", "AB2D-3FGH-JK4", "AB2D-3FGH-JK4M-2222", "AB2D-3FGH-JK4!", "0B2D-3FGH-JK4M", "IB2D-3FGH-JK4M",
    "OB2D-3FGH-JK4M", "LB2D-3FGH-JK4M", "UB2D-3FGH-JK4M", "1B2D-3FGH-JK4M", "'; drop table licenses;--", "A".repeat(500), null, undefined, 42, {}, []]) {
    assert.equal(normalizeCode(v), null, String(v));
  }
});

test("normalizeEmail lowercases/trims and rejects junk", () => {
  assert.equal(normalizeEmail("  Customer@Example.COM "), "customer@example.com");
  for (const v of ["", "nope", "a@b", "a b@c.com", null, undefined, 5, "x".repeat(300) + "@a.com"]) assert.equal(normalizeEmail(v), null, String(v));
});

test("validateDevice requires a stable id; the label is trimmed and display-only", () => {
  assert.deepEqual(validateDevice({ id: "win-abcdef123456", label: "  BOB-PC " }), { id: "win-abcdef123456", label: "BOB-PC" });
  assert.equal(validateDevice({ id: "win-abcdef123456" }).label, "");
  assert.equal(validateDevice({ id: "win-abcdef123456", label: "x".repeat(200) }).label.length, 80);
  for (const bad of [null, undefined, {}, [], "str", { id: "short" }, { id: "has spaces here!!" }, { id: 12345678 }]) {
    assert.throws(() => validateDevice(bad), LicenseError, JSON.stringify(bad));
  }
});

test("validateMaxDevices accepts whole numbers 1..100 only", () => {
  for (const ok of [1, 2, 3, 5, 10, 57, MAX_DEVICES_MAX]) assert.equal(validateMaxDevices(ok), ok);
  for (const bad of [0, -1, 101, 2.5, "3", null, undefined, NaN, Infinity, [3], {}]) {
    assert.throws(() => validateMaxDevices(bad), (e) => e instanceof LicenseError && e.code === "VALIDATION", String(bad));
  }
});

const lic = (over = {}) => ({
  id: "11111111-1111-4111-8111-111111111111", email: "a@b.com", access_code: "AB2D-3FGH-JK4M", status: "unused",
  device_id: null, expires_at: null, max_devices: 1, activated_user_id: null, created_at: iso(NOW - DAY), ...over,
});

test("decideActivation: unknown, revoked and expired licenses cannot register devices", () => {
  assert.deepEqual(decideActivation({ license: null, now: NOW }), { ok: false, code: "INVALID_CODE" });
  assert.equal(decideActivation({ license: lic({ status: "revoked" }), now: NOW }).code, "REVOKED");
  assert.equal(decideActivation({ license: lic({ status: "active", expires_at: iso(NOW - 1) }), now: NOW }).code, "EXPIRED");
  assert.deepEqual(decideActivation({ license: lic({ expires_at: iso(NOW + DAY) }), now: NOW }), { ok: true });
  assert.deepEqual(decideActivation({ license: lic({ status: "active" }), now: NOW }), { ok: true });
});

test("customerView is device-aware and never leaks the code", () => {
  const active = lic({ status: "active", activated_at: iso(NOW) });
  assert.equal(customerView(active, true, NOW).status, "active");
  const other = customerView(active, false, NOW);
  assert.equal(other.status, "not_registered");
  // No message: installed Operator builds then show the Access Code form.
  assert.equal(other.message, undefined);
  assert.equal(customerView(lic(), false, NOW).status, "unused");
  assert.equal(customerView(lic({ status: "revoked" }), true, NOW).status, "revoked");
  assert.match(customerView(lic({ status: "revoked" }), true, NOW).message, /revoked/);
  assert.equal(customerView(lic({ status: "active", expires_at: iso(NOW - 1) }), true, NOW).status, "expired");
  assert.equal(customerView(null, false, NOW).status, "none");
  assert.ok(!JSON.stringify(customerView(active, true, NOW)).includes("AB2D"));
});

// ---------------------------------------------------------------------------
// In-memory stand-in for the service-role client
// ---------------------------------------------------------------------------

// Only the query shapes license.js uses (select/insert/update/delete, eq/neq/is,
// order/limit, maybeSingle/single) plus auth.admin.createUser, and an `rpc`
// that follows public.license_register_device (0020) rule for rule. The real
// function — including the row lock that makes the final-slot race safe — is
// exercised against PostgreSQL in licenseDevices.pg.test.js.
let seq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

function fakeAdmin(rows, { devices = [], admins = [], existingEmails = [], dbNow = NOW } = {}) {
  const db = {
    licenses: rows.map((r) => ({ ...r })),
    license_devices: devices.map((d) => ({ released_at: null, last_seen_at: null, ...d })),
    license_admins: admins.map((id) => ({ user_id: id })),
  };
  const users = new Map(existingEmails.map((e, i) => [e, { id: `existing-${i}`, email: e }]));
  const createCalls = [];
  const rpcCalls = [];
  function query(table) {
    const filters = [];
    let patch = null;
    let insertRow = null;
    let remove = false;
    let limit = Infinity;
    const match = (r) => filters.every((f) => f(r));
    const run = () => {
      if (insertRow) {
        if (table === "licenses") {
          if (db.licenses.some((r) => r.email === insertRow.email && r.status !== "revoked")) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"licenses_one_live_per_email\"" } };
          }
          if (db.licenses.some((r) => r.access_code === insertRow.access_code)) {
            return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint \"licenses_access_code_key\"" } };
          }
        }
        const row = { id: uuid(), status: "unused", max_devices: 1, created_at: iso(NOW), activated_user_id: null, device_id: null, ...insertRow };
        db[table].push(row);
        return { data: [{ ...row }], error: null };
      }
      const hit = db[table].filter(match);
      if (remove) {
        db[table] = db[table].filter((r) => !hit.includes(r));
        return { data: hit, error: null };
      }
      if (patch) for (const r of hit) Object.assign(r, patch);
      return { data: hit.slice(0, limit).map((r) => ({ ...r })), error: null };
    };
    const api = {
      select() { return api; },
      insert(row) { insertRow = row; return api; },
      update(p) { patch = p; return api; },
      delete() { remove = true; return api; },
      eq(k, v) { filters.push((r) => r[k] === v); return api; },
      neq(k, v) { filters.push((r) => r[k] !== v); return api; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return api; },
      is(k, v) { filters.push((r) => (v === null ? r[k] == null : r[k] === v)); return api; },
      order() { return api; },
      limit(n) { limit = n; return api; },
      async maybeSingle() { const { data, error } = run(); return { data: data?.[0] ?? null, error }; },
      async single() { const { data, error } = run(); return { data: data?.[0] ?? null, error }; },
      then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
    };
    return api;
  }
  async function rpc(name, p) {
    rpcCalls.push({ name, ...p });
    assert.equal(name, "license_register_device");
    const l = db.licenses.find((r) => r.id === p.p_license_id);
    if (!l) return { data: { ok: false, code: "NOT_FOUND" }, error: null };
    if (l.status === "revoked") return { data: { ok: false, code: "REVOKED" }, error: null };
    if (l.expires_at && Date.parse(l.expires_at) <= dbNow) return { data: { ok: false, code: "EXPIRED" }, error: null };
    const live = db.license_devices.filter((d) => d.license_id === l.id && !d.released_at);
    const here = live.find((d) => d.device_id === p.p_device_id);
    const max = l.max_devices ?? 1;
    if (here) {
      here.last_seen_at = iso(dbNow);
      return { data: { ok: true, outcome: "already_here", active_devices: live.length, max_devices: max }, error: null };
    }
    if (p.p_first_only && live.length >= 1) return { data: { ok: false, code: "ALREADY_ACTIVATED" }, error: null };
    if (live.length >= max) return { data: { ok: false, code: "DEVICE_LIMIT", active_devices: live.length, max_devices: max }, error: null };
    db.license_devices.push({
      id: uuid(), license_id: l.id, device_id: p.p_device_id, device_label: p.p_device_label || null, user_id: p.p_user_id,
      first_activated_at: iso(dbNow), last_seen_at: iso(dbNow), released_at: null,
    });
    l.status = "active";
    l.activated_at = l.activated_at || iso(dbNow);
    l.activated_user_id = l.activated_user_id || p.p_user_id;
    return { data: { ok: true, outcome: "registered", active_devices: live.length + 1, max_devices: max }, error: null };
  }
  const activeDevices = (licenseId) => db.license_devices.filter((d) => d.license_id === licenseId && !d.released_at);
  return {
    db, users, createCalls, rpcCalls, activeDevices,
    from: query,
    rpc,
    auth: {
      admin: {
        async createUser(args) {
          createCalls.push(args);
          if (users.has(args.email)) {
            return { data: { user: null }, error: { code: "email_exists", status: 422, message: "A user with this email address has already been registered" } };
          }
          const user = { id: `user-${users.size + 1}`, email: args.email };
          users.set(args.email, user);
          return { data: { user }, error: null };
        },
      },
    },
  };
}

const pc = (n) => ({ id: `win-pc${n}-${"abcdefghij"[n % 10].repeat(10)}`, label: `PC-${n}` });
const PC1 = { id: "win-pc1-aaaaaaaaaa", label: "FRONT-DESK" };
const PC2 = { id: "win-pc2-bbbbbbbbbb", label: "OTHER" };
const CODE = "AB2D-3FGH-JK4M";
const LIC_ID = lic().id;
const ADMIN = { id: "admin-1", email: "owner@example.com", emailConfirmed: true };
const BUYER = { id: "user-7", email: "buyer@example.com", emailConfirmed: true };
const call = (admin, body) => handleLicense({ admin, actor: null, body, now: NOW });
const as = (actor, admin, body) => handleLicense({ admin, actor, body, now: NOW });
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof LicenseError && e.code === code);
const activate = (admin, device, code = CODE, actor = BUYER) => as(actor, admin, { action: "activate", code, device });
const check = (admin, device, actor = BUYER) => as(actor, admin, { action: "check", device }).then((r) => r.result);
const listed = async (admin) => (await as(ADMIN, admin, { action: "list" })).result.items;

// A signed-in buyer with a license allowing `max` devices.
function buyerLicense(max, over = {}) {
  return fakeAdmin([lic({ email: BUYER.email, max_devices: max, ...over })], { admins: [ADMIN.id] });
}

// ---------------------------------------------------------------------------
// Multi-device activation (1-13)
// ---------------------------------------------------------------------------

test("1-4: devices register up to max_devices; the next new device gets DEVICE_LIMIT", async () => {
  const admin = buyerLicense(3);
  const r1 = await activate(admin, pc(1));
  assert.equal(r1.result.status, "active");
  assert.equal(admin.db.licenses[0].status, "active");
  assert.equal(admin.db.licenses[0].activated_user_id, BUYER.id);
  assert.equal(admin.activeDevices(LIC_ID).length, 1);

  assert.equal((await activate(admin, pc(2))).result.status, "active");
  assert.equal(admin.activeDevices(LIC_ID).length, 2);
  assert.equal((await activate(admin, pc(3))).result.status, "active");
  assert.equal(admin.activeDevices(LIC_ID).length, 3);

  await assert.rejects(activate(admin, pc(4)), (e) => {
    assert.equal(e.code, "DEVICE_LIMIT");
    assert.equal(e.status, 409);
    assert.match(e.message, /device limit/);
    return true;
  });
  assert.equal(admin.activeDevices(LIC_ID).length, 3, "the rejected device took no slot");
  assert.equal((await check(admin, pc(4))).status, "not_registered");
  for (const n of [1, 2, 3]) assert.equal((await check(admin, pc(n))).status, "active");
});

test("5: the same device (relaunch, reinstall, repeated activation) never takes another slot", async () => {
  const admin = buyerLicense(2);
  await activate(admin, pc(1));
  for (let i = 0; i < 3; i++) assert.equal((await activate(admin, pc(1))).result.status, "active");
  // Same machine id, different computer name: still the same device.
  assert.equal((await activate(admin, { ...pc(1), label: "RENAMED-PC" })).result.status, "active");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
  assert.equal((await check(admin, pc(1))).status, "active");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
  // The one free slot is still there for a genuinely new PC.
  await activate(admin, pc(2));
  assert.equal(admin.activeDevices(LIC_ID).length, 2);
});

test("6-8: releasing one device frees exactly one slot; the released PC is unregistered; a new PC can take the slot", async () => {
  const admin = buyerLicense(3);
  for (const n of [1, 2, 3]) await activate(admin, pc(n));
  const b = admin.activeDevices(LIC_ID).find((d) => d.device_id === pc(2).id);

  const r = await as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: b.id });
  assert.equal(r.result.license.active_devices, 2);
  assert.equal(r.result.license.max_devices, 3);
  assert.ok(b.released_at, "released row kept as history");
  assert.equal(admin.db.license_devices.length, 3);

  assert.equal((await check(admin, pc(1))).status, "active");
  assert.equal((await check(admin, pc(3))).status, "active");
  const released = await check(admin, pc(2));
  assert.equal(released.status, "not_registered");
  assert.equal(released.message, undefined);

  await activate(admin, pc(4));
  assert.deepEqual(admin.activeDevices(LIC_ID).map((d) => d.device_id).sort(), [pc(1).id, pc(3).id, pc(4).id].sort());
  await rejects(activate(admin, pc(2)), "DEVICE_LIMIT");
  // Releasing twice is refused and changes nothing.
  await rejects(as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: b.id }), "DEVICE_NOT_FOUND");
});

test("released device can register again when a slot is free (same row stays as history)", async () => {
  const admin = buyerLicense(2);
  await activate(admin, pc(1));
  const row = admin.activeDevices(LIC_ID)[0];
  await as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: row.id });
  assert.equal((await activate(admin, pc(1))).result.status, "active");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
  assert.equal(admin.db.license_devices.filter((d) => d.device_id === pc(1).id).length, 2);
});

test("9: revoke blocks every device of the license, and no device can register", async () => {
  const admin = buyerLicense(3);
  for (const n of [1, 2]) await activate(admin, pc(n));
  await as(ADMIN, admin, { action: "revoke", id: LIC_ID });
  for (const n of [1, 2, 3]) {
    const v = await check(admin, pc(n));
    assert.equal(v.status, "revoked");
    assert.match(v.message, /revoked/);
  }
  await rejects(activate(admin, pc(1)), "REVOKED");
  await rejects(activate(admin, pc(3)), "REVOKED");
  // A revoked license cannot have its limit changed.
  await rejects(as(ADMIN, admin, { action: "set_max_devices", id: LIC_ID, max_devices: 5 }), "INVALID_STATE");
});

test("10: raising the limit lets new devices register up to the new limit", async () => {
  const admin = buyerLicense(3);
  for (const n of [1, 2, 3]) await activate(admin, pc(n));
  await rejects(activate(admin, pc(4)), "DEVICE_LIMIT");
  const r = await as(ADMIN, admin, { action: "set_max_devices", id: LIC_ID, max_devices: 5 });
  assert.equal(r.result.license.max_devices, 5);
  await activate(admin, pc(4));
  await activate(admin, pc(5));
  await rejects(activate(admin, pc(6)), "DEVICE_LIMIT");
  assert.equal(admin.activeDevices(LIC_ID).length, 5);
});

test("11-13: lowering the limit below usage deletes nothing; existing devices keep working; no NEW device until under the limit", async () => {
  const admin = buyerLicense(5);
  for (const n of [1, 2, 3, 4, 5]) await activate(admin, pc(n));
  const r = await as(ADMIN, admin, { action: "set_max_devices", id: LIC_ID, max_devices: 3 });
  assert.equal(r.result.license.max_devices, 3);
  assert.equal(r.result.license.active_devices, 5);
  assert.equal(r.result.license.over_limit, true);
  assert.equal(admin.activeDevices(LIC_ID).length, 5, "no device was released or deleted");
  assert.equal(admin.db.license_devices.filter((d) => d.released_at).length, 0);

  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal((await check(admin, pc(n))).status, "active", `existing PC ${n} keeps working`);
    assert.equal((await activate(admin, pc(n))).result.status, "active", `existing PC ${n} re-activates`);
  }
  await rejects(activate(admin, pc(6)), "DEVICE_LIMIT");

  // Back down to 3 active: still full, so still no new device.
  for (const n of [4, 5]) {
    const d = admin.activeDevices(LIC_ID).find((x) => x.device_id === pc(n).id);
    await as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: d.id });
  }
  const [item] = await listed(admin);
  assert.equal(item.active_devices, 3);
  assert.equal(item.over_limit, false);
  await rejects(activate(admin, pc(6)), "DEVICE_LIMIT");
  // Under the limit: a new device registers.
  const d3 = admin.activeDevices(LIC_ID).find((x) => x.device_id === pc(3).id);
  await as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: d3.id });
  await activate(admin, pc(6));
  assert.equal(admin.activeDevices(LIC_ID).length, 3);
});

// ---------------------------------------------------------------------------
// Wrong email / code, expiry (14-15)
// ---------------------------------------------------------------------------

test("14: wrong email, wrong code and malformed codes register nothing", async () => {
  const admin = buyerLicense(3);
  const stranger = { id: "user-99", email: "stranger@example.com", emailConfirmed: true };
  await rejects(activate(admin, pc(1), CODE, stranger), "INVALID_CODE");
  await rejects(activate(admin, pc(1), "ZZZZ-ZZZZ-ZZZZ"), "INVALID_CODE");
  await rejects(activate(admin, pc(1), "nope"), "INVALID_CODE_FORMAT");
  await rejects(activate(admin, pc(1), CODE, { ...BUYER, emailConfirmed: false }), "EMAIL_NOT_VERIFIED");
  await rejects(activate(admin, { id: "x" }), "VALIDATION");
  assert.equal(admin.db.license_devices.length, 0);
  assert.equal(admin.rpcCalls.length, 0);
  assert.equal((await check(admin, pc(1), stranger)).status, "none");
});

test("15: an expired license registers no device and reports expired on registered devices", async () => {
  const admin = buyerLicense(3, { expires_at: iso(NOW - 1) });
  await rejects(activate(admin, pc(1)), "EXPIRED");
  assert.equal(admin.db.license_devices.length, 0);
  const active = buyerLicense(3, { status: "active", expires_at: iso(NOW - DAY) });
  active.db.license_devices.push({ id: uuid(), license_id: LIC_ID, device_id: pc(1).id, released_at: null });
  assert.equal((await check(active, pc(1))).status, "expired");
  await rejects(activate(active, pc(1)), "EXPIRED");
});

// ---------------------------------------------------------------------------
// Code-first setup: claim → set_password (16-17)
// ---------------------------------------------------------------------------

test("16: claim registers the first device without a session, then asks for a password", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com", max_devices: 3 })]);
  const r = await call(admin, { action: "claim", code: "ab2d 3fgh jk4m", device: PC1 });
  assert.equal(r.ok, true);
  assert.equal(r.result.status, "active");
  assert.equal(r.result.bound, "now");
  assert.equal(r.result.next, "set_password");
  assert.equal(r.result.email, "buyer@example.com");
  assert.equal(r.result.email_masked, "bu•••@example.com");
  assert.ok(!JSON.stringify(r.result).includes(CODE), "never echoes the code");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
  assert.equal(admin.db.licenses[0].activated_user_id, null);
  assert.equal(admin.rpcCalls[0].p_first_only, true);
  assert.equal(admin.rpcCalls[0].p_user_id, null);
});

test("claim: already registered on THIS PC without an account → continue password setup (no new slot)", async () => {
  const admin = fakeAdmin([lic({ status: "active", max_devices: 3 })], { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }] });
  const r = await call(admin, { action: "claim", code: CODE, device: PC1 });
  assert.equal(r.result.bound, "already_here");
  assert.equal(r.result.next, "set_password");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
});

test("17: once an account exists, a leaked code cannot register devices anonymously", async () => {
  const admin = fakeAdmin([lic({ status: "active", max_devices: 5, activated_user_id: "user-9" })],
    { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }] });
  for (const n of [2, 3, 4, 5, 6, 7]) {
    const r = await call(admin, { action: "claim", code: CODE, device: pc(n) });
    assert.equal(r.result.next, "sign_in");
    assert.equal(r.result.bound, "not_registered");
    assert.equal(r.result.status, "not_registered");
  }
  assert.equal(admin.activeDevices(LIC_ID).length, 1, "no slot consumed by the code alone");
  assert.equal(admin.rpcCalls.length, 0);
  const here = await call(admin, { action: "claim", code: CODE, device: PC1 });
  assert.equal(here.result.bound, "already_here");
  assert.equal(here.result.next, "sign_in");
});

test("17b: before the account exists, the code alone sets up only the FIRST device", async () => {
  const admin = fakeAdmin([lic({ max_devices: 5 })]);
  await call(admin, { action: "claim", code: CODE, device: PC1 });
  await rejects(call(admin, { action: "claim", code: CODE, device: PC2 }), "ALREADY_ACTIVATED");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
});

test("claim: rejects revoked, expired, unknown and malformed codes, and stray fields", async () => {
  await rejects(call(fakeAdmin([lic({ status: "revoked" })]), { action: "claim", code: CODE, device: PC1 }), "REVOKED");
  await rejects(call(fakeAdmin([lic({ expires_at: iso(NOW - 1) })]), { action: "claim", code: CODE, device: PC1 }), "EXPIRED");
  await rejects(call(fakeAdmin([]), { action: "claim", code: CODE, device: PC1 }), "UNKNOWN_CODE");
  await rejects(call(fakeAdmin([]), { action: "claim", code: "nope", device: PC1 }), "INVALID_CODE_FORMAT");
  await rejects(call(fakeAdmin([lic()]), { action: "claim", code: CODE, device: { id: "x" } }), "VALIDATION");
  await rejects(call(fakeAdmin([lic()]), { action: "claim", code: CODE, device: PC1, email: "x@y.com" }), "VALIDATION");
});

test("set_password: after the first device is set up, creates the buyer's own confirmed account and links it", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com" })]);
  await call(admin, { action: "claim", code: CODE, device: PC1 });
  const r = await call(admin, { action: "set_password", code: CODE, device: PC1, password: "correct horse 1" });
  assert.deepEqual(r.result, { account: "created", email: "buyer@example.com" });
  assert.equal(admin.createCalls.length, 1);
  assert.deepEqual(admin.createCalls[0], { email: "buyer@example.com", password: "correct horse 1", email_confirm: true });
  assert.equal(admin.db.licenses[0].activated_user_id, "user-1");
  assert.ok(!JSON.stringify(r).includes("correct horse 1"), "password never returned");
  // A second attempt cannot replace the password.
  await rejects(call(admin, { action: "set_password", code: CODE, device: PC1, password: "another pass 2" }), "ACCOUNT_EXISTS");
  assert.equal(admin.createCalls.length, 1);
  // From now on the code alone registers nothing new.
  const next = await call(admin, { action: "claim", code: CODE, device: PC2 });
  assert.equal(next.result.next, "sign_in");
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
});

test("set_password: never overwrites an existing account for the license email", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com", status: "active" })],
    { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }], existingEmails: ["buyer@example.com"] });
  await rejects(call(admin, { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "ACCOUNT_EXISTS");
  assert.equal(admin.db.licenses[0].activated_user_id, null);
});

test("set_password: only from a device registered to the license", async () => {
  await rejects(call(fakeAdmin([lic()]), { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "NOT_BOUND_HERE");
  const bound = fakeAdmin([lic({ status: "active", max_devices: 3 })], { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }] });
  await rejects(call(bound, { action: "set_password", code: CODE, device: PC2, password: "long enough 1" }), "NOT_BOUND_HERE");
  const released = fakeAdmin([lic({ status: "active" })], { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id, released_at: iso(NOW) }] });
  await rejects(call(released, { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "NOT_BOUND_HERE");
  await rejects(call(fakeAdmin([lic({ status: "revoked" })], { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }] }),
    { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "REVOKED");
  assert.equal(bound.createCalls.length, 0);
});

test("set_password: enforces the password policy server-side and never echoes it in errors", async () => {
  const admin = fakeAdmin([lic({ status: "active" })], { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }] });
  for (const bad of ["short", "", "        ", "x".repeat(73), 12345678, null]) {
    await assert.rejects(call(admin, { action: "set_password", code: CODE, device: PC1, password: bad }), (e) => {
      assert.equal(e.code, "WEAK_PASSWORD");
      if (typeof bad === "string" && bad.trim()) assert.ok(!e.message.includes(bad));
      return true;
    });
  }
  assert.equal(admin.createCalls.length, 0);
});

test("non-public actions still require a session", async () => {
  await rejects(call(fakeAdmin([lic()]), { action: "activate", code: CODE, device: PC1 }), "UNAUTHENTICATED");
  await rejects(call(fakeAdmin([lic()]), { action: "list" }), "UNAUTHENTICATED");
  await rejects(call(fakeAdmin([lic()]), { action: "release_device", license_id: LIC_ID, device_id: LIC_ID }), "UNAUTHENTICATED");
  await rejects(call(fakeAdmin([lic()]), null), "UNAUTHENTICATED");
});

test("signed-in activate on a PC set up code-first links the account and takes no new slot", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com", status: "active", max_devices: 2 })],
    { devices: [{ id: uuid(), license_id: LIC_ID, device_id: PC1.id }] });
  const r = await activate(admin, PC1);
  assert.equal(r.result.status, "active");
  assert.equal(admin.db.licenses[0].activated_user_id, BUYER.id);
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
});

test("check refreshes last_seen_at at most once an hour", async () => {
  const admin = buyerLicense(2, { status: "active" });
  admin.db.license_devices.push({ id: uuid(), license_id: LIC_ID, device_id: pc(1).id, released_at: null, last_seen_at: iso(NOW - 2 * 3600000) });
  await check(admin, pc(1));
  assert.equal(admin.db.license_devices[0].last_seen_at, iso(NOW));
  admin.db.license_devices[0].last_seen_at = iso(NOW - 60000);
  await check(admin, pc(1));
  assert.equal(admin.db.license_devices[0].last_seen_at, iso(NOW - 60000), "not touched again within the hour");
});

// ---------------------------------------------------------------------------
// Admin actions (19-20)
// ---------------------------------------------------------------------------

test("create: max_devices defaults to 1, is stored when given, and is validated server-side", async () => {
  const admin = fakeAdmin([], { admins: [ADMIN.id] });
  const one = await as(ADMIN, admin, { action: "create", email: "one@example.com" });
  assert.equal(one.result.license.max_devices, 1);
  assert.equal(one.result.license.active_devices, 0);
  assert.match(one.result.code, CODE_RE);
  const three = await as(ADMIN, admin, { action: "create", email: "three@example.com", max_devices: 3 });
  assert.equal(three.result.license.max_devices, 3);
  assert.equal(admin.db.licenses.find((l) => l.email === "three@example.com").max_devices, 3);
  for (const bad of [0, 101, 2.5, "3", null]) {
    await rejects(as(ADMIN, admin, { action: "create", email: `bad${String(bad)}@example.com`, max_devices: bad }), "VALIDATION");
  }
  await rejects(as(ADMIN, admin, { action: "create", email: "one@example.com", max_devices: 2 }), "EMAIL_HAS_LICENSE");
});

test("list shows email, status, max_devices, active count, devices and timestamps; search matches device labels", async () => {
  const admin = buyerLicense(3);
  await activate(admin, pc(1));
  await activate(admin, pc(2));
  const d2 = admin.activeDevices(LIC_ID).find((d) => d.device_id === pc(2).id);
  await as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: d2.id });
  const [item] = await listed(admin);
  assert.equal(item.email, BUYER.email);
  assert.equal(item.status, "active");
  assert.equal(item.max_devices, 3);
  assert.equal(item.active_devices, 1);
  assert.equal(item.over_limit, false);
  assert.equal(item.devices.length, 2);
  const [first, second] = item.devices;
  assert.equal(first.label, "PC-1");
  assert.equal(first.released_at, null);
  assert.ok(first.first_activated_at && first.last_seen_at);
  assert.ok(second.released_at);
  assert.ok(!("device_id" in first), "full device id is not exposed");
  // Fields kept for the installed License Admin 1.0.11.
  assert.equal(item.activated, true);
  assert.equal(item.device_label, "PC-1");
  const hit = await as(ADMIN, admin, { action: "list", search: "pc-1" });
  assert.equal(hit.result.total, 1);
  const miss = await as(ADMIN, admin, { action: "list", search: "no-such-pc" });
  assert.equal(miss.result.total, 0);
});

test("19: customers cannot use any admin action; an admin change to one license leaves others untouched", async () => {
  const other = lic({ id: "22222222-2222-4222-8222-222222222222", email: "other@example.com", access_code: "BB2D-3FGH-JK4M", status: "active", max_devices: 2 });
  const admin = fakeAdmin([lic({ email: BUYER.email, status: "active", max_devices: 2 }), other], {
    admins: [ADMIN.id],
    devices: [{ id: "33333333-3333-4333-8333-333333333333", license_id: other.id, device_id: pc(8).id }],
  });
  for (const body of [
    { action: "set_max_devices", id: LIC_ID, max_devices: 100 },
    { action: "release_device", license_id: other.id, device_id: "33333333-3333-4333-8333-333333333333" },
    { action: "create", email: "x@example.com", max_devices: 100 },
    { action: "list" },
    { action: "revoke", id: other.id },
    { action: "release", id: other.id },
  ]) {
    await rejects(as(BUYER, admin, body), "FORBIDDEN");
  }
  assert.equal(admin.db.licenses[0].max_devices, 2);
  assert.equal(admin.activeDevices(other.id).length, 1);
  // Smuggling fields into customer actions is refused.
  await rejects(as(BUYER, admin, { action: "activate", code: CODE, device: PC1, max_devices: 100 }), "VALIDATION");
  await rejects(as(BUYER, admin, { action: "check", device: PC1, license_id: other.id }), "VALIDATION");

  await as(ADMIN, admin, { action: "set_max_devices", id: LIC_ID, max_devices: 7 });
  assert.equal(admin.db.licenses[0].max_devices, 7);
  assert.equal(admin.db.licenses[1].max_devices, 2, "the other customer's license is unchanged");
  for (const bad of [0, 101, "5", 1.5]) {
    await rejects(as(ADMIN, admin, { action: "set_max_devices", id: LIC_ID, max_devices: bad }), "VALIDATION");
  }
  await rejects(as(ADMIN, admin, { action: "set_max_devices", id: "99999999-9999-4999-8999-999999999999", max_devices: 2 }), "NOT_FOUND");
});

test("20: release_device only releases a device that belongs to the given license", async () => {
  const other = lic({ id: "22222222-2222-4222-8222-222222222222", email: "other@example.com", access_code: "BB2D-3FGH-JK4M", status: "active" });
  const theirs = "33333333-3333-4333-8333-333333333333";
  const admin = fakeAdmin([lic({ email: BUYER.email, status: "active" }), other], {
    admins: [ADMIN.id],
    devices: [{ id: theirs, license_id: other.id, device_id: pc(8).id }],
  });
  await rejects(as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: theirs }), "DEVICE_NOT_FOUND");
  assert.equal(admin.activeDevices(other.id).length, 1, "the other license's device was not released");
  await rejects(as(ADMIN, admin, { action: "release_device", license_id: LIC_ID, device_id: "not-a-uuid" }), "VALIDATION");
  await rejects(as(ADMIN, admin, { action: "release_device", license_id: "99999999-9999-4999-8999-999999999999", device_id: theirs }), "NOT_FOUND");
  const ok = await as(ADMIN, admin, { action: "release_device", license_id: other.id, device_id: theirs });
  assert.equal(ok.result.license.active_devices, 0);
});

test("legacy release (License Admin <= 1.0.11) releases every device of that license only", async () => {
  const admin = buyerLicense(3);
  for (const n of [1, 2]) await activate(admin, pc(n));
  const r = await as(ADMIN, admin, { action: "release", id: LIC_ID });
  assert.equal(r.result.license.active_devices, 0);
  assert.equal(r.result.license.activated, false);
  assert.equal(admin.db.licenses[0].status, "active", "releasing devices does not un-activate the license");
  assert.equal((await check(admin, pc(1))).status, "not_registered");
  await activate(admin, pc(3));
  assert.equal(admin.activeDevices(LIC_ID).length, 1);
  await rejects(as(ADMIN, fakeAdmin([lic()], { admins: [ADMIN.id] }), { action: "release", id: LIC_ID }), "INVALID_STATE");
});

test("maskEmail hides most of the local part", () => {
  assert.equal(maskEmail("a@x.com"), "a•@x.com");
  assert.equal(maskEmail("jo@x.com"), "j•@x.com");
  assert.equal(maskEmail("buyer@example.com"), "bu•••@example.com");
  assert.equal(maskEmail(""), "");
});
