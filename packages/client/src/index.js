import { createClient } from "@supabase/supabase-js";

export { isNetworkError, createMemoryStore, createIndexedDBStore, defaultStore, sendCommandDurable, drainQueue, queueSize } from "./offlineQueue.js";

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

export async function sendCommand({ commandUrl, accessToken, publishableKey, type, payload, commandId }) {
  const command_id = commandId || crypto.randomUUID();
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  const res = await fetch(commandUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      apikey: publishableKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command_id, type, payload }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: { code: "BAD_RESPONSE", message: res.statusText } };
  }
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

export async function pairStation({ pairStationUrl, publishableKey, pairingToken, stationPublicId, deviceLabel, refreshToken, action }) {
  const res = await fetch(pairStationUrl, {
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
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { ok: false, error: { code: "BAD_RESPONSE", message: res.statusText } };
  }
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
