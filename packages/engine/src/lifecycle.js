// Tournament and match status machines — pure, no I/O.

export const TOURNAMENT_STATUSES = Object.freeze([
  "draft",
  "registration",
  "registration_closed",
  "ready",
  "in_progress",
  "completed",
  "cancelled",
  "archived",
]);

export const MATCH_STATUSES = Object.freeze([
  "scheduled",
  "ready",
  "assigned",
  "in_progress",
  "completed",
  "postponed",
  "cancelled",
  "abandoned",
  "bye",
]);

const TOURNAMENT_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["registration", "cancelled"]),
  registration: Object.freeze(["registration_closed", "cancelled"]),
  registration_closed: Object.freeze(["ready", "cancelled"]),
  ready: Object.freeze(["in_progress", "cancelled"]),
  in_progress: Object.freeze(["completed", "cancelled"]),
  completed: Object.freeze(["archived"]),
  cancelled: Object.freeze(["archived"]),
  archived: Object.freeze([]),
});

const MATCH_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(["ready", "assigned", "postponed", "cancelled"]),
  ready: Object.freeze(["assigned", "in_progress", "postponed", "cancelled"]),
  assigned: Object.freeze(["in_progress", "postponed", "cancelled", "ready"]),
  in_progress: Object.freeze(["completed", "abandoned", "postponed"]),
  postponed: Object.freeze(["scheduled", "ready", "cancelled"]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
  abandoned: Object.freeze([]),
  bye: Object.freeze([]),
});

function canTransition(map, from, to) {
  const allowed = map[from];
  if (!allowed) return false;
  return allowed.includes(to);
}

function assertTransition(map, kind, from, to) {
  if (canTransition(map, from, to)) return true;
  const err = new Error(`Illegal ${kind} transition: ${from} -> ${to}`);
  err.code = "ILLEGAL_TRANSITION";
  throw err;
}

export function canTransitionTournament(from, to) {
  return canTransition(TOURNAMENT_TRANSITIONS, from, to);
}

export function assertTransitionTournament(from, to) {
  return assertTransition(TOURNAMENT_TRANSITIONS, "tournament", from, to);
}

export function canTransitionMatch(from, to) {
  return canTransition(MATCH_TRANSITIONS, from, to);
}

export function assertTransitionMatch(from, to) {
  return assertTransition(MATCH_TRANSITIONS, "match", from, to);
}
