import { useSyncExternalStore } from "react";
import { Cloud } from "./cloud.js";

// =
// LIVE MATCH BOARD — a shared, real-time store for every logged-in user (spectator/player
// read-only view). Mirrors the `Log` store above exactly (getSnapshot/subscribe/emit paired
// with useSyncExternalStore) so subscribing components re-render on live data changes without
// ever touching App()'s own state — a score change on someone else's court never triggers a
// re-render of the whole app tree, only of the specific components that call useLiveBoard().
// Lazily opens one Supabase Realtime channel (+ a 15s fallback poll, in case Realtime isn't
// enabled on the project) the first time any component subscribes, and tears both down when
// the last subscriber unmounts.
// =
export const LiveBoard = (() => {
  let matches = [], sessions = [];
  // False until the very first refetch() actually completes. App.jsx's
  // reconcileOwnLiveMatches uses this to know the difference between "confirmed
  // nothing of mine is live remotely" and "haven't heard back yet" — without it,
  // every fresh mount briefly presents an empty `matches` snapshot (the initial
  // module state, before this async call has ever run), and unconditional prune
  // logic reading that snapshot would cancel the user's own genuinely-still-live
  // matches on nothing more than a page reload.
  let hasLoadedOnce = false;
  let snapshot = { matches, sessions, hasLoadedOnce };
  const listeners = new Set();
  let channel = null, pollTimer = null, refCount = 0;

  const emit = () => { snapshot = { matches, sessions, hasLoadedOnce }; listeners.forEach(fn => { try { fn(); } catch{ /* best-effort, safe to ignore */ } }); };

  const refetch = async () => {
    try {
      const [m, s] = await Promise.all([Cloud.fetchLiveMatches(), Cloud.fetchLiveSessions()]);
      // null means "fetch failed" (see Cloud.fetchLiveMatches/fetchLiveSessions) — keep the
      // last-known-good snapshot rather than wiping the board to empty on a transient error,
      // which would otherwise look identical to "confirmed: nothing is live" to every consumer.
      if (m !== null) matches = m;
      if (s !== null) sessions = s;
      hasLoadedOnce = true;
      emit();
    } catch{ /* best-effort, safe to ignore */ }
  };

  const start = async () => {
    if (!Cloud.enabled) return;
    await refetch();
    channel = await Cloud.subscribeLiveBoard({
      onMatchChange: (row, evt) => {
        matches = evt === "DELETE" ? matches.filter(m => m.id !== row.id) : [...matches.filter(m => m.id !== row.id), row];
        emit();
      },
      onSessionChange: (row, evt) => {
        sessions = evt === "DELETE" ? sessions.filter(s => s.organizerId !== row.organizerId) : [...sessions.filter(s => s.organizerId !== row.organizerId), row];
        emit();
      },
    });
    // Fallback: keeps the board fresh even if Realtime replication isn't enabled on the
    // project (see supabase_migration_v3_live_board.sql) — independent of App()'s own 10s sync.
    pollTimer = setInterval(refetch, 15000);
  };

  const stop = () => {
    if (channel) { Cloud.unsubscribeLiveBoard(channel); channel = null; }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      if (++refCount === 1) start();
      return () => { listeners.delete(fn); if (--refCount === 0) stop(); };
    },
    getSnapshot: () => snapshot,
  };
})();
// React hook: subscribe a component to the live match board (matches + organizer sessions).
export function useLiveBoard() {
  return useSyncExternalStore(LiveBoard.subscribe, LiveBoard.getSnapshot, LiveBoard.getSnapshot);
}
