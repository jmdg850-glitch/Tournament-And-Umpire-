// Simple licensing: ONE customer email -> ONE access code -> ONE PC.
//
// Runs inside the `license` Edge Function (Deno) with a service-role Supabase
// client; the same file is unit-tested under Node. No dependencies.
//
// Trust model:
//  - The caller's identity (id + email) comes only from the verified Supabase
//    JWT, never from the request body.
//  - A customer can activate only a code issued to THEIR OWN verified email.
//    Knowing someone else's code is useless without owning that mailbox.
//  - Admin actions require a row in public.license_admins, checked on every call.
//  - Code-first setup (claim / set_password) needs no session: possession of
//    the admin-issued access code is the proof. It binds the code's license to
//    this PC and may create the Supabase Auth account for the license's email
//    (password hashed by Supabase Auth) — but never overwrites an existing
//    account's password, and only from the PC the license is bound to.
//  - The database is only reachable through this function (RLS: no client grants).

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 symbols: no 0/1/I/L/O/U
const CODE_GROUPS = 3;
const GROUP_LEN = 4;
const CODE_LEN = CODE_GROUPS * GROUP_LEN;

export const ERRORS = {
  UNAUTHENTICATED: [401, "Please sign in to continue."],
  FORBIDDEN: [403, "You do not have access to this resource."],
  VALIDATION: [400, "The request contains invalid data."],
  UNKNOWN_ACTION: [400, "Unknown action."],
  METHOD_NOT_ALLOWED: [405, "Method not allowed."],
  EMAIL_NOT_VERIFIED: [403, "Please confirm your email address before activating a license."],
  INVALID_CODE_FORMAT: [400, "Invalid access code format."],
  INVALID_CODE: [404, "This access code is not valid for this account."],
  UNKNOWN_CODE: [404, "This access code is not valid."],
  ACCOUNT_EXISTS: [409, "An account already exists for this license. Sign in with its password, or reset it."],
  WEAK_PASSWORD: [400, "Choose a password of 8 to 72 characters."],
  NOT_BOUND_HERE: [409, "Activate this access code on this PC first."],
  REVOKED: [403, "This license has been revoked."],
  EXPIRED: [403, "This license has expired."],
  ALREADY_ACTIVATED: [409, "This license is already activated on another PC."],
  EMAIL_HAS_LICENSE: [409, "This email already has a license. Revoke it first to issue a new one."],
  NOT_FOUND: [404, "License not found."],
  INVALID_STATE: [409, "That change is not allowed for this license's current status."],
  GENERATION_FAILED: [500, "LICENSE GENERATION FAILED"],
  INTERNAL: [500, "Something went wrong. Please try again."],
};

export class LicenseError extends Error {
  constructor(code, detail) {
    const [status, message] = ERRORS[code] || ERRORS.INTERNAL;
    super(detail || message);
    this.name = "LicenseError";
    this.code = ERRORS[code] ? code : "INTERNAL";
    this.status = status;
    this.publicMessage = message;
  }
}

// ---------------------------------------------------------------------------
// Codes, emails, devices
// ---------------------------------------------------------------------------

function randomBytes(n) {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

// Cryptographically secure XXXX-XXXX-XXXX. Bytes >= 240 are discarded so the
// 30-symbol alphabet is sampled without modulo bias.
export function generateCode(random = randomBytes) {
  const limit = 256 - (256 % ALPHABET.length);
  let body = "";
  while (body.length < CODE_LEN) {
    for (const b of random(CODE_LEN * 2)) {
      if (b >= limit) continue;
      body += ALPHABET[b % ALPHABET.length];
      if (body.length === CODE_LEN) break;
    }
  }
  return formatCode(body);
}

function formatCode(body) {
  const parts = [];
  for (let i = 0; i < CODE_GROUPS; i++) parts.push(body.slice(i * GROUP_LEN, (i + 1) * GROUP_LEN));
  return parts.join("-");
}

// Accepts harmless variation (case, surrounding whitespace, missing/extra
// separators). Returns the canonical code, or null. Never "fixes" ambiguous
// characters or short/long input.
export function normalizeCode(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 40) return null;
  const body = input.trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (body.length !== CODE_LEN) return null;
  for (const ch of body) if (!ALPHABET.includes(ch)) return null;
  return formatCode(body);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(input) {
  if (typeof input !== "string") return null;
  const e = input.trim().toLowerCase();
  return e.length >= 3 && e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

// Device = a stable install/machine identifier. The label (computer name) is
// display-only and is never used to decide anything.
export function validateDevice(device) {
  const bad = () => new LicenseError("VALIDATION", "invalid device");
  if (!device || typeof device !== "object" || Array.isArray(device)) throw bad();
  if (typeof device.id !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(device.id)) throw bad();
  const label = typeof device.label === "string" ? device.label.trim().slice(0, 80) : "";
  return { id: device.id, label };
}

// ---------------------------------------------------------------------------
// The one decision every activation goes through
// ---------------------------------------------------------------------------

export function isExpired(license, now) {
  if (!license.expires_at) return false;
  const t = Date.parse(license.expires_at);
  return Number.isFinite(t) && t <= now;
}

// -> { ok: true, action: "bind" | "already_here" } | { ok: false, code }
export function decideActivation({ license, deviceId, now }) {
  if (!license) return { ok: false, code: "INVALID_CODE" };
  if (license.status === "revoked") return { ok: false, code: "REVOKED" };
  if (isExpired(license, now)) return { ok: false, code: "EXPIRED" };
  if (license.status === "active") {
    return license.device_id === deviceId ? { ok: true, action: "already_here" } : { ok: false, code: "ALREADY_ACTIVATED" };
  }
  return { ok: true, action: "bind" };
}

// What a customer app is told about its license (never the code itself).
export function customerView(license, deviceId, now) {
  if (!license) return { status: "none" };
  let status = license.status;
  if (status === "revoked") { /* stays revoked */ }
  else if (isExpired(license, now)) status = "expired";
  else if (status === "active" && license.device_id !== deviceId) status = "other_device";
  const messages = {
    revoked: ERRORS.REVOKED[1], expired: ERRORS.EXPIRED[1], other_device: ERRORS.ALREADY_ACTIVATED[1],
  };
  return {
    status,
    ...(messages[status] ? { message: messages[status] } : {}),
    email: license.email,
    activated_at: license.activated_at,
    expires_at: license.expires_at,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const CUSTOMER_ACTIONS = { activate: ["code", "device"], check: ["device"] };
// No session required — the access code itself authorizes these.
const PUBLIC_ACTIONS = { claim: ["code", "device"], set_password: ["code", "device", "password"] };
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 72; // bcrypt's input limit in Supabase Auth
const ADMIN_ACTIONS = {
  whoami: [],
  create: ["email", "expires_at"],
  list: ["search"],
  revoke: ["id"],
  release: ["id"],
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function dbFail(error, what) {
  console.error(`[license] ${what}:`, error?.code, error?.message);
  return new LicenseError("INTERNAL", `database error during ${what}`);
}

function assertOnlyFields(body, allowed) {
  for (const k of Object.keys(body)) {
    if (k !== "action" && !allowed.includes(k)) throw new LicenseError("VALIDATION", `unexpected field: ${k}`);
  }
}

async function requireAdmin(admin, actor) {
  const { data, error } = await admin.from("license_admins").select("user_id").eq("user_id", actor.id).maybeSingle();
  if (error) throw dbFail(error, "admin check");
  if (!data) throw new LicenseError("FORBIDDEN");
}

function requireVerifiedEmail(actor) {
  const email = normalizeEmail(actor.email || "");
  if (!email || !actor.emailConfirmed) throw new LicenseError("EMAIL_NOT_VERIFIED");
  return email;
}

// ----- customer -----

async function findByEmailAndCode(admin, email, code) {
  const { data, error } = await admin.from("licenses").select("*").eq("email", email).eq("access_code", code).maybeSingle();
  if (error) throw dbFail(error, "license lookup");
  return data;
}

async function activate({ admin, actor, body, now }) {
  const email = requireVerifiedEmail(actor);
  const code = normalizeCode(body.code);
  if (!code) throw new LicenseError("INVALID_CODE_FORMAT");
  const device = validateDevice(body.device);

  let license = await findByEmailAndCode(admin, email, code);
  for (let attempt = 0; attempt < 2; attempt++) {
    const d = decideActivation({ license, deviceId: device.id, now });
    if (!d.ok) throw new LicenseError(d.code);
    if (d.action === "already_here") {
      // Bound by a code-first claim before this account existed: link it now.
      if (!license.activated_user_id) {
        const { error } = await admin.from("licenses").update({ activated_user_id: actor.id })
          .eq("id", license.id).is("activated_user_id", null);
        if (error) throw dbFail(error, "account link");
      }
      return customerView(license, device.id, now);
    }

    // Atomic first-activation bind: only succeeds while still unbound, so two
    // PCs racing for the same license can never both win.
    const { data, error } = await admin.from("licenses").update({
      status: "active", device_id: device.id, device_label: device.label || null,
      activated_at: new Date(now).toISOString(), activated_user_id: actor.id,
    }).eq("id", license.id).eq("status", "unused").is("device_id", null).select("*");
    if (error) throw dbFail(error, "activation");
    if (data && data.length === 1) return customerView(data[0], device.id, now);
    license = await findByEmailAndCode(admin, email, code); // lost a race: decide again on fresh state
  }
  throw new LicenseError("ALREADY_ACTIVATED");
}

// ----- code-first setup (no session) -----

async function findByCode(admin, code) {
  const { data, error } = await admin.from("licenses").select("*").eq("access_code", code).maybeSingle();
  if (error) throw dbFail(error, "license lookup");
  return data;
}

export function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!domain) return "";
  const shown = user.length <= 2 ? user.slice(0, 1) : user.slice(0, 2);
  return `${shown}${"•".repeat(Math.max(1, Math.min(user.length - shown.length, 6)))}@${domain}`;
}

// Step 1: validate the code and bind its license to this PC (same decision and
// atomic bind as activate). Already bound here → no write, continue setup.
async function claim({ admin, body, now }) {
  const code = normalizeCode(body.code);
  if (!code) throw new LicenseError("INVALID_CODE_FORMAT");
  const device = validateDevice(body.device);

  let license = await findByCode(admin, code);
  for (let attempt = 0; attempt < 2; attempt++) {
    const d = decideActivation({ license, deviceId: device.id, now });
    if (!d.ok) throw new LicenseError(d.code === "INVALID_CODE" ? "UNKNOWN_CODE" : d.code);
    if (d.action === "bind") {
      const { data, error } = await admin.from("licenses").update({
        status: "active", device_id: device.id, device_label: device.label || null,
        activated_at: new Date(now).toISOString(), activated_user_id: null,
      }).eq("id", license.id).eq("status", "unused").is("device_id", null).select("*");
      if (error) throw dbFail(error, "activation");
      if (!data || data.length !== 1) { license = await findByCode(admin, code); continue; }
      license = data[0];
    }
    return {
      ...customerView(license, device.id, now),
      email_masked: maskEmail(license.email),
      bound: d.action === "bind" ? "now" : "already_here",
      // A license already linked to an account signs in; otherwise the buyer
      // creates a password (set_password still refuses if an account exists).
      next: license.activated_user_id ? "sign_in" : "set_password",
    };
  }
  throw new LicenseError("ALREADY_ACTIVATED");
}

function isEmailExistsError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return error?.code === "email_exists" || error?.code === "user_already_exists"
    || text.includes("already been registered") || text.includes("already registered") || text.includes("already exists");
}

// Step 2: create the buyer's own account for the license's email. Only from the
// PC the license is bound to, and never over an existing account.
async function setPassword({ admin, body, now }) {
  const code = normalizeCode(body.code);
  if (!code) throw new LicenseError("INVALID_CODE_FORMAT");
  const device = validateDevice(body.device);
  const password = body.password;
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || !password.trim()) {
    throw new LicenseError("WEAK_PASSWORD");
  }

  const license = await findByCode(admin, code);
  const d = decideActivation({ license, deviceId: device.id, now });
  if (!d.ok) throw new LicenseError(d.code === "INVALID_CODE" ? "UNKNOWN_CODE" : d.code);
  if (d.action !== "already_here") throw new LicenseError("NOT_BOUND_HERE");
  if (license.activated_user_id) throw new LicenseError("ACCOUNT_EXISTS");

  const { data, error } = await admin.auth.admin.createUser({ email: license.email, password, email_confirm: true });
  if (error || !data?.user?.id) {
    if (isEmailExistsError(error)) throw new LicenseError("ACCOUNT_EXISTS");
    // Log only the provider's error code/status — never the request body.
    console.error("[license] account create:", error?.code, error?.status);
    throw new LicenseError("INTERNAL", "account creation failed");
  }
  const { error: linkError } = await admin.from("licenses").update({ activated_user_id: data.user.id })
    .eq("id", license.id).is("activated_user_id", null);
  if (linkError) throw dbFail(linkError, "account link");
  return { account: "created", email: license.email };
}

async function check({ admin, actor, body, now }) {
  const email = requireVerifiedEmail(actor);
  const device = validateDevice(body.device);
  const { data, error } = await admin.from("licenses").select("*").eq("email", email).order("created_at", { ascending: false });
  if (error) throw dbFail(error, "license check");
  // The live (non-revoked) license wins; otherwise report the latest revoked one.
  const license = (data || []).find((l) => l.status !== "revoked") || (data || [])[0] || null;
  return customerView(license, device.id, now);
}

// ----- admin -----

function adminView(l, now) {
  return {
    id: l.id, email: l.email, code: l.access_code, status: l.status,
    expired: isExpired(l, now), expires_at: l.expires_at,
    activated: l.status === "active", device_label: l.device_label,
    device_id_short: l.device_id ? `${l.device_id.slice(0, 12)}…` : null,
    activated_at: l.activated_at, revoked_at: l.revoked_at, created_at: l.created_at,
  };
}

async function create({ admin, actor, body, now }) {
  const email = normalizeEmail(body.email);
  if (!email) throw new LicenseError("VALIDATION", "a valid customer email is required");
  let expires_at = null;
  if (body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== "") {
    const t = Date.parse(body.expires_at);
    if (!Number.isFinite(t) || t <= now) throw new LicenseError("VALIDATION", "expiry must be a future date");
    expires_at = new Date(t).toISOString();
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { data: row, error } = await admin.from("licenses")
      .insert({ email, access_code: code, expires_at, created_by: actor.id }).select("*").single();
    if (error) {
      if (error.code === "23505") {
        if (String(error.message).includes("licenses_one_live_per_email")) throw new LicenseError("EMAIL_HAS_LICENSE");
        continue; // (astronomically unlikely) code collision: draw again
      }
      throw dbFail(error, "license insert");
    }
    // A generated code is only reported if it resolves through the same lookup
    // customers use, and is still unused.
    const back = await findByEmailAndCode(admin, email, code);
    if (!back || back.id !== row.id || back.status !== "unused" || normalizeCode(code) !== code) {
      await admin.from("licenses").delete().eq("id", row.id);
      throw new LicenseError("GENERATION_FAILED");
    }
    return { license: adminView(back, now), code };
  }
  throw new LicenseError("GENERATION_FAILED");
}

async function list({ admin, body, now }) {
  const { data, error } = await admin.from("licenses").select("*").order("created_at", { ascending: false }).limit(1000);
  if (error) throw dbFail(error, "license list");
  let items = data || [];
  if (typeof body.search === "string" && body.search.trim()) {
    const q = body.search.trim().toLowerCase();
    const qCode = q.replace(/[\s_-]+/g, "").toUpperCase();
    items = items.filter((l) =>
      l.email.includes(q) || (l.device_label || "").toLowerCase().includes(q) ||
      (qCode.length >= 3 && l.access_code.replaceAll("-", "").includes(qCode)));
  }
  return { total: items.length, items: items.map((l) => adminView(l, now)) };
}

function requireId(body) {
  if (typeof body.id !== "string" || !UUID_RE.test(body.id)) throw new LicenseError("VALIDATION", "id must be a uuid");
  return body.id;
}

async function changeLicense({ admin, body, now }, patch, requireStatus) {
  const id = requireId(body);
  let q = admin.from("licenses").update(patch).eq("id", id);
  q = requireStatus === "not_revoked" ? q.neq("status", "revoked") : q.eq("status", requireStatus);
  const { data, error } = await q.select("*");
  if (error) throw dbFail(error, "license update");
  if (data && data.length === 1) return { license: adminView(data[0], now) };
  const { data: exists } = await admin.from("licenses").select("id").eq("id", id).maybeSingle();
  throw new LicenseError(exists ? "INVALID_STATE" : "NOT_FOUND");
}

const revoke = (ctx) => changeLicense(ctx, { status: "revoked", revoked_at: new Date(ctx.now).toISOString() }, "not_revoked");

// Deliberate PC move: clears the binding so the customer can activate on a new PC.
const release = (ctx) => changeLicense(
  ctx,
  { status: "unused", device_id: null, device_label: null, activated_at: null, activated_user_id: null },
  "active",
);

async function whoami({ actor }) {
  return { admin: true, user_id: actor.id, email: actor.email ?? null };
}

const HANDLERS = { activate, check, whoami, create, list, revoke, release, claim, set_password: setPassword };

export function isPublicAction(body) {
  return Boolean(body && typeof body === "object" && !Array.isArray(body)
    && typeof body.action === "string" && Object.hasOwn(PUBLIC_ACTIONS, body.action));
}

export async function handleLicense({ admin, actor, body, now = Date.now() }) {
  if (isPublicAction(body)) {
    assertOnlyFields(body, PUBLIC_ACTIONS[body.action]);
    return { ok: true, result: await HANDLERS[body.action]({ admin, body, now }) };
  }
  if (!actor?.id) throw new LicenseError("UNAUTHENTICATED");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new LicenseError("VALIDATION", "body must be an object");
  const action = body.action;
  if (typeof action !== "string" || !Object.hasOwn(HANDLERS, action)) throw new LicenseError("UNKNOWN_ACTION");

  const isAdmin = Object.hasOwn(ADMIN_ACTIONS, action);
  if (isAdmin) await requireAdmin(admin, actor); // authorize before revealing anything about the request shape
  assertOnlyFields(body, isAdmin ? ADMIN_ACTIONS[action] : CUSTOMER_ACTIONS[action]);
  return { ok: true, result: await HANDLERS[action]({ admin, actor, body, now }) };
}
