// Pure helpers behind the Operator's offline behaviour (dashboard and desk
// loads, command failure messages). Kept free of React so they can be tested
// with node --test.
import { classifyQueryFailure } from "@tournament/client";
import { isFresherRow } from "@tournament/engine";
import { isToday } from "./lib.js";

// Turns the dashboard's 7 list queries into a load outcome for
// applyLoadOutcome(): { ok:true, rows, meta, at } on success, or
// { ok:false, kind, message } — "network" when the server couldn't be
// reached, so existing/saved rows are kept instead of being blanked.
// `court_devices` (index 6) is optional, exactly as before.
export function dashboardFromQueries(queries, at = Date.now()) {
  const failed = queries.slice(0, 6).find((q) => q?.error);
  if (failed) {
    return { ok: false, kind: classifyQueryFailure(failed) || "app", message: failed.error?.message || "Could not load the dashboard" };
  }
  const [t, matches, courts, persons, teams, umpires, devices] = queries;
  const tournaments = t.data || [];
  const matchRows = matches.data || [];
  const deviceRows = devices?.error ? [] : devices?.data || [];
  return {
    ok: true,
    at,
    rows: tournaments,
    meta: {
      recentMatches: matchRows,
      courtDevices: deviceRows.map((d) => ({ id: d.id, status: d.status, court_id: d.court_id, tournament_id: d.tournament_id })),
      metrics: {
        tournaments: tournaments.length,
        active: tournaments.filter((x) => ["registration", "registration_closed", "ready", "in_progress"].includes(x.status)).length,
        today: matchRows.filter((m) => isToday(m.started_at || m.created_at)).length,
        live: matchRows.filter((m) => m.status === "in_progress").length,
        ready: matchRows.filter((m) => m.status === "ready" || m.status === "assigned").length,
        scheduled: matchRows.filter((m) => m.status === "scheduled").length,
        completed: matchRows.filter((m) => m.status === "completed" || m.status === "bye").length,
        courts: (courts.data || []).length,
        paired: devices?.error ? 0 : deviceRows.filter((d) => d.status === "active").length,
        umpires: new Set((umpires.data || []).map((u) => u.user_id)).size,
        players: (persons.data || []).length,
        teams: (teams.data || []).length,
      },
    },
  };
}

// Load-state shape for tournament-desk data ({ rows: data, ...info } is what
// OfflineStatusBanner / deriveConnectionState read).
export const INITIAL_LOAD_INFO = Object.freeze({ status: "loading", source: null, lastUpdatedAt: null, error: "" });
export const LOAD_FAILURE_STATUS = Object.freeze({ network: "offline", auth: "auth", forbidden: "forbidden", server: "server", app: "error" });

// loadDeskData() result → load outcome. `data` is kept as a single row-like
// object so the same reducer (keep-last-known-good) applies.
// `status` is the failing query's HTTP status (0 = no answer), which is what
// separates "offline" from a real server/permission error.
export function deskOutcome({ data, error, status }, at = Date.now()) {
  if (error) return { ok: false, kind: classifyQueryFailure({ error, status }) || "app", message: error.message || "Could not load this tournament" };
  return { ok: true, rows: data, at };
}

// A command that got no answer (offline, DNS, timeout). The server MAY have
// applied it (a lost response), so it is never described as "not saved".
export function commandFailureError(cause, commandId) {
  const message = cause?.timeout
    ? "No response from the server — this change was not confirmed. It may or may not have been saved; check after the tournament refreshes before trying again."
    : "Couldn't reach the server — this change was not confirmed. Organizer changes need an internet connection; check after reconnecting before trying again.";
  const err = new Error(message, { cause });
  err.code = "OFFLINE";
  err.commandId = commandId;
  return err;
}

// A command attempted while working offline with an unverified sign-in:
// nothing was sent at all.
export function offlineUnverifiedError() {
  const err = new Error("You're offline and your sign-in hasn't been verified — this change was NOT sent. Organizer changes need an internet connection.");
  err.code = "OFFLINE";
  return err;
}

// Relative "saved 5 min ago" style label for a saved-data timestamp.
export function savedAtLabel(savedAt, now = Date.now()) {
  if (!savedAt) return "";
  const mins = Math.round((now - savedAt) / 60000);
  if (mins < 1) return "saved just now";
  if (mins < 60) return `saved ${mins} min ago`;
  const at = new Date(savedAt);
  const sameDay = new Date(now).toDateString() === at.toDateString();
  return `saved ${sameDay ? at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : at.toLocaleString()}`;
}

// A server read that started before a realtime update can arrive after it.
// Take the server's list (it is authoritative about which matches exist),
// but never replace a match row with an older version of itself — the same
// rule realtime updates follow (isFresherRow: score seq, then updated_at).
export function mergeServerMatches(current, incoming) {
  const byId = new Map((current || []).map((m) => [m.id, m]));
  return (incoming || []).map((row) => {
    const mine = byId.get(row.id);
    return mine && !isFresherRow(mine, row) ? mine : row;
  });
}

// Single-match form of mergeServerMatches, for the Live Match window: the
// match to show after a server read, never an older version of the one
// already on screen.
export function keepFresherMatch(current, incoming) {
  if (!incoming) return current ?? null;
  return mergeServerMatches(current ? [current] : [], [incoming])[0];
}
