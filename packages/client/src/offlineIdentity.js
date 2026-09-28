// Offline identity: which signed-in user a device may keep working as while
// the auth server can't be reached.
//
// supabase-js returns `session: null` on a cold start once the stored access
// token has expired and the refresh request can't reach the server — even
// though the session (with its refresh token) is still stored on this device.
// Without this, an operator PC or umpire phone restarted during an outage
// would drop to the sign-in screen and show nothing.
//
// Rules (a device may be "offline-unverified" as user X only if ALL hold):
//   - a session for X is still stored here (an explicit sign-out removes it);
//   - the refresh failed because the server was unreachable — never because
//     the server refused it (revoked / expired refresh token → signed out);
//   - X had a server-verified session on this device within `maxAgeMs`
//     (7 days, the same window as the Operator license offline allowance);
//   - the clock hasn't been rolled back past that verification.
//
// Security boundary: this never produces or returns a token. It only names
// the user whose OWN locally saved data may be shown and whose OWN local
// actions may be queued. Nothing is sent to the server in this mode; queued
// work is only sent after a real token refresh succeeds.

import { safeStorage } from "./safeStorage.js";

export const OFFLINE_IDENTITY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const VERIFIED_PREFIX = "tournament.identity.lastVerified.";

// Reads the supabase-js persisted session and returns ONLY who it belongs to.
export function readStoredIdentity(storageKey, storage = safeStorage()) {
  if (!storageKey || !storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const session = parsed?.currentSession || parsed;
    const userId = session?.user?.id;
    if (typeof userId !== "string" || !userId || !session?.refresh_token) return null;
    return { userId, email: typeof session.user.email === "string" ? session.user.email : null };
  } catch {
    return null;
  }
}

export function rememberVerified(userId, now = Date.now(), storage = safeStorage()) {
  if (!userId || !storage) return;
  try {
    storage.setItem(VERIFIED_PREFIX + userId, String(now));
  } catch {
    /* best-effort */
  }
}

export function readLastVerified(userId, storage = safeStorage()) {
  if (!userId || !storage) return null;
  try {
    const n = Number(storage.getItem(VERIFIED_PREFIX + userId));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function forgetVerified(userId, storage = safeStorage()) {
  if (!userId || !storage) return;
  try {
    storage.removeItem(VERIFIED_PREFIX + userId);
  } catch {
    /* ignore */
  }
}

// How a failed auth refresh must be treated:
//   "network" — the auth server couldn't be reached (or answered 5xx)
//   "missing" — nothing stored to refresh
//   "auth"    — the server refused the refresh (revoked/expired/invalid)
export function classifyRefreshError(error) {
  if (!error) return null;
  if (error.name === "AuthSessionMissingError") return "missing";
  if (error.name === "AuthRetryableFetchError") return "network";
  const status = Number(error.status);
  if (!error.status || !Number.isFinite(status) || status === 0) return "network";
  if (status >= 500 || status === 408 || status === 429) return "network";
  return "auth";
}

// Pure decision. Returns { mode, userId, email }:
//   "verified"           — a real, current session
//   "offline-unverified" — see the rules at the top of this file
//   "signed-out"
export function resolveIdentity({ session, stored, lastVerifiedAt, refreshErrorKind, now = Date.now(), maxAgeMs = OFFLINE_IDENTITY_MAX_AGE_MS }) {
  if (session?.access_token && session.user?.id) {
    return { mode: "verified", userId: session.user.id, email: session.user.email ?? null };
  }
  const signedOut = { mode: "signed-out", userId: null, email: null };
  if (!stored?.userId || refreshErrorKind !== "network") return signedOut;
  const last = Number(lastVerifiedAt);
  if (!Number.isFinite(last) || last <= 0) return signedOut;
  if (now < last - CLOCK_SKEW_MS) return signedOut; // clock rolled back
  if (now - last > maxAgeMs) return signedOut;
  return { mode: "offline-unverified", userId: stored.userId, email: stored.email ?? null };
}

// Gate for every data load that is saved as "last known good".
//
// When the stored access token has expired and the refresh can't complete
// (offline, captive portal, auth server unreachable), supabase-js silently
// sends queries with the publishable (anonymous) key instead. Row-level
// security then answers with EMPTY results and HTTP 200 — which would look
// like a real "you have nothing" and wipe the saved data. So a load may only
// run while a real session exists. Returns null when it may run, otherwise a
// failure outcome for applyLoadOutcome() that keeps the saved data.
export async function sessionGate(supabase) {
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session?.access_token) return null;
  } catch {
    // treated the same as "no usable session"
  }
  return { ok: false, kind: "network", message: "Not signed in to the server right now — showing saved data." };
}

// App startup. supabase-js resolves getSession() only after its token refresh
// finishes; with no connection it keeps retrying for ~25 s, which would leave
// the app on a splash screen at every offline cold start. So: if the auth
// server hasn't answered within `graceMs` and the offline-identity rules
// already allow it (stored session, verified within the allowance, clock
// sane), report the offline identity right away — while the real answer is
// still resolved in the background and reported when it arrives:
//   onChange({ session, offlineIdentity, settled })
// `settled: false` = provisional (still waiting on the server). The final
// report is always `settled: true`: a session (verified), an offline identity
// (the refresh failed as unreachable), or neither (signed out / refused).
// Returns a stop() function.
export function startIdentity(supabase, onChange, {
  storage = safeStorage(),
  now = () => Date.now(),
  graceMs = 2500,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
} = {}) {
  let stopped = false;
  let settled = false;
  const emit = (state) => { if (!stopped) onChange(state); };
  const stored = readStoredIdentity(supabase?.auth?.storageKey, storage);
  const timer = stored
    ? setTimer(() => {
      if (settled || stopped) return;
      const identity = resolveIdentity({
        session: null,
        stored,
        lastVerifiedAt: readLastVerified(stored.userId, storage),
        refreshErrorKind: "network",
        now: now(),
      });
      if (identity.mode === "offline-unverified") emit({ session: null, offlineIdentity: identity, settled: false });
    }, graceMs)
    : null;
  const finish = (state) => {
    settled = true;
    if (timer) clearTimer(timer);
    emit({ ...state, settled: true });
  };
  Promise.resolve()
    .then(() => supabase.auth.getSession())
    .then(({ data }) => data?.session ?? null, () => null)
    .then(async (session) => {
      if (stopped) return;
      if (session) return finish({ session, offlineIdentity: null });
      const probed = await probeIdentity(supabase, { storage, now });
      if (stopped) return;
      finish({
        session: probed.mode === "verified" ? probed.session : null,
        offlineIdentity: probed.mode === "offline-unverified" ? probed : null,
      });
    });
  return () => {
    stopped = true;
    if (timer) clearTimer(timer);
  };
}

// Startup / reconnect probe for a supabase client whose getSession() came
// back empty. Tries one refresh; if the server is unreachable, falls back to
// the offline identity rules above. Returns { mode, userId, email, session }.
export async function probeIdentity(supabase, { storage = safeStorage(), now = () => Date.now(), maxAgeMs } = {}) {
  const storageKey = supabase?.auth?.storageKey;
  const stored = readStoredIdentity(storageKey, storage);
  if (!stored) return { mode: "signed-out", userId: null, email: null, session: null };
  let session = null;
  let kind = null;
  try {
    const { data, error } = await supabase.auth.refreshSession();
    session = data?.session ?? null;
    kind = error ? classifyRefreshError(error) : null;
  } catch (err) {
    kind = classifyRefreshError(err) || "network";
  }
  const identity = resolveIdentity({
    session,
    stored,
    lastVerifiedAt: readLastVerified(stored.userId, storage),
    refreshErrorKind: kind,
    now: now(),
    maxAgeMs,
  });
  return { ...identity, session: identity.mode === "verified" ? session : null };
}
