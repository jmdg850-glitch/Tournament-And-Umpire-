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
  try {
    res = await fetchImpl(licenseUrl(commandUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: publishableKey },
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
