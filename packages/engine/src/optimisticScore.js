import { applyScoreEvent, createInitialScoreState } from "./scoring.js";

export const UMPIRE_SCORE_EVENT_TYPES = Object.freeze(["point", "undo"]);

export const UMPIRE_FORBIDDEN_COMMANDS = Object.freeze([
  "transition_match",
  "assign_court",
  "assign_umpire",
  "revoke_court_device",
  "open_court_pairing",
  "generate_bracket",
  "generate_team_elimination",
  "generate_team_playoffs",
  "create_tournament",
  "update_tournament",
  "transition_tournament",
  "remove_participant",
]);

export const LIVE_WINDOW_FORBIDDEN_COMMANDS = Object.freeze([
  ...UMPIRE_FORBIDDEN_COMMANDS,
  "start_match",
  "coin_toss",
  "score_event",
  "complete_match",
  "station_sync",
]);

export function isUmpireScoreEventType(type) {
  return UMPIRE_SCORE_EVENT_TYPES.includes(type);
}

export function scoreStateForOptimistic(match, settings = {}) {
  const st = match?.score_state;
  if (st && typeof st === "object" && typeof st.lastSeq === "number") return st;
  return createInitialScoreState(settings);
}

export function applyOptimisticScore(match, event, settings = {}) {
  const state = scoreStateForOptimistic(match, settings);
  const applied = applyScoreEvent(state, event);
  return {
    match: { ...match, score_state: applied.state },
    applied: applied.applied,
    duplicate: applied.duplicate === true,
    state: applied.state,
  };
}

export function mergeMatchFromResult(current, result) {
  if (!current) return result?.match || current;
  if (!result || typeof result !== "object") return current;
  const row = result.match && typeof result.match === "object" ? result.match : null;
  const next = { ...current };
  const src = row || result;
  if (src.status) next.status = src.status;
  if (src.score_state) next.score_state = src.score_state;
  else if (result.score_state) next.score_state = result.score_state;
  if (src.coin_toss != null || result.coin_toss != null) next.coin_toss = src.coin_toss ?? result.coin_toss;
  if (src.serving_team != null || result.serving_team != null) next.serving_team = src.serving_team ?? result.serving_team;
  if (src.winner !== undefined) next.winner = src.winner;
  if (src.started_at != null) next.started_at = src.started_at;
  if (src.completed_at != null) next.completed_at = src.completed_at;
  return next;
}

export function reconcileAuthoritativeScore(localState, authoritativeState) {
  if (!authoritativeState) return { state: localState, replaced: false };
  const localSeq = Number(localState?.lastSeq || 0);
  const authSeq = Number(authoritativeState.lastSeq || 0);
  if (authSeq >= localSeq) return { state: authoritativeState, replaced: true };
  return { state: localState, replaced: false };
}
