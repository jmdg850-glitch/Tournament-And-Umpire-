// Game timer — a countdown shown alongside a match. It is a time indicator
// only: nothing here reads or changes score_state, status, winner or bracket
// progression, and reaching 00:00 has no effect on the match.
//
// Stored on matches.timer (jsonb, nullable; NULL = no timer):
//   { v: 1, durationSec, remainingMs, runningSince, updatedAt, updatedBy }
// While running, the remaining time is `remainingMs - (now - runningSince)`,
// i.e. every client computes it from the same persisted anchor (deadline =
// runningSince + remainingMs) instead of counting down on its own. Pausing
// banks the remaining time into remainingMs and clears runningSince.
//
// Pure: `now` is always passed in (ISO string or epoch ms), never read here.

export const TIMER_VERSION = 1;
export const MIN_GAME_TIME_SEC = 60;
export const MAX_GAME_TIME_SEC = 3 * 60 * 60;
export const MAX_ADJUST_SEC = 60 * 60;
const MAX_REMAINING_MS = MAX_GAME_TIME_SEC * 1000;

export function isValidGameTimeSec(value) {
  return Number.isInteger(value) && value >= MIN_GAME_TIME_SEC && value <= MAX_GAME_TIME_SEC;
}

export function isValidTimerAdjustSec(value) {
  return Number.isInteger(value) && value !== 0 && Math.abs(value) <= MAX_ADJUST_SEC;
}

function toMs(now) {
  if (typeof now === "number") return Number.isFinite(now) ? now : NaN;
  return typeof now === "string" ? Date.parse(now) : NaN;
}

function toIso(now) {
  const ms = toMs(now);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Anything missing or malformed (including shapes from other versions) is
// "no timer" — callers never throw on bad timer data.
export function normalizeTimer(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (raw.v !== TIMER_VERSION) return null;
  if (!isValidGameTimeSec(raw.durationSec)) return null;
  const remainingMs = Number(raw.remainingMs);
  if (!Number.isFinite(remainingMs) || remainingMs < 0) return null;
  let runningSince = null;
  if (raw.runningSince != null) {
    if (typeof raw.runningSince !== "string" || !Number.isFinite(Date.parse(raw.runningSince))) return null;
    runningSince = raw.runningSince;
  }
  return {
    v: TIMER_VERSION,
    durationSec: raw.durationSec,
    remainingMs: Math.min(Math.round(remainingMs), MAX_REMAINING_MS),
    runningSince,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : null,
  };
}

export function timerRemainingMs(timer, now) {
  const t = normalizeTimer(timer);
  if (!t) return 0;
  if (!t.runningSince) return t.remainingMs;
  const nowMs = toMs(now);
  const since = Date.parse(t.runningSince);
  // A clock behind the anchor never adds time.
  const elapsed = Number.isFinite(nowMs) ? Math.max(0, nowMs - since) : 0;
  return Math.max(0, t.remainingMs - elapsed);
}

function stamp(timer, now, by) {
  return { ...timer, updatedAt: toIso(now), updatedBy: by ?? timer.updatedBy ?? null };
}

export function configureTimer(durationSec, { now, by } = {}) {
  if (!isValidGameTimeSec(durationSec)) return null;
  return stamp({
    v: TIMER_VERSION,
    durationSec,
    remainingMs: durationSec * 1000,
    runningSince: null,
    updatedAt: null,
    updatedBy: null,
  }, now, by);
}

export function timerFromDivisionConfig(config, meta) {
  const sec = config?.gameTimeSeconds;
  return isValidGameTimeSec(sec) ? configureTimer(sec, meta) : null;
}

// Called only from the real match-start transition. Already running → unchanged
// (starting never restarts the countdown).
export function startTimer(timer, now) {
  const t = normalizeTimer(timer);
  if (!t) return null;
  if (t.runningSince) return t;
  return { ...t, runningSince: toIso(now) };
}

export function pauseTimer(timer, now) {
  const t = normalizeTimer(timer);
  if (!t) return null;
  if (!t.runningSince) return t;
  return { ...t, remainingMs: timerRemainingMs(t, now), runningSince: null };
}

export function adjustTimer(timer, deltaSec, { now, by } = {}) {
  const t = normalizeTimer(timer);
  if (!t || !isValidTimerAdjustSec(deltaSec)) return null;
  const remaining = timerRemainingMs(t, now) + deltaSec * 1000;
  return stamp({
    ...t,
    remainingMs: Math.min(Math.max(0, remaining), MAX_REMAINING_MS),
    runningSince: t.runningSince ? toIso(now) : null,
  }, now, by);
}

export function resetTimer(timer, { now, by } = {}) {
  const t = normalizeTimer(timer);
  if (!t) return null;
  return stamp({
    ...t,
    remainingMs: t.durationSec * 1000,
    runningSince: t.runningSince ? toIso(now) : null,
  }, now, by);
}

const FINISHED_STATUSES = new Set(["completed", "cancelled", "abandoned", "bye"]);

// What a screen shows. Counts down only while the match is in_progress; a
// completed match is frozen at completed_at, so reopening it never resumes.
//   none       no (valid) timer
//   configured set, match not started yet
//   running    counting down
//   paused     match on hold / resumed-but-not-restarted
//   expired    reached 00:00 (the match itself is untouched)
//   finished   match is over; remainingMs is the time left when it ended
export function timerView(match, now) {
  const t = normalizeTimer(match?.timer);
  if (!t) return { state: "none", remainingMs: 0, durationSec: 0 };
  const base = { durationSec: t.durationSec };
  const status = match?.status;
  if (FINISHED_STATUSES.has(status)) {
    const endMs = Date.parse(match?.completed_at);
    const remainingMs = t.runningSince
      ? timerRemainingMs(t, Number.isFinite(endMs) ? endMs : now)
      : t.remainingMs;
    return { ...base, state: "finished", remainingMs };
  }
  if (status === "in_progress" && t.runningSince) {
    const remainingMs = timerRemainingMs(t, now);
    return { ...base, state: remainingMs <= 0 ? "expired" : "running", remainingMs };
  }
  const remainingMs = t.runningSince ? timerRemainingMs(t, now) : t.remainingMs;
  if (remainingMs <= 0) return { ...base, state: "expired", remainingMs: 0 };
  const untouched = !t.runningSince && remainingMs === t.durationSec * 1000;
  const notStarted = ["scheduled", "ready", "assigned"].includes(status);
  return { ...base, state: notStarted && untouched ? "configured" : "paused", remainingMs };
}

// MM:SS, never negative. Rounds up so the display reads 00:00 only once the
// time has actually run out.
export function formatClock(ms) {
  const total = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
