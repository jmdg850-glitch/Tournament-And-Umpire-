// Umpire timeout countdown — device-local by design.
//
// A timeout here is a countdown on this umpire device: this module never
// sends a command, never touches the score or the sync outbox, so the
// countdown works fully offline. (The server deliberately refuses "timeout"
// score events from umpires/stations — see packages/api/src/authz.js.)
// Separately, the match screen pauses the game timer on the server for the
// timeout (set_match_timer pause/resume, online only); the optional
// `gamePaused: true` on the record means this device paused it and must
// resume it when the timeout ends.
//
// The record stores an absolute end time, and remaining time is always
// endsAt − now. So backgrounding, screen sleep, leaving and reopening the
// match, or restarting the app can never reset or extend a running timeout.

export const TIMEOUT_DURATIONS_MIN = Object.freeze([1, 2, 3, 5]);
export const MAX_TIMEOUT_MIN = 10;

const KEY_PREFIX = "tournament.umpireTimeout";

export function timeoutStorageKey(owner, matchId) {
  return `${KEY_PREFIX}.${owner || "anon"}.${matchId}`;
}

function isValidRecord(rec) {
  return Boolean(rec)
    && Number.isFinite(rec.startedAt)
    && Number.isFinite(rec.endsAt)
    && Number.isInteger(rec.durationSec)
    && rec.durationSec > 0
    && rec.endsAt - rec.startedAt === rec.durationSec * 1000;
}

// { active, remainingMs } — remainingMs is clamped to [0, durationSec*1000],
// so a device clock moved backwards can't show more time than was granted.
export function timeoutView(rec, now) {
  if (!isValidRecord(rec)) return { active: false, remainingMs: 0 };
  const remainingMs = Math.min(rec.durationSec * 1000, Math.max(0, rec.endsAt - now));
  return { active: remainingMs > 0, remainingMs };
}

// Returns the timeout to show after a start request. An already-running
// timeout is returned unchanged (repeated taps never start a second one);
// an invalid duration returns null.
export function startTimeout(existing, minutes, now) {
  if (timeoutView(existing, now).active) return existing;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMEOUT_MIN) return null;
  if (!Number.isFinite(now)) return null;
  const durationSec = minutes * 60;
  return { startedAt: now, endsAt: now + durationSec * 1000, durationSec };
}

export function readTimeout(storage, owner, matchId) {
  try {
    const raw = storage?.getItem(timeoutStorageKey(owner, matchId));
    if (!raw) return null;
    const rec = JSON.parse(raw);
    return isValidRecord(rec) ? rec : null;
  } catch {
    return null;
  }
}

export function writeTimeout(storage, owner, matchId, rec) {
  try {
    storage?.setItem(timeoutStorageKey(owner, matchId), JSON.stringify(rec));
    return true;
  } catch {
    return false;
  }
}

export function clearMatchTimeout(storage, owner, matchId) {
  try {
    storage?.removeItem(timeoutStorageKey(owner, matchId));
  } catch {
    // Storage unavailable: nothing persisted, nothing to clear.
  }
}
