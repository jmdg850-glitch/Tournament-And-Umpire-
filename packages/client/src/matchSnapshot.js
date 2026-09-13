// Durable, synchronous, single-slot local cache of "the match the umpire had
// open," so a reload while offline can render the last known score instantly
// instead of blocking on a network call. Mirrors the localStorage pattern
// already used by apps/umpire/src/stationSession.js, but — unlike that
// module — wraps the WRITE in try/catch too: a quota-exceeded or
// private-browsing setItem failure here sits inside a render-adjacent effect
// and must never throw out of it.
const KEY = "tournament.umpire.matchSnapshot";

export function readMatchSnapshot() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function writeMatchSnapshot(matchId, match, seq) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ matchId, match, seq, savedAt: Date.now() }));
  } catch {
    // best-effort — losing the snapshot just means a reload-while-offline
    // falls back to today's network-only load, not a crash.
  }
}

export function clearMatchSnapshot() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // no-op
  }
}
