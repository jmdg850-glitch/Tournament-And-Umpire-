import test from "node:test";
import assert from "node:assert/strict";
import { LicenseError, customerView, decideActivation, generateCode, handleLicense, maskEmail, normalizeCode, normalizeEmail, validateDevice } from "./license.js";

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

const lic = (over = {}) => ({ id: "1", email: "a@b.com", access_code: "AB2D-3FGH-JK4M", status: "unused", device_id: null, expires_at: null, ...over });

test("first activation binds; the same PC again is fine; a second PC is rejected", () => {
  assert.deepEqual(decideActivation({ license: lic(), deviceId: "pc-1-aaaaaaaa", now: NOW }), { ok: true, action: "bind" });
  const bound = lic({ status: "active", device_id: "pc-1-aaaaaaaa" });
  assert.deepEqual(decideActivation({ license: bound, deviceId: "pc-1-aaaaaaaa", now: NOW }), { ok: true, action: "already_here" });
  assert.deepEqual(decideActivation({ license: bound, deviceId: "pc-2-bbbbbbbb", now: NOW }), { ok: false, code: "ALREADY_ACTIVATED" });
});

test("wrong code / wrong email (no matching license) is rejected", () => {
  assert.deepEqual(decideActivation({ license: null, deviceId: "pc-1-aaaaaaaa", now: NOW }), { ok: false, code: "INVALID_CODE" });
});

test("revoked and expired licenses are rejected, even on the bound PC", () => {
  const bound = { status: "active", device_id: "pc-1-aaaaaaaa" };
  assert.equal(decideActivation({ license: lic({ status: "revoked" }), deviceId: "pc-1-aaaaaaaa", now: NOW }).code, "REVOKED");
  assert.equal(decideActivation({ license: lic({ ...bound, status: "revoked" }), deviceId: "pc-1-aaaaaaaa", now: NOW }).code, "REVOKED");
  assert.equal(decideActivation({ license: lic({ expires_at: iso(NOW - 1) }), deviceId: "pc-1-aaaaaaaa", now: NOW }).code, "EXPIRED");
  assert.equal(decideActivation({ license: lic({ ...bound, expires_at: iso(NOW - DAY) }), deviceId: "pc-1-aaaaaaaa", now: NOW }).code, "EXPIRED");
  assert.equal(decideActivation({ license: lic({ expires_at: iso(NOW + DAY) }), deviceId: "pc-1-aaaaaaaa", now: NOW }).ok, true);
});

test("after an admin release the license is unbound and a replacement PC can bind", () => {
  const released = lic({ status: "unused", device_id: null });
  assert.deepEqual(decideActivation({ license: released, deviceId: "pc-2-bbbbbbbb", now: NOW }), { ok: true, action: "bind" });
});

test("customerView tells the app the truth and never leaks the code", () => {
  const bound = lic({ status: "active", device_id: "pc-1-aaaaaaaa", activated_at: iso(NOW) });
  assert.equal(customerView(bound, "pc-1-aaaaaaaa", NOW).status, "active");
  assert.equal(customerView(bound, "pc-2-bbbbbbbb", NOW).status, "other_device");
  assert.match(customerView(bound, "pc-2-bbbbbbbb", NOW).message, /already activated on another PC/);
  assert.equal(customerView(lic(), "pc-1-aaaaaaaa", NOW).status, "unused");
  assert.equal(customerView(lic({ status: "revoked" }), "pc-1-aaaaaaaa", NOW).status, "revoked");
  assert.equal(customerView(lic({ expires_at: iso(NOW - 1) }), "pc-1-aaaaaaaa", NOW).status, "expired");
  assert.equal(customerView(null, "pc-1-aaaaaaaa", NOW).status, "none");
  assert.ok(!JSON.stringify(customerView(bound, "pc-1-aaaaaaaa", NOW)).includes("AB2D"));
});

// ---------------------------------------------------------------------------
// Code-first setup: claim (bind) → set_password (create the buyer's account)
// ---------------------------------------------------------------------------

// Minimal in-memory stand-in for the service-role client: just the query
// shapes license.js uses (select/eq/is/maybeSingle, update/eq/is/select) plus
// auth.admin.createUser. Records every createUser call for assertions.
function fakeAdmin(rows, { existingEmails = [] } = {}) {
  const db = { licenses: rows.map((r) => ({ ...r })) };
  const users = new Map(existingEmails.map((e, i) => [e, { id: `existing-${i}`, email: e }]));
  const createCalls = [];
  function query(table) {
    const filters = [];
    let patch = null;
    const match = (r) => filters.every(([k, v]) => r[k] === v);
    const api = {
      select() { return api; },
      update(p) { patch = p; return api; },
      eq(k, v) { filters.push([k, v]); return api; },
      is(k, v) { filters.push([k, v]); return api; },
      order() { return api; },
      async maybeSingle() { return { data: db[table].find(match) || null, error: null }; },
      then(resolve, reject) {
        let result;
        if (patch) {
          const hit = db[table].filter(match);
          for (const r of hit) Object.assign(r, patch);
          result = { data: hit.map((r) => ({ ...r })), error: null };
        } else {
          result = { data: db[table].filter(match), error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return api;
  }
  return {
    db, users, createCalls,
    from: query,
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

const PC1 = { id: "win-pc1-aaaaaaaaaa", label: "FRONT-DESK" };
const PC2 = { id: "win-pc2-bbbbbbbbbb", label: "OTHER" };
const CODE = "AB2D-3FGH-JK4M";
const call = (admin, body) => handleLicense({ admin, actor: null, body, now: NOW });
const rejects = (p, code) => assert.rejects(p, (e) => e instanceof LicenseError && e.code === code);

test("claim: a valid code binds the license to this PC, then asks for a password (no session needed)", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com" })]);
  const r = await call(admin, { action: "claim", code: "ab2d 3fgh jk4m", device: PC1 });
  assert.equal(r.ok, true);
  assert.equal(r.result.status, "active");
  assert.equal(r.result.bound, "now");
  assert.equal(r.result.next, "set_password");
  assert.equal(r.result.email, "buyer@example.com");
  assert.equal(r.result.email_masked, "bu•••@example.com");
  assert.ok(!JSON.stringify(r.result).includes(CODE), "never echoes the code");
  assert.equal(admin.db.licenses[0].device_id, PC1.id);
  assert.equal(admin.db.licenses[0].activated_user_id, null);
});

test("claim: already bound to THIS PC without an account → continue password setup (not a fresh activation)", async () => {
  const admin = fakeAdmin([lic({ status: "active", device_id: PC1.id, activated_user_id: null })]);
  const r = await call(admin, { action: "claim", code: CODE, device: PC1 });
  assert.equal(r.result.bound, "already_here");
  assert.equal(r.result.next, "set_password");
});

test("claim: already bound here with an account → sign in", async () => {
  const admin = fakeAdmin([lic({ status: "active", device_id: PC1.id, activated_user_id: "user-9" })]);
  const r = await call(admin, { action: "claim", code: CODE, device: PC1 });
  assert.equal(r.result.next, "sign_in");
});

test("claim: rejects another PC, revoked, expired, unknown and malformed codes", async () => {
  await rejects(call(fakeAdmin([lic({ status: "active", device_id: PC1.id })]), { action: "claim", code: CODE, device: PC2 }), "ALREADY_ACTIVATED");
  await rejects(call(fakeAdmin([lic({ status: "revoked" })]), { action: "claim", code: CODE, device: PC1 }), "REVOKED");
  await rejects(call(fakeAdmin([lic({ expires_at: iso(NOW - 1) })]), { action: "claim", code: CODE, device: PC1 }), "EXPIRED");
  await rejects(call(fakeAdmin([]), { action: "claim", code: CODE, device: PC1 }), "UNKNOWN_CODE");
  await rejects(call(fakeAdmin([]), { action: "claim", code: "nope", device: PC1 }), "INVALID_CODE_FORMAT");
  await rejects(call(fakeAdmin([lic()]), { action: "claim", code: CODE, device: { id: "x" } }), "VALIDATION");
  await rejects(call(fakeAdmin([lic()]), { action: "claim", code: CODE, device: PC1, email: "x@y.com" }), "VALIDATION");
});

test("set_password: after binding, creates the buyer's own confirmed account and links it", async () => {
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
});

test("set_password: never overwrites an existing account for the license email", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com", status: "active", device_id: PC1.id })], { existingEmails: ["buyer@example.com"] });
  await rejects(call(admin, { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "ACCOUNT_EXISTS");
  assert.equal(admin.db.licenses[0].activated_user_id, undefined);
});

test("set_password: only from the PC the license is bound to, and only after binding", async () => {
  await rejects(call(fakeAdmin([lic()]), { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "NOT_BOUND_HERE");
  const bound = fakeAdmin([lic({ status: "active", device_id: PC1.id })]);
  await rejects(call(bound, { action: "set_password", code: CODE, device: PC2, password: "long enough 1" }), "ALREADY_ACTIVATED");
  await rejects(call(fakeAdmin([lic({ status: "revoked", device_id: PC1.id })]), { action: "set_password", code: CODE, device: PC1, password: "long enough 1" }), "REVOKED");
  assert.equal(bound.createCalls.length, 0);
});

test("set_password: enforces the password policy server-side and never echoes it in errors", async () => {
  const admin = fakeAdmin([lic({ status: "active", device_id: PC1.id })]);
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
  await rejects(call(fakeAdmin([lic()]), null), "UNAUTHENTICATED");
});

test("signed-in activate on a PC claimed code-first links the account instead of failing", async () => {
  const admin = fakeAdmin([lic({ email: "buyer@example.com", status: "active", device_id: PC1.id, activated_user_id: null })]);
  const actor = { id: "user-7", email: "buyer@example.com", emailConfirmed: true };
  const r = await handleLicense({ admin, actor, body: { action: "activate", code: CODE, device: PC1 }, now: NOW });
  assert.equal(r.result.status, "active");
  assert.equal(admin.db.licenses[0].activated_user_id, "user-7");
});

test("maskEmail hides most of the local part", () => {
  assert.equal(maskEmail("a@x.com"), "a•@x.com");
  assert.equal(maskEmail("jo@x.com"), "j•@x.com");
  assert.equal(maskEmail("buyer@example.com"), "bu•••@example.com");
  assert.equal(maskEmail(""), "");
});
