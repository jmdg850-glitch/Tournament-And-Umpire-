import test from "node:test";
import assert from "node:assert/strict";
import { LicenseCallError, OFFLINE_ALLOWANCE_MS, callLicense, forgetActive, licenseUrl, offlineAllowed, rememberActive } from "./license.js";

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const base = { commandUrl: "https://x.supabase.co/functions/v1/command", publishableKey: "pk", accessToken: "jwt" };

test("license URL sits next to the command function", () => {
  assert.equal(licenseUrl("https://x.supabase.co/functions/v1/command"), "https://x.supabase.co/functions/v1/license");
  assert.equal(licenseUrl("https://x.supabase.co/functions/v1/command/"), "https://x.supabase.co/functions/v1/license");
});

test("callLicense sends the bearer token and action, and returns the result", async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ ok: true, result: { status: "active" } }) }; };
  const r = await callLicense({ ...base, action: "activate", body: { code: "AB2D-3FGH-JK4M", device: { id: "win-x" } }, fetchImpl });
  assert.deepEqual(r, { status: "active" });
  assert.equal(seen.url, "https://x.supabase.co/functions/v1/license");
  assert.equal(seen.init.headers.Authorization, "Bearer jwt");
  assert.deepEqual(JSON.parse(seen.init.body), { action: "activate", code: "AB2D-3FGH-JK4M", device: { id: "win-x" } });
});

test("server rejections keep their code and customer-safe message", async () => {
  const fetchImpl = async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: { code: "ALREADY_ACTIVATED", message: "This license is already activated on another PC." } }) });
  await assert.rejects(callLicense({ ...base, action: "activate", fetchImpl }), (e) => e instanceof LicenseCallError && e.code === "ALREADY_ACTIVATED" && e.status === 409 && /another PC/.test(e.message));
});

test("an unreachable server is reported as NETWORK, and a non-JSON reply as INTERNAL", async () => {
  await assert.rejects(callLicense({ ...base, action: "check", fetchImpl: async () => { throw new TypeError("fetch failed"); } }), (e) => e.code === "NETWORK" && /internet connection/.test(e.message));
  await assert.rejects(callLicense({ ...base, action: "check", fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error("html"); } }) }), (e) => e.code === "INTERNAL");
});

test("offline is allowed only within 7 days of a verified-active check", () => {
  const s = mem();
  const t = 1_800_000_000_000;
  assert.equal(offlineAllowed("u1", t, s), false, "never verified");
  rememberActive("u1", t, s);
  assert.equal(offlineAllowed("u1", t + OFFLINE_ALLOWANCE_MS - 1000, s), true);
  assert.equal(offlineAllowed("u1", t + OFFLINE_ALLOWANCE_MS + 1000, s), false, "allowance elapsed");
  assert.equal(offlineAllowed("u1", t - 24 * 3600 * 1000, s), false, "clock rolled back");
  assert.equal(offlineAllowed("u2", t, s), false, "other account");
  forgetActive("u1", s);
  assert.equal(offlineAllowed("u1", t, s), false);
});
