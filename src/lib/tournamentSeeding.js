// TOURNAMENT SEEDING METHODS — each function takes an array of registrations and
// returns them reordered, seed 1 first. Pure, no DB. The caller (DivisionDetailPanel)
// applies the result by writing registrations[i].seed = i+1 back via the existing
// updateRegistration outbox kind — that's the field BracketView.jsx already sorts by
// (`a.seed??999`) to seed a freshly-generated bracket. tournament_divisions.seed_order
// exists in the schema but nothing in the bracket-generation code reads it, so writing
// seeding results there would be a silent no-op; this targets the field that's actually
// consumed.

import { mixShuffle } from "./mixmatch.js";

/** Manual: pass-through — the UI's own per-row seed number edits already ARE the order. */
export function seedManual(registrations) {
  return [...(registrations || [])];
}

/** Random: Fisher-Yates shuffle. */
export function seedRandom(registrations) {
  const ids = mixShuffle((registrations || []).map(r => r.id));
  return ids.map(id => registrations.find(r => r.id === id));
}

/**
 * DUPR Rating: sorts by the average of each registration's own self-reported DUPR
 * ratings (captured at registration time, tournament_registrations.player_dupr_ratings).
 * A registration with no DUPR rating on file sorts to the bottom, not the top as 0.
 */
export function seedByDuprRating(registrations) {
  const avgDupr = r => {
    const vals = Object.values(r.playerDuprRatings || {}).map(Number).filter(v => !isNaN(v) && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return [...(registrations || [])].sort((a, b) => {
    const da = avgDupr(a), db = avgDupr(b);
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return db - da;
  });
}

/**
 * Shared by seedByInternalRanking and seedByTeamRanking: a registration's own
 * average app-internal singles/doubles rating (the same RatingEngine-maintained
 * values the Leaderboard reads), matched against the passed-in roster by id. A
 * player not found in the roster (e.g. a manual/guest entrant) falls back to
 * baseRating rather than sorting as NaN/undefined-first.
 */
function pairAverageRating(r, roster, isDoubles, baseRating) {
  const ratingOf = pid => {
    const acct = (roster || []).find(p => p.id === pid);
    if (!acct) return baseRating;
    const v = isDoubles ? acct.doublesRating : acct.singlesRating;
    return typeof v === "number" ? v : baseRating;
  };
  const ids = r.playerIds || [];
  return ids.length ? ids.reduce((sum, id) => sum + ratingOf(id), 0) / ids.length : baseRating;
}

/** Internal Ranking: sorts by each registration's own average internal rating. */
export function seedByInternalRanking(registrations, roster, isDoubles, baseRating = 3) {
  return [...(registrations || [])].sort((a, b) => pairAverageRating(b, roster, isDoubles, baseRating) - pairAverageRating(a, roster, isDoubles, baseRating));
}

/**
 * Team Ranking (Team Elimination only): ranks pairs by their TEAM's average
 * internal rating first — so a team's pairs cluster together in seed order,
 * strongest team first — then by the pair's own rating as a tiebreaker within
 * the team. Reuses the same per-pair rating lookup as seedByInternalRanking.
 * A pair with no teamId is ranked as its own team-of-one.
 */
export function seedByTeamRanking(registrations, roster, isDoubles, baseRating = 3) {
  const list = registrations || [];
  const byTeam = new Map();
  for (const r of list) {
    const key = r.teamId || r.id;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(pairAverageRating(r, roster, isDoubles, baseRating));
  }
  const teamAvg = key => {
    const vals = byTeam.get(key) || [];
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : baseRating;
  };
  return [...list].sort((a, b) => {
    const ta = teamAvg(a.teamId || a.id), tb = teamAvg(b.teamId || b.id);
    if (ta !== tb) return tb - ta;
    return pairAverageRating(b, roster, isDoubles, baseRating) - pairAverageRating(a, roster, isDoubles, baseRating);
  });
}

/**
 * Previous Tournament Results: sorts by each registration's best prior placement.
 * `historyMap` (playerId/accountId -> best rank, 1=champion, pre-resolved by the caller
 * via Cloud.fetchAccountTournamentHistory) keeps this function pure/no-fetch, matching
 * every other lib/tournament*.js module's convention. A registration with no match in
 * historyMap (first-time entrant) sorts to the bottom, never mistaken for the top seed.
 */
export function seedByPreviousResults(registrations, historyMap) {
  const bestRankFor = r => {
    const ids = [...(r.linkedAccountIds || []), ...(r.playerIds || [])];
    const ranks = ids.map(id => historyMap?.[id]).filter(v => typeof v === "number");
    return ranks.length ? Math.min(...ranks) : null;
  };
  return [...(registrations || [])].sort((a, b) => {
    const ra = bestRankFor(a), rb = bestRankFor(b);
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}
