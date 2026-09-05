// TOURNAMENT UMPIRE — pure permission helpers, tournament-match-only concept.
// Deliberately a separate sibling file to mixmatch.js/tournamentPermissions.js rather
// than folded into canControlMatch itself: umpire assignment only ever exists on a
// match that carries a tournamentMatchId (umpireId is threaded onto the live match's
// data the same way tournamentMatchId already is), so casual/mixmatch match
// permission logic is completely untouched by this file — zero regression risk to
// Open Play or non-tournament Live Matches.

/** @param {object} match @param {{id:string}} currentUser */
export function isAssignedUmpire(match, currentUser) {
  return !!(match?.umpireId && currentUser?.id && match.umpireId === currentUser.id);
}

/**
 * Widens an existing canControlMatch(...)-style result with the umpire check —
 * never narrows it. The organizer/co-organizer/admin result is always ORed with
 * "is this the assigned umpire," so organizer control is never reduced by this
 * feature (satisfies "organizer permissions always override umpire permissions"
 * trivially, since both simply get full control simultaneously).
 * @param {boolean} baseControl result of the existing canControlMatch(...) check
 * @param {object} match @param {{id:string}} currentUser
 */
export function canControlOrUmpire(baseControl, match, currentUser) {
  return baseControl || isAssignedUmpire(match, currentUser);
}
