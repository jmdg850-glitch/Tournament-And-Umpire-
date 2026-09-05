// TOURNAMENT TEAM FORMATION (Teams tab) — turns a pool of unpaired single-player
// registrations into 2-player teams for a doubles division. Manual mode needs no
// pure function here (organizer-driven pick-two-players UI in TeamsPanel.jsx).
//
// mixmatch.js's buildMixRound(pool,"doubles",hist) is deliberately NOT reused directly
// here — it does team-forming AND THEN pairs the formed teams against each other into
// head-to-head matches, dumping any team that can't find an opponent into `leftovers`
// alongside genuinely-unpaired single players. Reusing it wholesale would misreport an
// odd, opponent-less-but-complete team as two "leftover" individuals. pairAutomatic
// below reuses only the team-forming half of that same cost function (repeat-partner
// avoidance + rating-gap), never the match-pairing half — mixShuffle/mixPairKey are
// reused as-is since those two pieces are correct and unrelated to that bug.

import { mixShuffle, mixPairKey } from "./mixmatch.js";

/**
 * Automatic: greedy nearest-partner pairing that avoids repeat partners (same cost
 * function as buildMixRound's doubles team-forming step) and keeps rating gaps small.
 * @param {{id:string,rating:number}[]} pool
 * @param {{partner?:Record<string,number>}} [hist] mutated in place, same shape as
 *   buildMixRound's hist — pass {} for a stateless one-shot run.
 * @returns {{teams:[string,string][], leftovers:string[]}}
 */
export function pairAutomatic(pool, hist = {}) {
  const partner = hist.partner || (hist.partner = {});
  const rOf = id => { const p = pool.find(x => x.id === id); return p ? (+p.rating || 3) : 3; };
  let ids = mixShuffle((pool || []).map(p => p.id));
  const teams = [], leftovers = [];
  while (ids.length >= 2) {
    const a = ids.shift();
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < ids.length; i++) {
      const b = ids[i];
      const score = (partner[mixPairKey(a, b)] || 0) * 100 + Math.abs(rOf(a) - rOf(b)) * 0.5;
      if (score < bestScore) { bestScore = score; best = i; }
    }
    const b = ids.splice(best, 1)[0];
    teams.push([a, b]);
    partner[mixPairKey(a, b)] = (partner[mixPairKey(a, b)] || 0) + 1;
  }
  leftovers.push(...ids);
  return { teams, leftovers };
}

/**
 * Random: Fisher-Yates shuffle then chunk into pairs — no history/rating awareness.
 * @param {{id:string,rating:number}[]} pool
 * @returns {{teams:[string,string][], leftovers:string[]}}
 */
export function pairRandom(pool) {
  const ids = mixShuffle((pool || []).map(p => p.id));
  const teams = [], leftovers = [];
  while (ids.length >= 2) teams.push([ids.shift(), ids.shift()]);
  leftovers.push(...ids);
  return { teams, leftovers };
}

/**
 * Balanced: snake-seed pairing (rank 1 with rank N, rank 2 with rank N-1, ...) to
 * equalize total team strength across every resulting team — the conventional
 * tournament meaning of "balanced," distinct from Automatic's "pair similar-skill
 * partners together" (which instead minimizes the gap *within* each team).
 * @param {{id:string,rating:number}[]} pool
 * @returns {{teams:[string,string][], leftovers:string[]}}
 */
export function pairBalanced(pool) {
  const sorted = [...(pool || [])].sort((a, b) => (+b.rating || 3) - (+a.rating || 3));
  const teams = [], leftovers = [];
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) { teams.push([sorted[lo].id, sorted[hi].id]); lo++; hi--; }
  if (lo === hi) leftovers.push(sorted[lo].id);
  return { teams, leftovers };
}
