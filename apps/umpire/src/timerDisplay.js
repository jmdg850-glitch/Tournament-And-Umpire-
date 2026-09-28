// Game timer display for the umpire's LOCAL view (display only).
//
// A winning point scored offline completes the game in the local score, but
// the match row stays in_progress until that point syncs and the server
// completes it. Without this, the countdown would keep running (and could hit
// 00:00) after the game is already over on this device.
//
// markLocalCompletion tags the reconstructed view match with the time the
// winning point was recorded on this device; timerDisplayMatch hands timerView
// a completed copy so the clock freezes there. Nothing here is persisted or
// sent: the view is rebuilt from the saved match + queued actions on every
// change, so undoing the winning point drops the tag, and once the server's
// completed match is the saved base its own completed_at takes over.

function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function markLocalCompletion(prev, next, entry) {
  if (!next || next.status !== "in_progress") return next;
  if (next.score_state?.status !== "completed") {
    // e.g. the winning point was undone: the clock runs again.
    if (!next.localCompletedAt) return next;
    const { localCompletedAt: _dropped, ...rest } = next;
    return rest;
  }
  if (next.localCompletedAt) return next;
  if (prev?.score_state?.status === "completed") return next;
  const at = isoOf(Number(entry?.queuedAt));
  return at ? { ...next, localCompletedAt: at } : next;
}

export function timerDisplayMatch(match) {
  if (!match || match.status !== "in_progress" || !match.localCompletedAt) return match;
  return { ...match, status: "completed", completed_at: match.localCompletedAt };
}
