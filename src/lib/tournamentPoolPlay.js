// POOL PLAY + POOL-TO-KNOCKOUT — deliberately thin glue code, not new tournament math.
// Pool play is just N independent round-robins; pool-to-knockout hands the pool
// advancers off to the existing single/double-elimination generators. No new pairing,
// standings, or bracket-advancement algorithm is implemented here — every heavy-lifting
// function is reused as-is from tournamentRoundRobin.js / tournamentStandings.js /
// tournamentBracket.js / tournamentDoubleElimination.js, including the existing odd-size
// virtual-BYE handling (round robin) and phantom-slot cascade (double elimination).

import { generateRoundRobinSchedule } from "./tournamentRoundRobin.js";
import { buildTournamentStandings } from "./tournamentStandings.js";
import { generateBracket } from "./tournamentBracket.js";
import { generateDoubleEliminationBracket } from "./tournamentDoubleElimination.js";

/**
 * Snake-distributes seed-ordered registrations across `poolCount` pools (seed 1 -> pool
 * 1, seed 2 -> pool 2, ..., reversing direction each row) so pool strength is as even as
 * a single seed list can make it. `registrations` should already be seed-sorted
 * (ascending, unseeded last) by the caller — same convention BracketView.jsx already
 * uses for single/double-elim (`sort((a,b)=>(a.seed??999)-(b.seed??999))`).
 * @param {object[]} registrations
 * @param {number} poolCount
 * @param {(i:number)=>string} [makePoolId]
 * @returns {{id:string, registrations:object[]}[]}
 */
export function assignPools(registrations, poolCount, makePoolId) {
  const n = Math.max(1, Math.min(poolCount || 1, registrations.length));
  const pools = Array.from({ length: n }, (_, i) => ({ id: makePoolId ? makePoolId(i) : "pool_" + i, registrations: [] }));
  let dir = 1, idx = 0;
  registrations.forEach(r => {
    pools[idx].registrations.push(r);
    if (dir === 1 && idx === n - 1) dir = -1;
    else if (dir === -1 && idx === 0) dir = 1;
    else idx += dir;
  });
  return pools;
}

/**
 * Round-robin schedule per pool, tagged with poolId. Returns flat tournament_matches-
 * shaped rows without tournamentId/divisionId/organizerId — the caller enriches those,
 * same pattern BracketView.jsx/RoundRobinScheduleView.jsx already use before bulk insert.
 * @param {{id:string, registrations:object[]}[]} pools
 * @param {() => string} [makeId]
 */
export function generatePoolSchedules(pools, makeId) {
  const genId = makeId || (() => "tm_" + Math.random().toString(36).slice(2, 10));
  return pools.flatMap(pool => {
    const { rounds } = generateRoundRobinSchedule(pool.registrations);
    return rounds.flatMap(rnd => rnd.matches.filter(m => !m.isBye).map(m => ({
      id: genId(), poolId: pool.id, round: rnd.round,
      registrationAId: m.registrationAId, registrationBId: m.registrationBId, status: "pending",
    })));
  });
}

/** Standings scoped to one pool — delegates directly to buildTournamentStandings. */
export function buildPoolStandings(pool, matches) {
  return buildTournamentStandings(pool.registrations, matches.filter(m => m.poolId === pool.id));
}

/**
 * Top `advanceCount` per pool, by the existing (tiebreak-aware) standings sort.
 * @returns {object[]} advancing registrations, in pool-then-rank order
 */
export function selectAdvancers(pools, matches, advanceCount) {
  return pools.flatMap(pool => {
    const standings = buildPoolStandings(pool, matches);
    return standings.slice(0, advanceCount)
      .map(row => pool.registrations.find(r => r.id === row.registrationId))
      .filter(Boolean);
  });
}

/**
 * Hands the pool advancers to the existing single/double-elimination generators —
 * from this point on, pool-to-knockout's bracket phase is architecturally identical to
 * a plain single/double-elim division, so advanceTournamentBracket/endMatch (App.jsx)
 * need zero further change to carry it through once these rows are inserted.
 * @param {object[]} advancers seed-ordered (advancer 1 = top seed)
 * @param {"single_elimination"|"double_elimination"} format
 * @param {object} [opts] passed through to the underlying generator (makeId, bronzeMatch)
 */
export function generateKnockoutFromPools(advancers, format, opts = {}) {
  const generate = format === "double_elimination" ? generateDoubleEliminationBracket : generateBracket;
  return generate(advancers, opts);
}
