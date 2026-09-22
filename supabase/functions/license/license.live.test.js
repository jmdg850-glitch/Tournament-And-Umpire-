// LIVE end-to-end test against the REAL production `license` Edge Function and
// database (Supabase project evuvgxruavnadpbiehgb). No mocks.
//
// It uses the Operator's real client module (apps/operator/src/license.js), the
// Operator's real Electron device-id module (this PC's actual Windows machine
// id), and real Supabase Auth sign-in.
//
// Gated. Needs RUN_LIVE_LICENSE_TESTS=1 and pre-created, email-confirmed test
// accounts (Auth on this project requires email confirmation):
//   LICENSE_TEST_RUN, LICENSE_TEST_PASSWORD, LICENSE_TEST_EMAIL_BASE,
//   LICENSE_TEST_ADMIN_EMAIL, LICENSE_TEST_ADMIN_PASSWORD
// with customers <base+lictest-<RUN>-a|b|c@...> and an admin in license_admins.

import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { LicenseCallError, callLicense } from "../../../apps/operator/src/license.js";

const require = createRequire(import.meta.url);
const { getLicenseDevice } = require("../../../apps/operator/electron/licenseDevice.cjs");

function loadEnv(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (!line || line.startsWith("#") || i < 1) continue;
    const k = line.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
}
loadEnv(fileURLToPath(new URL("../../../apps/operator/.env.local", import.meta.url)));

const E = process.env;
const url = E.VITE_SUPABASE_URL;
const anon = E.VITE_SUPABASE_PUBLISHABLE_KEY;
const live = Boolean(E.RUN_LIVE_LICENSE_TESTS === "1" && url && anon && E.LICENSE_TEST_RUN && E.LICENSE_TEST_PASSWORD
  && E.LICENSE_TEST_ADMIN_EMAIL && E.LICENSE_TEST_ADMIN_PASSWORD && E.LICENSE_TEST_EMAIL_BASE);

const COMMAND_URL = `${url}/functions/v1/command`;   // the apps derive .../license from this
const LICENSE_URL = `${url}/functions/v1/license`;
const RUN = E.LICENSE_TEST_RUN;
const [BASE_LOCAL, BASE_DOMAIN] = (E.LICENSE_TEST_EMAIL_BASE || "x@y").split("@");
const emailOf = (tag) => `${BASE_LOCAL}+lictest-${RUN}-${tag}@${BASE_DOMAIN}`;
const CODE_RE = /^[2-9A-HJKMNP-TV-Z]{4}(-[2-9A-HJKMNP-TV-Z]{4}){2}$/;

async function signIn(email, password) {
  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, token: data.session.access_token, email, userId: data.user.id };
}

// Exactly what the Operator's gate does: callLicense(check|activate) with a device.
const op = (user) => ({
  check: (device) => callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: user.token, action: "check", body: { device } }),
  activate: (code, device) => callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: user.token, action: "activate", body: { code, device } }),
});
const asAdmin = (action, body = {}) => callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: admin.token, action, body });

async function rejects(promise, code, status, message) {
  let err;
  try { await promise; } catch (e) { err = e; }
  assert.ok(err instanceof LicenseCallError, `expected ${code}, got success`);
  assert.equal(err.code, code, `${err.code}: ${err.message}`);
  if (status) assert.equal(err.status, status);
  if (message) assert.equal(err.message, message);
  return err;
}

const toDevice = (d) => ({ id: d.deviceId, label: d.label });
const fakePc = async (name, guid) => toDevice(await getLicenseDevice({ userDataDir: mkdtempSync(join(tmpdir(), "pc-")), hostname: name, readGuid: async () => guid }));

let admin, A, B, C, PC1, PC1_reinstalled, PC2, PC3;
const state = {};

describe("LIVE: email -> one code -> one PC (production)", { skip: !live }, () => {
  before(async () => {
    admin = await signIn(E.LICENSE_TEST_ADMIN_EMAIL, E.LICENSE_TEST_ADMIN_PASSWORD);
    [A, B, C] = await Promise.all([signIn(emailOf("a"), E.LICENSE_TEST_PASSWORD), signIn(emailOf("b"), E.LICENSE_TEST_PASSWORD), signIn(emailOf("c"), E.LICENSE_TEST_PASSWORD)]);
    // PC #1 is THIS computer, via the real Electron device module (real MachineGuid).
    PC1 = toDevice(await getLicenseDevice({ userDataDir: mkdtempSync(join(tmpdir(), "pc1-")) }));
    // A reinstall wipes userData; the id must not change.
    PC1_reinstalled = toDevice(await getLicenseDevice({ userDataDir: mkdtempSync(join(tmpdir(), "pc1b-")) }));
    PC2 = await fakePc("REPLACEMENT-PC", "aaaaaaaa-1111-2222-3333-444444444444");
    PC3 = await fakePc("THIRD-PC", "bbbbbbbb-1111-2222-3333-444444444444");
    console.log(`[live] run ${RUN}; PC1 id ${PC1.id.slice(0, 12)}… label "${PC1.label}"`);
  });

  describe("security basics", () => {
    it("no token / bad token -> 401, GET -> 405", async () => {
      for (const auth of [undefined, "Bearer ", "Bearer not-a-jwt", `Bearer ${anon}`]) {
        const res = await fetch(LICENSE_URL, { method: "POST", headers: { "Content-Type": "application/json", apikey: anon, ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify({ action: "whoami" }) });
        assert.equal(res.status, 401);
        assert.equal((await res.json()).error.code, "UNAUTHENTICATED");
      }
      assert.equal((await fetch(LICENSE_URL, { method: "GET", headers: { apikey: anon } })).status, 405);
    });

    it("a customer cannot use ANY admin action (403), even smuggling an admin flag", async () => {
      for (const action of ["whoami", "create", "list", "revoke", "release"]) {
        await rejects(callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: A.token, action, body: {} }), "FORBIDDEN", 403);
      }
      await rejects(callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: A.token, action: "create", body: { email: emailOf("b"), admin: true } }), "FORBIDDEN", 403);
    });

    it("tampered customer payloads are rejected (400) and change nothing", async () => {
      for (const extra of [{ status: "active" }, { email: emailOf("b") }, { role: "admin" }, { device_id: "x" }]) {
        await rejects(callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: A.token, action: "activate", body: { code: "AAAA-BBBB-CCCC", device: PC1, ...extra } }), "VALIDATION", 400);
      }
      await rejects(op(A).check({ id: "x" }), "VALIDATION", 400);           // bad device
      await rejects(op(A).check(null), "VALIDATION", 400);
      await rejects(callLicense({ commandUrl: COMMAND_URL, publishableKey: anon, accessToken: A.token, action: "drop_everything" }), "UNKNOWN_ACTION", 400);
    });

    it("clients cannot read or write the license tables directly (RLS)", async () => {
      const anonClient = createClient(url, anon, { auth: { persistSession: false } });
      for (const client of [A.client, anonClient]) {
        assert.ok((await client.from("licenses").select("*")).error, "select must be denied");
        assert.ok((await client.from("licenses").select("access_code")).error, "codes must be unreadable");
        assert.ok((await client.from("licenses").insert({ email: "x@y.com", access_code: "AAAA-BBBB-CCCC" })).error, "insert must be denied");
        assert.ok((await client.from("licenses").update({ status: "unused" }).neq("id", crypto.randomUUID())).error, "update must be denied");
        assert.ok((await client.from("license_admins").select("*")).error, "admin list must be denied");
      }
    });
  });

  describe("admin: generate and view", () => {
    it("admin is recognised server-side", async () => {
      assert.equal((await asAdmin("whoami")).admin, true);
    });

    it("validates input: bad email, past expiry, stray fields", async () => {
      await rejects(asAdmin("create", { email: "not-an-email" }), "VALIDATION", 400);
      await rejects(asAdmin("create", { email: emailOf("a"), expires_at: new Date(Date.now() - 86400000).toISOString() }), "VALIDATION", 400);
      await rejects(asAdmin("create", { email: emailOf("a"), status: "active" }), "VALIDATION", 400);
      await rejects(asAdmin("create", { email: emailOf("a"), access_code: "AAAA-BBBB-CCCC" }), "VALIDATION", 400);
    });

    it("generates ONE readable code for a customer email", async () => {
      const res = await asAdmin("create", { email: `  ${emailOf("a").toUpperCase()} ` });
      assert.match(res.code, CODE_RE);
      assert.equal(res.license.email, emailOf("a"), "email stored normalised");
      assert.equal(res.license.status, "unused");
      assert.equal(res.license.activated, false);
      state.codeA = res.code;
      state.idA = res.license.id;
    });

    it("ONE email -> ONE license: a second live code for the same email is refused", async () => {
      await rejects(asAdmin("create", { email: emailOf("a") }), "EMAIL_HAS_LICENSE", 409);
    });

    it("the list shows email, code, status, PC, created date, and supports search", async () => {
      const all = await asAdmin("list");
      const row = all.items.find((l) => l.id === state.idA);
      assert.ok(row);
      assert.equal(row.email, emailOf("a"));
      assert.equal(row.code, state.codeA);
      assert.equal(row.activated, false);
      assert.equal(row.device_label, null);
      assert.ok(row.created_at);
      assert.equal((await asAdmin("list", { search: emailOf("a") })).items.length, 1);
      assert.equal((await asAdmin("list", { search: state.codeA.toLowerCase().replaceAll("-", " ") })).items[0]?.id, state.idA);
      assert.equal((await asAdmin("list", { search: "zzzz-no-such-customer" })).items.length, 0);
    });
  });

  describe("customer: wrong email / wrong code / malformed", () => {
    it("customer A sees a license exists for their email but is not activated", async () => {
      assert.equal((await op(A).check(PC1)).status, "unused");
    });

    it("customer B (a different email) has no license", async () => {
      assert.equal((await op(B).check(PC1)).status, "none");
    });

    it("WRONG EMAIL: B cannot activate A's code (rejected, A's license untouched)", async () => {
      await rejects(op(B).activate(state.codeA, PC2), "INVALID_CODE", 404, "This access code is not valid for this account.");
      const row = (await asAdmin("list", { search: emailOf("a") })).items[0];
      assert.equal(row.activated, false);
    });

    it("WRONG CODE: a well-formed but unknown code is rejected", async () => {
      const wrong = state.codeA.slice(0, -1) + (state.codeA.endsWith("2") ? "3" : "2");
      await rejects(op(A).activate(wrong, PC1), "INVALID_CODE", 404, "This access code is not valid for this account.");
      await rejects(op(A).activate("2222-3333-4444", PC1), "INVALID_CODE", 404);
    });

    it("MALFORMED: truncated, ambiguous-character, junk and empty codes are rejected", async () => {
      for (const bad of ["", "hello", "ABCD-1234", "ABCD-1234-WXY", "0BCD-1234-WXYZ", "ABCD-1234-WXYZ-9999", "'; drop table licenses;--"]) {
        await rejects(op(A).activate(bad, PC1), "INVALID_CODE_FORMAT", 400, "Invalid access code format.");
      }
    });
  });

  describe("first PC binds; second PC is rejected", () => {
    it("PC #1 (this computer) activates with the correct code (case/spacing tolerated)", async () => {
      const messy = `  ${state.codeA.toLowerCase().replaceAll("-", " ")}  `;
      const r = await op(A).activate(messy, PC1);
      assert.equal(r.status, "active");
      assert.equal(r.email, emailOf("a"));
      assert.ok(r.activated_at);
      assert.ok(!JSON.stringify(r).includes(state.codeA), "the response never echoes the code");
    });

    it("the license is now bound to that PC, and the admin can see it", async () => {
      const row = (await asAdmin("list", { search: emailOf("a") })).items[0];
      assert.equal(row.activated, true);
      assert.equal(row.status, "active");
      assert.equal(row.device_label, PC1.label);
      assert.ok(row.activated_at);
    });

    it("SAME PC relaunch: check and re-activate both succeed", async () => {
      assert.equal((await op(A).check(PC1)).status, "active");
      assert.equal((await op(A).activate(state.codeA, PC1)).status, "active");
    });

    it("SAME PC after a reinstall (userData wiped) is recognised as the same PC", async () => {
      assert.equal(PC1_reinstalled.id, PC1.id);
      assert.equal((await op(A).check(PC1_reinstalled)).status, "active");
    });

    it("SAME email + SAME code on a SECOND PC is rejected with the exact message", async () => {
      await rejects(op(A).activate(state.codeA, PC2), "ALREADY_ACTIVATED", 409, "This license is already activated on another PC.");
      const view = await op(A).check(PC2);
      assert.equal(view.status, "other_device");
      assert.equal(view.message, "This license is already activated on another PC.");
    });

    it("the rejected attempt did not move the binding", async () => {
      const row = (await asAdmin("list", { search: emailOf("a") })).items[0];
      assert.equal(row.device_label, PC1.label);
      assert.equal((await op(A).check(PC1)).status, "active");
    });
  });

  describe("admin release, then replacement PC", () => {
    it("admin releases the PC binding", async () => {
      const r = await asAdmin("release", { id: state.idA });
      assert.equal(r.license.status, "unused");
      assert.equal(r.license.activated, false);
      assert.equal(r.license.device_label, null);
      assert.equal(r.license.code, state.codeA, "the code itself is unchanged");
      await rejects(asAdmin("release", { id: state.idA }), "INVALID_STATE", 409); // nothing left to release
    });

    it("the old PC is now unlicensed and the customer can activate the replacement PC", async () => {
      assert.equal((await op(A).check(PC1)).status, "unused");
      const r = await op(A).activate(state.codeA, PC2);
      assert.equal(r.status, "active");
      assert.equal((await asAdmin("list", { search: emailOf("a") })).items[0].device_label, "REPLACEMENT-PC");
    });

    it("...and the ORIGINAL PC is now rejected", async () => {
      await rejects(op(A).activate(state.codeA, PC1), "ALREADY_ACTIVATED", 409, "This license is already activated on another PC.");
      assert.equal((await op(A).check(PC1)).status, "other_device");
    });
  });

  describe("forgot password does not touch the license", () => {
    it("Supabase Auth accepts a password-reset request for the customer's email", async (t) => {
      const anonClient = createClient(url, anon, { auth: { persistSession: false } });
      const { error } = await anonClient.auth.resetPasswordForEmail(emailOf("a"), { redirectTo: "https://tournament-operator.vercel.app" });
      // This project sends mail through Supabase's built-in sender, which has a tiny project-wide
      // hourly cap. When it is exhausted the request cannot be verified: report that, don't fake a pass.
      if (error?.code === "over_email_send_rate_limit") return t.skip("NOT VERIFIED: Supabase email rate limit exceeded (configure custom SMTP)");
      // Delivery of the email cannot be observed from here; the request being accepted is what is verified.
      assert.equal(error, null, error?.message);
    });

    it("completing a password change (what the reset link does) leaves the license and PC binding intact", async () => {
      const before = (await asAdmin("list", { search: emailOf("a") })).items[0];
      const newPassword = `${E.LICENSE_TEST_PASSWORD}-new`;
      const { error } = await A.client.auth.updateUser({ password: newPassword });
      assert.equal(error, null, error?.message);
      const A2 = await signIn(emailOf("a"), newPassword);       // sign in with the NEW password
      const view = await op(A2).check(PC2);
      assert.equal(view.status, "active");
      const afterRow = (await asAdmin("list", { search: emailOf("a") })).items[0];
      assert.equal(afterRow.id, before.id);
      assert.equal(afterRow.code, before.code, "no new code was generated");
      assert.equal(afterRow.device_label, before.device_label, "binding unchanged");
      assert.equal(afterRow.activated_at, before.activated_at);
      assert.equal((await asAdmin("list")).items.filter((l) => l.email === emailOf("a")).length, 1, "still exactly one license");
      A.token = A2.token; A.client = A2.client;
    });
  });

  describe("revoked license", () => {
    it("admin revokes; the customer is rejected on the bound PC and cannot activate", async () => {
      const r = await asAdmin("revoke", { id: state.idA });
      assert.equal(r.license.status, "revoked");
      const view = await op(A).check(PC2);
      assert.equal(view.status, "revoked");
      assert.equal(view.message, "This license has been revoked.");
      await rejects(op(A).activate(state.codeA, PC2), "REVOKED", 403, "This license has been revoked.");
      await rejects(op(A).activate(state.codeA, PC3), "REVOKED", 403);
      await rejects(asAdmin("revoke", { id: state.idA }), "INVALID_STATE", 409);
      await rejects(asAdmin("release", { id: state.idA }), "INVALID_STATE", 409);
      await rejects(asAdmin("revoke", { id: crypto.randomUUID() }), "NOT_FOUND", 404);
      await rejects(asAdmin("revoke", { id: "not-a-uuid" }), "VALIDATION", 400);
    });

    it("a revoked license frees the email: a fresh code can be issued and works on a new PC", async () => {
      const fresh = await asAdmin("create", { email: emailOf("a") });
      assert.notEqual(fresh.code, state.codeA);
      assert.equal((await op(A).check(PC3)).status, "unused", "the live (non-revoked) license wins");
      assert.equal((await op(A).activate(fresh.code, PC3)).status, "active");
      await rejects(op(A).activate(state.codeA, PC3), "REVOKED", 403, "This license has been revoked."); // the old code stays dead
    });
  });

  describe("race and expiry (customer C)", () => {
    it("two PCs activating the same fresh license at the same moment: exactly one wins", async () => {
      const made = await asAdmin("create", { email: emailOf("c") });
      const results = await Promise.allSettled([op(C).activate(made.code, PC2), op(C).activate(made.code, PC3)]);
      const wins = results.filter((r) => r.status === "fulfilled").length;
      const losses = results.filter((r) => r.status === "rejected" && r.reason.code === "ALREADY_ACTIVATED").length;
      assert.equal(wins, 1, JSON.stringify(results.map((r) => r.status)));
      assert.equal(losses, 1);
      state.idC = made.license.id;
      await asAdmin("revoke", { id: made.license.id });
    });

    it("an expired license is rejected", async () => {
      const expiresMs = Date.now() + 25000;
      const made = await asAdmin("create", { email: emailOf("c"), expires_at: new Date(expiresMs).toISOString() });
      assert.equal((await asAdmin("list", { search: emailOf("c") })).items.find((l) => l.id === made.license.id).expired, false);
      await new Promise((r) => setTimeout(r, Math.max(0, expiresMs - Date.now()) + 1500));
      await rejects(op(C).activate(made.code, PC2), "EXPIRED", 403, "This license has expired.");
      const view = await op(C).check(PC2);
      assert.equal(view.status, "expired");
      assert.equal((await asAdmin("list", { search: emailOf("c") })).items.find((l) => l.id === made.license.id).expired, true);
      await asAdmin("revoke", { id: made.license.id });
    });
  });

  after(() => { console.log(`[live] done. Cleanup pattern: email like '%+lictest-%'`); });
});
