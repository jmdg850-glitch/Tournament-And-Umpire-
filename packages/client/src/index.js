import { createClient } from "@supabase/supabase-js";

export { isNetworkError, classifySendError, createMemoryStore, createIndexedDBStore, defaultStore, sendCommandDurable, drainQueue, queueSize, enqueueCommand, ownerKey } from "./offlineQueue.js";
export { readMatchSnapshot, writeMatchSnapshot, clearMatchSnapshot } from "./matchSnapshot.js";
export { createMatchLane, reconstructMatchView, laneOf, sortLaneEntries } from "./matchLane.js";
export { createSyncEngine, createStorageLease, DEFAULT_BACKOFF_MS } from "./syncEngine.js";
export { classifyQueryFailure, applyLoadOutcome, stateFromCache, createDashboardCache, INITIAL_LOAD_STATE } from "./lastKnownGood.js";

// fetch with an optional hard deadline. A timeout rejects with an error that
// has NO `.status` (so isNetworkError() treats it as "never answered"), plus
// `timeout: true`: the server may still have applied the request, so callers
// must retry with the SAME command_id rather than treat it as a failure.
async function fetchWithTimeout(url, init, timeoutMs) {
  if (!timeoutMs || typeof AbortController === "undefined") return { res: await fetch(url, init), clear() {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, clear: () => clearTimeout(timer), signal: controller.signal };
  } catch (e) {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      const err = new Error(`No response from the server within ${Math.round(timeoutMs / 1000)}s`);
      err.code = "TIMEOUT";
      err.timeout = true;
      throw err;
    }
    throw e;
  }
}

async function readJson(res, clear, timeoutMs) {
  try {
    return await res.json();
  } catch (e) {
    if (e?.name === "AbortError") {
      const err = new Error(`No response from the server within ${Math.round(timeoutMs / 1000)}s`);
      err.code = "TIMEOUT";
      err.timeout = true;
      throw err;
    }
    return { ok: false, error: { code: "BAD_RESPONSE", message: res.statusText } };
  } finally {
    clear();
  }
}

export function createBrowserClient(url, publishableKey) {
  const httpOrigin = typeof window !== "undefined" && /^https?:$/.test(window.location.protocol);
  return createClient(url, publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: httpOrigin,
    },
  });
}

// For the public "Live" spectator page: a signed-out visitor never needs a
// persisted/refreshed session, so this deliberately skips all of that
// (persistSession/autoRefreshToken/detectSessionInUrl all false) rather than
// reusing createBrowserClient — avoids any session-restore cost or flicker
// for a page that's read-only and anon-role by design (see
// supabase/migrations/0012_public_live_tournaments.sql).
export function createSpectatorClient(url, publishableKey) {
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export async function sendCommand({ commandUrl, accessToken, publishableKey, type, payload, commandId, timeoutMs }) {
  const command_id = commandId || crypto.randomUUID();
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const { res, clear } = await fetchWithTimeout(commandUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command_id, type, payload }),
  }, timeoutMs);
  const body = await readJson(res, clear, timeoutMs);
  const elapsedMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0);
  if (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV) {
    console.debug("[tournament-command]", type, `${elapsedMs}ms`, body?.error?.code || "ok");
  }
  if (!res.ok || body?.ok === false) {
    const err = new Error(body?.error?.message || `Command failed (${res.status})`);
    err.status = res.status;
    err.code = body?.error?.code;
    err.body = body;
    err.elapsedMs = elapsedMs;
    throw err;
  }
  body.elapsedMs = elapsedMs;
  return body;
}

// Auth source for the sync engine for a signed-in Supabase user. Uses the
// existing Supabase session only (no new credential mechanism): returns
//   { token }                   — a current access token for `userId`
//   { offline: true }           — refresh couldn't reach the server; retry later
//   { needsAuth: true, message} — the session is gone/expired/another user;
//                                 queued work must wait for this user to sign in
// A 401 from the command API is handled by calling this with { force: true }.
export function createUserAuthProvider(supabase, userId, { minValidityMs = 60_000, expiredMessage, otherUserMessage } = {}) {
  return async function getAuth({ force = false } = {}) {
    if (!userId) return { needsAuth: true, message: expiredMessage || "Sign in to sync." };
    if (!force) {
      const { data } = await supabase.auth.getSession();
      const s = data?.session;
      if (s?.access_token && s.user?.id === userId && (!s.expires_at || s.expires_at * 1000 - Date.now() > minValidityMs)) {
        return { token: s.access_token };
      }
    }
    const { data, error } = await supabase.auth.refreshSession();
    const s = data?.session;
    if (s?.access_token) {
      if (s.user?.id !== userId) return { needsAuth: true, message: otherUserMessage || "A different account is signed in." };
      return { token: s.access_token };
    }
    if (error && (error.name === "AuthRetryableFetchError" || !error.status)) return { offline: true };
    return { needsAuth: true, message: expiredMessage || "Your sign-in has expired. Sign in again to sync." };
  };
}

export function envConfig() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
  const commandUrl = import.meta.env.VITE_COMMAND_URL;
  if (!url || !publishableKey || !commandUrl) {
    throw new Error("Missing VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, or VITE_COMMAND_URL");
  }
  const pairStationUrl = import.meta.env.VITE_PAIR_STATION_URL || commandUrl.replace(/\/command\/?$/, "/pair-station");
  return { url, publishableKey, commandUrl, pairStationUrl };
}

export async function pairStation({ pairStationUrl, publishableKey, pairingToken, stationPublicId, deviceLabel, refreshToken, action, timeoutMs }) {
  const { res, clear } = await fetchWithTimeout(pairStationUrl, {
    method: "POST",
    headers: {
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      action: action || (refreshToken ? "refresh" : "pair"),
      pairing_token: pairingToken,
      station_public_id: stationPublicId,
      device_label: deviceLabel,
      refresh_token: refreshToken,
    }),
  }, timeoutMs);
  const body = await readJson(res, clear, timeoutMs);
  if (!res.ok || body?.ok === false) {
    const err = new Error(body?.error?.message || `Pairing failed (${res.status})`);
    err.status = res.status;
    err.code = body?.error?.code;
    err.body = body;
    throw err;
  }
  return body;
}

export function authRedirectUrl() {
  if (typeof window === "undefined") return undefined;
  if (window.tournamentDesktop?.authRedirect) return window.tournamentDesktop.authRedirect;
  if (window.location.protocol === "file:") return "tournament-operator://auth/callback";
  return window.location.origin;
}

export function isRecoveryAuthUrl(rawUrl) {
  if (!rawUrl && typeof window !== "undefined") rawUrl = window.location.href;
  if (!rawUrl) return false;
  try {
    const u = new URL(rawUrl);
    const params = new URLSearchParams(u.hash.replace(/^#/, "") || (u.search.startsWith("?") ? u.search.slice(1) : ""));
    return params.get("type") === "recovery";
  } catch {
    return /(?:^|[?#&])type=recovery(?:&|$)/.test(rawUrl);
  }
}

export async function applyAuthCallback(supabase, rawUrl) {
  if (!rawUrl && typeof window !== "undefined") {
    rawUrl = window.location.href;
  }
  if (!rawUrl) return null;
  let hash = "";
  try {
    const u = new URL(rawUrl);
    hash = u.hash.replace(/^#/, "") || (u.search.startsWith("?") ? u.search.slice(1) : "");
  } catch {
    const i = rawUrl.indexOf("#");
    if (i >= 0) hash = rawUrl.slice(i + 1);
  }
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;
  if (typeof history !== "undefined" && window.location.protocol.startsWith("http")) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return supabase.auth.setSession({ access_token, refresh_token });
}
