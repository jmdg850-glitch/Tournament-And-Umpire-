// "Last known good" handling for list screens (the umpire's match list and
// court queue): a failed load must never replace data the server already
// gave us — only a SUCCESSFUL response (even an empty one) may change it.
//
// supabase-js (postgrest-js) does not throw when the network is gone: it
// resolves `{ data: null, error: { message: "TypeError: Failed to fetch" },
// status: 0 }`. Treating that like any other error is what blanked the
// umpire dashboard when Wi-Fi was turned off.

import { safeStorage } from "./safeStorage.js";

// Classify a failed load. Accepts either a postgrest result
// (`{ error, status }`) or a thrown error (`sendCommand`'s err.status, or a
// plain TypeError). Returns null when there is no failure.
//   "network"   — never reached the server / no answer (offline, DNS, timeout)
//   "auth"      — 401: session/credential problem (not "offline")
//   "forbidden" — 403: genuine permission refusal (not "offline")
//   "server"    — 5xx / 408 / 429: temporary server-side failure
//   "app"       — anything else (malformed response, 4xx validation, …)
export function classifyQueryFailure(resultOrError) {
  if (!resultOrError) return null;
  const isResult = Object.prototype.hasOwnProperty.call(resultOrError, "error")
    && (Object.prototype.hasOwnProperty.call(resultOrError, "data") || Object.prototype.hasOwnProperty.call(resultOrError, "status"));
  if (isResult && !resultOrError.error) return null;
  const status = resultOrError.status;
  // No HTTP status (postgrest reports 0) means no answer from the server.
  if (status == null || Number(status) === 0) return "network";
  const n = Number(status);
  if (n === 401) return "auth";
  if (n === 403) return "forbidden";
  if (n >= 500 || n === 408 || n === 429) return "server";
  return "app";
}

export const INITIAL_LOAD_STATE = Object.freeze({
  rows: null,
  meta: null,
  status: "loading",
  error: "",
  lastUpdatedAt: null,
  source: null,
});

const FAILURE_STATUS = { network: "offline", auth: "auth", forbidden: "forbidden", server: "server", app: "error" };

// Pure reducer: { ok: true, rows, meta, at } replaces the data (an empty
// array is a real, server-confirmed "nothing"); { ok: false, kind, message }
// keeps whatever rows/meta we already had and only records the failure.
export function applyLoadOutcome(prev, outcome) {
  const base = prev || INITIAL_LOAD_STATE;
  if (outcome?.ok) {
    return {
      rows: outcome.rows ?? [],
      meta: outcome.meta ?? null,
      status: "online",
      error: "",
      lastUpdatedAt: outcome.at ?? Date.now(),
      source: "server",
    };
  }
  return {
    ...base,
    status: FAILURE_STATUS[outcome?.kind] || "error",
    error: outcome?.message || "Something went wrong",
  };
}

// One user-facing connection/freshness state for a screen, derived from its
// load state (applyLoadOutcome) and the signed-in identity mode
// (offlineIdentity.js). Never exposes a raw "Failed to fetch".
//   kind: "online" | "refreshing" | "offline-cached" | "offline-empty" |
//         "offline-unverified" | "server" | "auth" | "forbidden" | "error"
export function deriveConnectionState({ load, identityMode } = {}) {
  const state = load || INITIAL_LOAD_STATE;
  const hasData = Array.isArray(state.rows) ? true : state.rows != null;
  const savedAt = state.lastUpdatedAt ?? null;
  if (identityMode === "offline-unverified") {
    return {
      kind: "offline-unverified",
      tone: "warn",
      label: hasData
        ? "Offline — sign-in not verified. Showing data saved on this device; changes need an internet connection."
        : "Offline — sign-in not verified, and nothing is saved on this device for this screen yet.",
      savedAt,
      hasData,
    };
  }
  switch (state.status) {
    case "online":
      return { kind: "online", tone: "ok", label: "Up to date", savedAt, hasData };
    case "loading":
      return hasData && state.source === "cache"
        ? { kind: "refreshing", tone: "info", label: "Showing saved data — refreshing…", savedAt, hasData }
        : { kind: "refreshing", tone: "info", label: "Loading…", savedAt, hasData };
    case "offline":
      return hasData
        ? { kind: "offline-cached", tone: "warn", label: "Offline — working from saved tournament data.", savedAt, hasData }
        : { kind: "offline-empty", tone: "warn", label: "Offline — this isn't saved on this device yet. Open it once while online to use it offline.", savedAt, hasData };
    case "server":
      return { kind: "server", tone: "warn", label: hasData ? "Server unavailable — showing saved data. Retrying automatically." : "Server unavailable — retrying automatically.", savedAt, hasData };
    case "auth":
      return { kind: "auth", tone: "danger", label: "Your sign-in needs to be refreshed. Sign in again (internet required).", savedAt, hasData };
    case "forbidden":
      return { kind: "forbidden", tone: "danger", label: "You don't have access to this.", savedAt, hasData };
    default:
      return { kind: "error", tone: "danger", label: state.error || "Something went wrong.", savedAt, hasData };
  }
}

// Seed the reducer state from a cached snapshot (cold start, possibly offline).
export function stateFromCache(cached) {
  if (!cached || !Array.isArray(cached.rows)) return INITIAL_LOAD_STATE;
  return { ...INITIAL_LOAD_STATE, rows: cached.rows, meta: cached.meta ?? null, lastUpdatedAt: cached.savedAt ?? null, source: "cache" };
}

// Tiny per-owner localStorage snapshot of the last successful list load.
// Synchronous on purpose so a cold start (even offline) renders instantly;
// never throws (quota/private mode/corrupt JSON just behave as "no cache").
export function createDashboardCache(key, storage = safeStorage()) {
  return {
    read() {
      if (!key || !storage) return null;
      try {
        const raw = storage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && Array.isArray(parsed.rows) ? parsed : null;
      } catch {
        return null;
      }
    },
    write({ rows, meta, savedAt = Date.now() }) {
      if (!key || !storage) return;
      try {
        storage.setItem(key, JSON.stringify({ rows, meta, savedAt }));
      } catch {
        // best-effort
      }
    },
  };
}

