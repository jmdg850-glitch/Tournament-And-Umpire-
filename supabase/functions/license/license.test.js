import test from "node:test";
import assert from "node:assert/strict";
import { LicenseError, customerView, decideActivation, generateCode, normalizeCode, normalizeEmail, validateDevice } from "./license.js";

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
