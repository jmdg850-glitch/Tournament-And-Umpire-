// Client for the `license` Edge Function. Contains NO license rules: the server
// decides everything. The only local rule is a short offline allowance so a
// venue with no internet can still run a tournament.

export const RECHECK_MS = 6 * 60 * 60 * 1000;
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

export function forgetActive(userId, storage = globalThis.localStorage) {
  try { storage?.removeItem(cacheKey(userId)); } catch { /* ignore */ }
}

// Offline (server unreachable): allowed only if this account was verified
// active within the last 7 days, and the clock has not been rolled back.
export function offlineAllowed(userId, now = Date.now(), storage = globalThis.localStorage) {
  let last = NaN;
  try { last = Number(storage?.getItem(cacheKey(userId))); } catch { /* ignore */ }
  return Number.isFinite(last) && last > 0 && now >= last - 5 * 60 * 1000 && now - last <= OFFLINE_ALLOWANCE_MS;
}
