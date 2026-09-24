// Client for the `license` Edge Function. Contains NO license rules: the server
// decides everything. The only local rule is a short offline allowance so a
// venue with no internet can still run a tournament.

// How often an already-open app re-asks the server. A revoke reaches an idle
// open app within this interval; any licensed command the server refuses
// blocks the app immediately (see reportDenial below).
export const RECHECK_MS = 5 * 60 * 1000;
// Window focus / tab visible also re-checks, at most this often.
export const FOCUS_RECHECK_MIN_MS = 60 * 1000;
export const OFFLINE_ALLOWANCE_MS = 7 * 24 * 60 * 60 * 1000;

// Same convention as pair-station: the function sits next to `command`.
export function licenseUrl(commandUrl) {
  return String(commandUrl).replace(/\/command\/?$/, "/license");
}

export class LicenseCallError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function callLicense({ commandUrl, publishableKey, accessToken, action, body = {}, fetchImpl = (...a) => fetch(...a) }) {
  let res;
  const headers = { "Content-Type": "application/json", apikey: publishableKey };
  // Code-first setup actions run before any session exists: no bearer token.
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  try {
    res = await fetchImpl(licenseUrl(commandUrl), {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new LicenseCallError("NETWORK", "Unable to verify license. Please check your internet connection.", 0);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !json?.ok) {
    throw new LicenseCallError(json?.error?.code || "INTERNAL", json?.error?.message || "Something went wrong. Please try again.", res.status);
  }
  return json.result;
}

// Code-first activation (no session). The access code proves the buyer; the
// server binds the license to this PC, then creates the buyer's own account
// for the license email with the password they choose (hashed by Supabase
// Auth). The password is sent once, over HTTPS, and never stored here.
export function claimLicense({ commandUrl, publishableKey, code, device, fetchImpl }) {
  return callLicense({ commandUrl, publishableKey, action: "claim", body: { code, device }, fetchImpl });
}

export function setupLicensePassword({ commandUrl, publishableKey, code, device, password, fetchImpl }) {
  return callLicense({ commandUrl, publishableKey, action: "set_password", body: { code, device, password }, fetchImpl });
}

// Remembers that this install has a signed-in account, so the sign-in screen
// (not activation) is shown first on later launches. Not a security control.
const HAS_ACCOUNT_KEY = "tournament.operator.hasAccount";

export function rememberHasAccount(storage = globalThis.localStorage) {
  try { storage?.setItem(HAS_ACCOUNT_KEY, "1"); } catch { /* storage unavailable */ }
}

export function hasAccountHere(storage = globalThis.localStorage) {
  try { return storage?.getItem(HAS_ACCOUNT_KEY) === "1"; } catch { return false; }
}

const cacheKey = (userId) => `tournament.license.lastActive.${userId}`;

export function rememberActive(userId, now = Date.now(), storage = globalThis.localStorage) {
  try { storage?.setItem(cacheKey(userId), String(now)); } catch { /* storage unavailable */ }
}

// Also records WHEN the server last said "not active", so a check that was
// sent before that moment (a stale answer, from any window of this app) can
// never re-save the offline allowance afterwards.
const blockedKey = (userId) => `tournament.license.blockedAt.${userId}`;

export function forgetActive(userId, storage = globalThis.localStorage, now = Date.now()) {
  try { storage?.removeItem(cacheKey(userId)); } catch { /* ignore */ }
  try { storage?.setItem(blockedKey(userId), String(now)); } catch { /* storage unavailable */ }
}

// rememberActive for a `check` answer: only if that check was sent after the
// latest "not active" answer. Returns whether it was saved.
export function rememberActiveIfCurrent(userId, requestedAt, now = Date.now(), storage = globalThis.localStorage) {
  let blockedAt = NaN;
  try { blockedAt = Number(storage?.getItem(blockedKey(userId))); } catch { /* ignore */ }
  if (Number.isFinite(blockedAt) && blockedAt > 0 && requestedAt <= blockedAt) return false;
  rememberActive(userId, now, storage);
  return true;
}

// Offline (server unreachable): allowed only if this account was verified
// active within the last 7 days, and the clock has not been rolled back.
export function offlineAllowed(userId, now = Date.now(), storage = globalThis.localStorage) {
  let last = NaN;
  try { last = Number(storage?.getItem(cacheKey(userId))); } catch { /* ignore */ }
  return Number.isFinite(last) && last > 0 && now >= last - 5 * 60 * 1000 && now - last <= OFFLINE_ALLOWANCE_MS;
}

// The command layer's license refusal (packages/api/src/authz.js requireLicense):
// the server's own, current answer that this account is not licensed.
export function isLicenseDenial(err) {
  return Boolean(err) && err.status === 403 && (err.code === "LICENSE_INVALID" || err.code === "LICENSE_REQUIRED");
}

// One `check` result -> gate state. A server answer always wins and updates
// the offline allowance; only an unreachable server may fall back to it.
// `requestedAt` = when that check was sent (defaults to now).
export function gateStateFromCheck({ userId, view, error, now = Date.now(), requestedAt = now, storage = globalThis.localStorage }) {
  if (view) {
    if (view.status === "active") rememberActiveIfCurrent(userId, requestedAt, now, storage); else forgetActive(userId, storage, now);
    return { phase: view.status === "active" ? "active" : "blocked", view, error: "" };
  }
  if (error?.code === "NETWORK" && offlineAllowed(userId, now, storage)) return { phase: "active", view: null, error: "" };
  return { phase: "blocked", view: null, error: error?.message || "Unable to verify license." };
}

export const DENIED_MESSAGE = "Your license is no longer active for this account.";

// Keeps one account's gate in step with the server: a check on start, every
// RECHECK_MS, on reconnect/focus, and immediately after the server refuses a
// licensed command. Results are applied in order — an older, slower check can
// never overwrite a newer answer (e.g. a pre-revoke "active" arriving late).
export function createLicenseMonitor({
  userId, check, onState,
  storage = globalThis.localStorage,
  now = () => Date.now(),
  recheckMs = RECHECK_MS,
  focusMinMs = FOCUS_RECHECK_MIN_MS,
  timers = globalThis,
}) {
  let seq = 0;
  let timer = null;
  let stopped = false;
  let lastCheckAt = 0;

  function apply(mine, next) {
    if (!stopped && mine === seq) onState(next);
    return next;
  }

  async function refresh() {
    const mine = ++seq;
    const requestedAt = now();
    lastCheckAt = requestedAt;
    let outcome;
    try {
      outcome = { view: await check() };
    } catch (error) {
      outcome = { error };
    }
    // Superseded (a newer check, denial or activation) or stopped: this answer
    // is discarded BEFORE it can touch storage or the gate.
    if (stopped || mine !== seq) return null;
    const next = gateStateFromCheck({ userId, ...outcome, now: now(), requestedAt, storage });
    onState(next);
    return next;
  }

  function refreshIfStale() {
    return now() - lastCheckAt >= focusMinMs ? refresh() : null;
  }

  // Authoritative server refusal: drop the offline allowance (so going offline
  // cannot resurrect access), block now, then fetch the reason for the screen.
  function reportDenial() {
    forgetActive(userId, storage, now());
    apply(++seq, { phase: "blocked", view: null, error: DENIED_MESSAGE });
    return refresh();
  }

  // A result obtained outside refresh() (a successful activation).
  function set(next) {
    return apply(++seq, next);
  }

  function start() {
    stopped = false;
    timer = timers.setInterval(() => { refresh(); }, recheckMs);
    return refresh();
  }

  function stop() {
    stopped = true;
    if (timer) timers.clearInterval(timer);
    timer = null;
  }

  return { start, stop, refresh, refreshIfStale, reportDenial, set };
}
