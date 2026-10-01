// Licensing: ONE customer email / account -> ONE access code -> up to
// max_devices registered PCs (admin-controlled, default 1).
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
//  - The device limit is enforced when a device REGISTERS, atomically, by the
//    database function public.license_register_device (row lock on the
//    license), never by a count-then-insert here.
//  - Code-first setup (claim / set_password) needs no session: possession of
//    the admin-issued access code is the proof. It may register only the
//    license's FIRST device, and only while no account is linked to it; after
//    that a new PC must sign in and `activate`. It may create the Supabase Auth
//    account for the license's email (password hashed by Supabase Auth) — but
//    never overwrites an existing account's password, and only from a device
//    registered to the license.
//  - Plans (Monthly / Yearly / 30-Day Trial): the browser only names the plan;
//    the expiry is always computed here. Renew, change_plan (legacy ->
//    Monthly/Yearly) and delete are admin actions
//    like revoke (delete cascades to license_devices in the database).
//  - The database is only reachable through this function (RLS: no client grants).
//  - Everyday /command actions are device-blind by design (packages/api
//    requireLicense checks account + license only).

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 symbols: no 0/1/I/L/O/U
const CODE_GROUPS = 3;
const GROUP_LEN = 4;
const CODE_LEN = CODE_GROUPS * GROUP_LEN;

export const MAX_DEVICES_MIN = 1;
export const MAX_DEVICES_MAX = 100;
// last_seen_at is refreshed by `check` at most this often per device.
export const LAST_SEEN_TOUCH_MS = 60 * 60 * 1000;

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
  ALREADY_ACTIVATED: [409, "This license is already activated on another PC. Sign in on this PC to add it to your license."],
  DEVICE_LIMIT: [409, "This license has reached its device limit. Ask your provider to release a device or raise the limit."],
  EMAIL_HAS_LICENSE: [409, "This email already has a license. Revoke it first to issue a new one."],
  NOT_FOUND: [404, "License not found."],
  DEVICE_NOT_FOUND: [404, "That device is not registered to this license."],
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

// Admin-chosen device limit: a whole number 1..100.
export function validateMaxDevices(value) {
  if (!Number.isInteger(value) || value < MAX_DEVICES_MIN || value > MAX_DEVICES_MAX) {
    throw new LicenseError("VALIDATION", `max_devices must be a whole number from ${MAX_DEVICES_MIN} to ${MAX_DEVICES_MAX}`);
  }
  return value;
}

// License plans (migration 0021). The server alone turns a plan into an expiry;
// the browser only names the plan. `legacy` = licenses issued before plans
// existed (and plan-less creates from older License Admin builds): their
// expiry is whatever was chosen at issue, or none, and they are not renewable.
export const PLANS = {
  monthly: { months: 1, renewable: true },
  yearly: { months: 12, renewable: true },
  trial_30: { days: 30, renewable: false },
};
export const LEGACY_PLAN = "legacy";
const DAY_MS = 24 * 60 * 60 * 1000;

export function validatePlan(value) {
  if (typeof value !== "string" || !Object.hasOwn(PLANS, value)) {
    throw new LicenseError("VALIDATION", `plan must be one of: ${Object.keys(PLANS).join(", ")}`);
  }
  return value;
}

// One plan period after `fromMs`, in UTC. Calendar months/years keep the time of
// day and clamp the day to the target month's end (Jan 31 + 1 month = Feb 28/29);
// the trial is exactly 30 x 24 h.
export function addPlanPeriod(fromMs, plan) {
  const p = PLANS[plan];
  if (p.days) return fromMs + p.days * DAY_MS;
  const d = new Date(fromMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + p.months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export function isRenewable(license) {
  return Boolean(license && license.status !== "revoked" && PLANS[license.plan]?.renewable);
}

// Plans an existing legacy license may be moved onto. Trials are for new
// licenses only.
export const CONVERTIBLE_PLANS = ["monthly", "yearly"];

// The expiry after one more `plan` period: from the current expiry while it is
// still in the future, otherwise (expired, or no expiry) from the server's now.
// Shared by renew and change_plan so both follow one rule.
export function nextExpiry(license, plan, now) {
  const current = license.expires_at ? Date.parse(license.expires_at) : now;
  return new Date(addPlanPeriod(Math.max(now, Number.isFinite(current) ? current : now), plan)).toISOString();
}

// ---------------------------------------------------------------------------
// License validity (the device limit itself is decided by the database)
// ---------------------------------------------------------------------------

export function isExpired(license, now) {
  if (!license.expires_at) return false;
  const t = Date.parse(license.expires_at);
  return Number.isFinite(t) && t <= now;
}

// Can this license register/use devices at all? -> { ok: true } | { ok: false, code }
export function decideActivation({ license, now }) {
  if (!license) return { ok: false, code: "INVALID_CODE" };
  if (license.status === "revoked") return { ok: false, code: "REVOKED" };
  if (isExpired(license, now)) return { ok: false, code: "EXPIRED" };
  return { ok: true };
}

// What a customer app is told about its license on THIS device (never the code).
// `registered`: this device holds an active (unreleased) slot on the license.
// `not_registered` deliberately carries no `message`: installed Operator builds
// show the Access Code form only when there is no message, so a new or released
// PC can still activate itself.
export function customerView(license, registered, now) {
  if (!license) return { status: "none" };
  let status = license.status;
  if (status === "revoked") { /* stays revoked */ }
  else if (isExpired(license, now)) status = "expired";
  else if (status === "active" && !registered) status = "not_registered";
  const messages = { revoked: ERRORS.REVOKED[1], expired: ERRORS.EXPIRED[1] };
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
  create: ["email", "expires_at", "max_devices", "plan"],
  list: ["search"],
  revoke: ["id"],
  renew: ["id"],
  change_plan: ["id", "plan"],
  delete: ["id"],
  release: ["id"], // legacy (License Admin <= 1.0.11): release every device of a license
  release_device: ["license_id", "device_id"],
  set_max_devices: ["id", "max_devices"],
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

// ----- devices -----

// The ONLY way a device gets a slot: the database locks the license row,
// re-checks revoked/expired, reuses an existing registration, and compares the
// active count with max_devices — all in one transaction.
async function registerDevice(admin, license, device, { userId = null, firstOnly = false } = {}) {
  const { data, error } = await admin.rpc("license_register_device", {
    p_license_id: license.id,
    p_device_id: device.id,
    p_device_label: device.label || null,
    p_user_id: userId,
    p_first_only: firstOnly,
  });
  if (error) throw dbFail(error, "device registration");
  if (!data || data.ok !== true) {
    const code = data?.code === "NOT_FOUND" ? "INVALID_CODE" : data?.code;
    throw new LicenseError(ERRORS[code] ? code : "INTERNAL");
  }
  return data; // { ok, outcome: "registered" | "already_here", active_devices, max_devices }
}

async function findActiveDevice(admin, licenseId, deviceId) {
  const { data, error } = await admin.from("license_devices").select("*")
    .eq("license_id", licenseId).eq("device_id", deviceId).is("released_at", null).maybeSingle();
  if (error) throw dbFail(error, "device lookup");
  return data;
}

// ----- customer -----

async function findByEmailAndCode(admin, email, code) {
  const { data, error } = await admin.from("licenses").select("*").eq("email", email).eq("access_code", code).maybeSingle();
  if (error) throw dbFail(error, "license lookup");
  return data;
}

async function findById(admin, id) {
  const { data, error } = await admin.from("licenses").select("*").eq("id", id).maybeSingle();
  if (error) throw dbFail(error, "license lookup");
  return data;
}

async function activate({ admin, actor, body, now }) {
  const email = requireVerifiedEmail(actor);
  const code = normalizeCode(body.code);
  if (!code) throw new LicenseError("INVALID_CODE_FORMAT");
  const device = validateDevice(body.device);

  const license = await findByEmailAndCode(admin, email, code);
  const d = decideActivation({ license, now });
  if (!d.ok) throw new LicenseError(d.code);
  // Already registered here -> no new slot; new device -> a slot if one is free,
  // otherwise DEVICE_LIMIT.
  await registerDevice(admin, license, device, { userId: actor.id });

  // Bound by a code-first claim before this account existed: link it now.
  if (!license.activated_user_id) {
    const { error } = await admin.from("licenses").update({ activated_user_id: actor.id })
      .eq("id", license.id).is("activated_user_id", null);
    if (error) throw dbFail(error, "account link");
  }
  return customerView(await findById(admin, license.id), true, now);
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

// Step 1: validate the code. While no account is linked to the license, this
// may register the license's FIRST device (initial setup). Once an account
// exists, the code alone never registers anything: the buyer is sent to sign
// in, and a new PC is added through the signed-in `activate`. So a leaked code
// cannot fill the license's device slots anonymously.
async function claim({ admin, body, now }) {
  const code = normalizeCode(body.code);
  if (!code) throw new LicenseError("INVALID_CODE_FORMAT");
  const device = validateDevice(body.device);

  let license = await findByCode(admin, code);
  const d = decideActivation({ license, now });
  if (!d.ok) throw new LicenseError(d.code === "INVALID_CODE" ? "UNKNOWN_CODE" : d.code);

  let bound;
  if (license.activated_user_id) {
    bound = (await findActiveDevice(admin, license.id, device.id)) ? "already_here" : "not_registered";
  } else {
    const r = await registerDevice(admin, license, device, { firstOnly: true });
    bound = r.outcome === "registered" ? "now" : "already_here";
    license = await findById(admin, license.id);
  }
  return {
    ...customerView(license, bound !== "not_registered", now),
    email_masked: maskEmail(license.email),
    bound,
    // A license already linked to an account signs in; otherwise the buyer
    // creates a password (set_password still refuses if an account exists).
    next: license.activated_user_id ? "sign_in" : "set_password",
  };
}

function isEmailExistsError(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  return error?.code === "email_exists" || error?.code === "user_already_exists"
    || text.includes("already been registered") || text.includes("already registered") || text.includes("already exists");
}

// Step 2: create the buyer's own account for the license's email. Only from a
// device registered to the license, and never over an existing account.
async function setPassword({ admin, body, now }) {
  const code = normalizeCode(body.code);
  if (!code) throw new LicenseError("INVALID_CODE_FORMAT");
  const device = validateDevice(body.device);
  const password = body.password;
  if (typeof password !== "string" || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX || !password.trim()) {
    throw new LicenseError("WEAK_PASSWORD");
  }

  const license = await findByCode(admin, code);
  const d = decideActivation({ license, now });
  if (!d.ok) throw new LicenseError(d.code === "INVALID_CODE" ? "UNKNOWN_CODE" : d.code);
  if (!(await findActiveDevice(admin, license.id, device.id))) throw new LicenseError("NOT_BOUND_HERE");
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
  let registered = false;
  if (license && license.status === "active") {
    const row = await findActiveDevice(admin, license.id, device.id);
    registered = Boolean(row);
    const seen = row?.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (row && !(seen > now - LAST_SEEN_TOUCH_MS)) {
      // Best effort: "last seen" is display-only for the admin.
      const { error: touchError } = await admin.from("license_devices")
        .update({ last_seen_at: new Date(now).toISOString() }).eq("id", row.id);
      if (touchError) console.error("[license] last seen:", touchError.code);
    }
  }
  return customerView(license, registered, now);
}

// ----- admin -----

function deviceView(d) {
  return {
    id: d.id,
    label: d.device_label || null,
    device_id_short: d.device_id ? `${d.device_id.slice(0, 12)}…` : null,
    first_activated_at: d.first_activated_at,
    last_seen_at: d.last_seen_at || null,
    released_at: d.released_at || null,
  };
}

function adminView(l, devices, now) {
  const own = devices.filter((d) => d.license_id === l.id)
    .sort((a, b) => String(a.first_activated_at).localeCompare(String(b.first_activated_at)));
  const active = own.filter((d) => !d.released_at);
  const max = Number.isInteger(l.max_devices) ? l.max_devices : 1;
  const first = active[0] || null;
  return {
    id: l.id, email: l.email, code: l.access_code, status: l.status,
    expired: isExpired(l, now), expires_at: l.expires_at,
    plan: l.plan || LEGACY_PLAN,
    renewable: isRenewable({ ...l, plan: l.plan || LEGACY_PLAN }),
    max_devices: max,
    active_devices: active.length,
    over_limit: active.length > max,
    devices: own.map(deviceView),
    // Kept for License Admin <= 1.0.11 (one "Activated PC" column).
    activated: active.length > 0,
    device_label: first?.device_label || null,
    device_id_short: first?.device_id ? `${first.device_id.slice(0, 12)}…` : null,
    activated_at: l.activated_at, revoked_at: l.revoked_at, created_at: l.created_at,
  };
}

// Device rows of the given licenses, fetched in chunks so a long license list
// never builds an oversized URL or hits the API's per-response row cap.
async function devicesFor(admin, licenseIds) {
  const out = [];
  for (let i = 0; i < licenseIds.length; i += 100) {
    const { data, error } = await admin.from("license_devices").select("*")
      .in("license_id", licenseIds.slice(i, i + 100)).order("first_activated_at", { ascending: true }).limit(10000);
    if (error) throw dbFail(error, "device list");
    out.push(...(data || []));
  }
  return out;
}

async function viewOne(admin, license, now) {
  return adminView(license, await devicesFor(admin, [license.id]), now);
}

async function create({ admin, actor, body, now }) {
  const email = normalizeEmail(body.email);
  if (!email) throw new LicenseError("VALIDATION", "a valid customer email is required");
  const hasExpiry = body.expires_at !== undefined && body.expires_at !== null && body.expires_at !== "";
  let expires_at = null;
  let plan;
  if (body.plan !== undefined) {
    // Plan license: the expiry is computed here, never taken from the browser.
    plan = validatePlan(body.plan);
    if (hasExpiry) throw new LicenseError("VALIDATION", "expires_at is set by the plan");
    expires_at = new Date(addPlanPeriod(now, plan)).toISOString();
  } else if (hasExpiry) {
    // Plan-less create (License Admin <= 1.0.13): stored as legacy, as before.
    const t = Date.parse(body.expires_at);
    if (!Number.isFinite(t) || t <= now) throw new LicenseError("VALIDATION", "expiry must be a future date");
    expires_at = new Date(t).toISOString();
  }
  const max_devices = body.max_devices === undefined ? 1 : validateMaxDevices(body.max_devices);

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    const { data: row, error } = await admin.from("licenses")
      .insert({ email, access_code: code, expires_at, max_devices, created_by: actor.id, ...(plan ? { plan } : {}) }).select("*").single();
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
    return { license: adminView(back, [], now), code };
  }
  throw new LicenseError("GENERATION_FAILED");
}

async function list({ admin, body, now }) {
  const { data, error } = await admin.from("licenses").select("*").order("created_at", { ascending: false }).limit(1000);
  if (error) throw dbFail(error, "license list");
  const devices = await devicesFor(admin, (data || []).map((l) => l.id));
  let items = data || [];
  if (typeof body.search === "string" && body.search.trim()) {
    const q = body.search.trim().toLowerCase();
    const qCode = q.replace(/[\s_-]+/g, "").toUpperCase();
    const labelHit = new Set(devices.filter((d) => (d.device_label || "").toLowerCase().includes(q)).map((d) => d.license_id));
    items = items.filter((l) =>
      l.email.includes(q) || labelHit.has(l.id) ||
      (qCode.length >= 3 && l.access_code.replaceAll("-", "").includes(qCode)));
  }
  return { total: items.length, items: items.map((l) => adminView(l, devices, now)) };
}

function requireUuid(value, field) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw new LicenseError("VALIDATION", `${field} must be a uuid`);
  return value;
}

async function changeLicense({ admin, body, now }, patch, requireStatus) {
  const id = requireUuid(body.id, "id");
  let q = admin.from("licenses").update(patch).eq("id", id);
  q = requireStatus === "not_revoked" ? q.neq("status", "revoked") : q.eq("status", requireStatus);
  const { data, error } = await q.select("*");
  if (error) throw dbFail(error, "license update");
  if (data && data.length === 1) return { license: await viewOne(admin, data[0], now) };
  const { data: exists } = await admin.from("licenses").select("id").eq("id", id).maybeSingle();
  throw new LicenseError(exists ? "INVALID_STATE" : "NOT_FOUND");
}

// Revoking invalidates the whole license: every device loses access (check ->
// revoked; /command -> LICENSE_INVALID). Device rows are kept as history.
const revoke = (ctx) => changeLicense(ctx, { status: "revoked", revoked_at: new Date(ctx.now).toISOString() }, "not_revoked");

// Raising or lowering the limit never releases devices. Lowering it below the
// current usage only stops NEW registrations until usage is back under it.
const setMaxDevices = (ctx) => changeLicense(ctx, { max_devices: validateMaxDevices(ctx.body.max_devices) }, "not_revoked");

// Manual renewal (no payments): extends a Monthly/Yearly license by one plan
// period from its current expiry, or from now if it has already expired, so a
// renewal never yields an already-expired license. Trials and legacy licenses
// are not renewable. Touches only expires_at — never devices or max_devices.
// The update is conditional on the expiry we read, so two renewals racing each
// other extend the license once, never twice.
async function renew({ admin, body, now }) {
  const id = requireUuid(body.id, "id");
  const license = await findById(admin, id);
  if (!license) throw new LicenseError("NOT_FOUND");
  if (!isRenewable(license)) throw new LicenseError("INVALID_STATE");
  const next = nextExpiry(license, license.plan, now);
  const { data, error } = await admin.from("licenses").update({ expires_at: next })
    .eq("id", id).eq("expires_at", license.expires_at).neq("status", "revoked").select("*");
  if (error) throw dbFail(error, "license renew");
  if (!data || data.length !== 1) throw new LicenseError("INVALID_STATE");
  return { license: await viewOne(admin, data[0], now) };
}

// Move an existing legacy license onto Monthly or Yearly in place: same code,
// email, devices and max_devices; only plan and expires_at change. The expiry
// is computed here (see nextExpiry) — never taken from the browser. One
// conditional UPDATE: it applies only while the row is still the legacy,
// non-revoked license with the expiry we read, so of two simultaneous changes
// exactly one wins and the other gets INVALID_STATE.
async function changePlan({ admin, body, now }) {
  const id = requireUuid(body.id, "id");
  const plan = body.plan;
  if (typeof plan !== "string" || !CONVERTIBLE_PLANS.includes(plan)) {
    throw new LicenseError("VALIDATION", `plan must be one of: ${CONVERTIBLE_PLANS.join(", ")}`);
  }
  const license = await findById(admin, id);
  if (!license) throw new LicenseError("NOT_FOUND");
  if ((license.plan || LEGACY_PLAN) !== LEGACY_PLAN || license.status === "revoked") throw new LicenseError("INVALID_STATE");
  const expires_at = nextExpiry(license, plan, now);
  let q = admin.from("licenses").update({ plan, expires_at })
    .eq("id", id).eq("plan", LEGACY_PLAN).neq("status", "revoked");
  q = license.expires_at ? q.eq("expires_at", license.expires_at) : q.is("expires_at", null);
  const { data, error } = await q.select("*");
  if (error) throw dbFail(error, "plan change");
  if (!data || data.length !== 1) throw new LicenseError("INVALID_STATE");
  return { license: await viewOne(admin, data[0], now) };
}

// Permanent delete. license_devices rows go with it through the foreign key's
// ON DELETE CASCADE (0020), in the same statement, so no device row is left
// behind. The customer's PCs lose the license (check -> none; /command ->
// LICENSE_REQUIRED). Use revoke to stop a license but keep its history.
async function deleteLicense({ admin, body }) {
  const id = requireUuid(body.id, "id");
  const { data, error } = await admin.from("licenses").delete().eq("id", id).select("id");
  if (error) throw dbFail(error, "license delete");
  if (!data || data.length !== 1) throw new LicenseError("NOT_FOUND");
  return { deleted: id };
}

// Release ONE device of ONE license. Both ids must match, so a device of
// another license can never be released through this license.
async function releaseDevice({ admin, body, now }) {
  const licenseId = requireUuid(body.license_id, "license_id");
  const deviceRowId = requireUuid(body.device_id, "device_id");
  const license = await findById(admin, licenseId);
  if (!license) throw new LicenseError("NOT_FOUND");
  const { data, error } = await admin.from("license_devices").update({ released_at: new Date(now).toISOString() })
    .eq("id", deviceRowId).eq("license_id", licenseId).is("released_at", null).select("*");
  if (error) throw dbFail(error, "device release");
  if (!data || data.length !== 1) throw new LicenseError("DEVICE_NOT_FOUND");
  return { license: await viewOne(admin, license, now) };
}

// Legacy action (License Admin <= 1.0.11 "Release PC"): releases every active
// device of the license so the customer can activate a replacement PC.
async function release({ admin, body, now }) {
  const id = requireUuid(body.id, "id");
  const license = await findById(admin, id);
  if (!license) throw new LicenseError("NOT_FOUND");
  if (license.status !== "active") throw new LicenseError("INVALID_STATE");
  const { error } = await admin.from("license_devices").update({ released_at: new Date(now).toISOString() })
    .eq("license_id", id).is("released_at", null).select("*");
  if (error) throw dbFail(error, "device release");
  return { license: await viewOne(admin, license, now) };
}

async function whoami({ actor }) {
  return { admin: true, user_id: actor.id, email: actor.email ?? null };
}

const HANDLERS = {
  activate, check, whoami, create, list, revoke, release, renew, change_plan: changePlan, delete: deleteLicense,
  release_device: releaseDevice, set_max_devices: setMaxDevices,
  claim, set_password: setPassword,
};

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
