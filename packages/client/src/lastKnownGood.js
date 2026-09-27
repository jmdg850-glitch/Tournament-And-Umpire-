// "Last known good" handling for list screens (the umpire's match list and
// court queue): a failed load must never replace data the server already
// gave us — only a SUCCESSFUL response (even an empty one) may change it.
//
// supabase-js (postgrest-js) does not throw when the network is gone: it
// resolves `{ data: null, error: { message: "TypeError: Failed to fetch" },
// status: 0 }`. Treating that like any other error is what blanked the
// umpire dashboard when Wi-Fi was turned off.

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

function safeStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
