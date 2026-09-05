// Team Elimination's configurable qualification + same-team-aware knockout
// bracket — pure, no DB, no React. Generalizes what used to be a single
// hardcoded function (tournamentTeamRoundRobin.js's old
// generateIndividualPlayoffShell, fixed at exactly 4 qualifiers, no team
// quota, no same-team avoidance) into three composable pieces:
//   1. selectQualifiers - WHO advances (Top 4 Overall / Top X Per Team /
//      Manual passthrough), never touching the underlying ranking order.
//   2. placeQualifiersWithPolicy - WHERE they're seeded into the bracket,
//      same-team-avoidance-aware but still seed-order-driven (ranking still
//      decides seed strength; only the SLOT a seed lands in ever moves).
//   3. generateQualifierBracketShell - the actual multi-round TBD shell
//      (Quarterfinal/Semifinal/Bronze/Final, or Round of 16 + deeper for
//      bigger fields), same two-layer team-matchup + single-pair-match
//      convention as every other team_elimination stage.
//
// Same-team avoidance is a bracket-PLACEMENT concern only, decided once at
// generation time from the ranked seed list — it can never re-arrange actual
// results once real matches are played (advanceIndividualMatchup/
// advanceBronzeIndividualMatchup, tournamentTeamVsTeam.js, are untouched
// pointer-followers and stay that way), which is exactly what lets a
// same-team Final happen legitimately when two same-team pairs each win
// their own half of the bracket.

import { seedOrder } from "./tournamentBracket.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

function nextPow2(n){ let s = 1; while (s < n) s *= 2; return s; }

// Each Same-Team Matchup Policy reduces to a "pod size" within the standard
// seed-mirroring bracket structure seedOrder() already encodes: adjacent
// 2-slot groups are round-1 opponents, 4-slot groups are everyone who could
// reach a given semifinal slot, size/2-slot groups are a full bracket HALF
// (everyone who could reach a given FINAL slot). Clamped to size/2 so no
// policy can ever forbid a same-team FINAL (requirement: only actual
// semifinal results decide the Final, never the placement policy).
export function podSizeForPolicy(policy, size){
  const base = { avoid_quarterfinals: 2, avoid_semis: 4, avoid_until_final: Infinity }[policy] || 0;
  return base === 0 ? 0 : Math.min(base, size / 2);
}

function teamOfSeedFactory(qualifiers){
  return seed => (seed != null && seed <= qualifiers.length) ? qualifiers[seed - 1].teamId : null;
}

function podHasTeam(order, teamOf, podStart, podSize, team, excludeSlot){
  for (let i = podStart; i < podStart + podSize; i++){
    if (i === excludeSlot) continue;
    if (teamOf(order[i]) === team) return true;
  }
  return false;
}

// One bounded, deterministic repair pass — no retry-until-lucky, no
// backtracking, so it provably terminates (single `for` over every excess
// slot, each doing an O(size) scan). Every pod with 2+ same-team qualifiers
// keeps its FIRST-encountered occurrence (favors seedOrder's own convention
// of placing the stronger seed of a pair first) and tries to swap every
// later ("excess") occurrence with a slot in a DIFFERENT pod that (a) isn't
// already occupied by that same team and (b) doesn't hand the excess team's
// slot's own former occupant into a new conflict either. Among valid swaps,
// picks the one with the smallest seed-rank displacement (priority: minimize
// conflicts first, minimize seed displacement second, per spec). Whatever
// can't be resolved in this single pass is left as-is and reported in
// `conflicts` — this is the deterministic, non-looping handling of the
// "same-team separation is mathematically impossible" case.
function repairPods(order, qualifiers, podSize){
  const result = [...order];
  const size = result.length;
  const teamOf = teamOfSeedFactory(qualifiers);

  const excessSlots = [];
  for (let podStart = 0; podStart < size; podStart += podSize){
    const seen = new Set();
    for (let i = podStart; i < podStart + podSize; i++){
      const team = teamOf(result[i]);
      if (team == null) continue;
      if (seen.has(team)) excessSlots.push(i); else seen.add(team);
    }
  }

  for (const i of excessSlots){
    const podStartI = Math.floor(i / podSize) * podSize;
    const teamI = teamOf(result[i]);
    if (teamI == null) continue; // defensive — excess slots always carried a real team when queued
    let best = null, bestCost = Infinity;
    for (let j = 0; j < size; j++){
      const podStartJ = Math.floor(j / podSize) * podSize;
      if (podStartJ === podStartI) continue; // swap partner must be outside the conflicted pod
      const teamJ = teamOf(result[j]);
      if (teamJ != null && podHasTeam(result, teamOf, podStartI, podSize, teamJ, i)) continue;
      if (podHasTeam(result, teamOf, podStartJ, podSize, teamI, j)) continue;
      const cost = Math.abs(result[i] - result[j]);
      if (cost < bestCost){ bestCost = cost; best = j; }
    }
    if (best != null){ const tmp = result[i]; result[i] = result[best]; result[best] = tmp; }
  }
  return result;
}

function detectConflicts(order, qualifiers, podSize){
  if (podSize < 2) return [];
  const teamOf = teamOfSeedFactory(qualifiers);
  const conflicts = [];
  for (let podStart = 0; podStart < order.length; podStart += podSize){
    const seenAt = new Map();
    for (let i = podStart; i < podStart + podSize; i++){
      const team = teamOf(order[i]);
      if (team == null) continue;
      if (seenAt.has(team)) conflicts.push({ teamId: team, slots: [seenAt.get(team), i] });
      else seenAt.set(team, i);
    }
  }
  return conflicts;
}

// qualifiers: rank-ordered [{registrationId,teamId,...}], qualifiers[0] = seed 1.
// Returns { order, conflicts, size } — order is bracket-slot-ordered (length
// = next power of 2 >= qualifiers.length), each entry either a qualifier
// object or null (BYE). BYE slots never count toward a conflict.
export function placeQualifiersWithPolicy(qualifiers, policy){
  const size = nextPow2(qualifiers.length);
  const podSize = podSizeForPolicy(policy, size);
  let seedSlots = seedOrder(size);
  if (podSize > 1) seedSlots = repairPods(seedSlots, qualifiers, podSize);
  const conflicts = detectConflicts(seedSlots, qualifiers, podSize);
  const order = seedSlots.map(s => s <= qualifiers.length ? qualifiers[s - 1] : null);
  return { order, conflicts, size };
}

// WHO qualifies — never team-adjusted, always preserves rankedPairs' own
// overall-performance order (requirement: Team identity must not modify
// ranking, only the separate matchup-placement step below may use it).
// rankedPairs: output of rankIndividualPairsForSemifinals (tournamentTeamRoundRobin.js).
export function selectQualifiers(rankedPairs, mode, count){
  if (mode === "top_x") return rankedPairs.slice(0, 4); // "Top 4 Overall" — fixed, not organizer-configurable
  if (mode === "top_x_per_team"){
    const perTeamCount = new Map();
    const keepIds = new Set();
    for (const p of rankedPairs){
      const c = perTeamCount.get(p.teamId) || 0;
      if (c < count){ keepIds.add(p.registrationId); perTeamCount.set(p.teamId, c + 1); }
    }
    return rankedPairs.filter(p => keepIds.has(p.registrationId));
  }
  return []; // "manual": caller filters rankedPairs by its own organizer-selected id list instead
}

function knockoutStageLabel(fromFinal){
  if (fromFinal === 1) return "Semifinal";
  if (fromFinal === 2) return "Quarterfinal";
  return "Round of " + Math.pow(2, fromFinal + 1);
}

function buildFinalShell(id, round){
  return { id, round, bracketPosition: 0, teamAId: null, teamBId: null, pairAId: null, pairBId: null,
    teamAWins: 0, teamBWins: 0, pairsPerMatchup: 1, winnerTeamId: null, status: "pending",
    stage: "final", stageLabel: "Final" };
}
function buildBronzeShell(id, round){
  return { id, round, bracketPosition: 1, teamAId: null, teamBId: null, pairAId: null, pairBId: null,
    teamAWins: 0, teamBWins: 0, pairsPerMatchup: 1, winnerTeamId: null, status: "pending",
    bracketSide: "bronze", stage: "bronze", stageLabel: "Bronze Match" };
}
function buildChildMatch(genId, matchup){
  return { id: genId(), round: matchup.round, bracketPosition: matchup.bracketPosition,
    registrationAId: matchup.pairAId, registrationBId: matchup.pairBId,
    status: "pending", winner: null, teamMatchupId: matchup.id, pairSlot: 1 };
}

// Generalizes the old fixed-4 generateIndividualPlayoffShell to any qualifier
// count >= 2 (BYEs to top seeds for non-power-of-2 counts, exactly like
// tournamentBracket.js's generateBracket), any number of pre-final knockout
// rounds (Quarterfinal/Round of 16/... as needed), and same-team-policy-aware
// seed placement. `qualifiers`: already the selected/ordered subset from
// selectQualifiers (or a manual-mode filter) — qualifiers[0] is seed 1.
// Bronze is always generated (never optional for this format, unlike plain
// single elimination's opt-in bronzeMatch flag).
export function generateQualifierBracketShell(qualifiers, { makeId, startRound = 1, sameTeamPolicy = "allow_anywhere" } = {}){
  const genId = makeId || defaultId;
  const M = qualifiers.length;
  if (M < 2) return { teamMatchups: [], pairMatches: [], conflicts: [] };

  // Exactly 2 qualifiers: straight to a Final, both competitors already known
  // — no Semifinal (nobody left to play it) and no Bronze (nobody to fill it).
  if (M === 2){
    const final = { ...buildFinalShell(genId(), startRound),
      teamAId: qualifiers[0].teamId, teamBId: qualifiers[1].teamId,
      pairAId: qualifiers[0].registrationId, pairBId: qualifiers[1].registrationId };
    return { teamMatchups: [final], pairMatches: [buildChildMatch(genId, final)], conflicts: [] };
  }

  const { order, conflicts, size } = placeQualifiersWithPolicy(qualifiers, sameTeamPolicy);
  const knockoutRounds = Math.log2(size) - 1; // rounds 1..knockoutRounds; the LAST one feeds Bronze

  const rounds = [];
  let roundSize = size / 2;
  for (let r = 0; r < knockoutRounds; r++){
    const fromFinal = knockoutRounds - r;
    const shells = [];
    for (let i = 0; i < roundSize; i++){
      shells.push({
        id: genId(), round: startRound + r, bracketPosition: i,
        teamAId: null, teamBId: null, pairAId: null, pairBId: null,
        teamAWins: 0, teamBWins: 0, pairsPerMatchup: 1, winnerTeamId: null, status: "pending",
        stage: fromFinal === 1 ? "semifinal" : "knockout",
        stageLabel: knockoutStageLabel(fromFinal),
      });
    }
    rounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize / 2));
  }

  // Round 1: fill directly from the policy-aware placement; BYE slots resolve
  // immediately (mirrors generateBracket's own round-1 bye handling).
  for (let i = 0; i < rounds[0].length; i++){
    const a = order[i * 2], b = order[i * 2 + 1];
    const m = rounds[0][i];
    m.teamAId = a?.teamId ?? null; m.pairAId = a?.registrationId ?? null;
    m.teamBId = b?.teamId ?? null; m.pairBId = b?.registrationId ?? null;
    if (!a || !b){ m.status = "bye"; m.winnerTeamId = a ? a.teamId : b.teamId; }
  }

  // Wire nextMatchupId/nextMatchupSlot for every round, propagating a BYE's
  // auto-winner into the next round's slot immediately at generation time —
  // real match completions propagate later via advanceIndividualMatchup,
  // unchanged, but a BYE has no match to complete so this is the only chance.
  for (let r = 0; r < rounds.length - 1; r++){
    for (let i = 0; i < rounds[r].length; i++){
      const m = rounds[r][i];
      const next = rounds[r + 1][Math.floor(i / 2)];
      m.nextMatchupId = next.id;
      m.nextMatchupSlot = i % 2 === 0 ? "A" : "B";
      if (m.status === "bye"){
        const pairId = m.winnerTeamId === m.teamAId ? m.pairAId : m.pairBId;
        if (m.nextMatchupSlot === "A"){ next.teamAId = m.winnerTeamId; next.pairAId = pairId; }
        else { next.teamBId = m.winnerTeamId; next.pairBId = pairId; }
      }
    }
  }

  // Final + Bronze — unconditional TBD shells, wired ONLY off the true
  // semifinal round (the last entry in `rounds`), identical convention to
  // generateBracket's own bronzeMatch wiring.
  const semis = rounds[knockoutRounds - 1];
  const final = buildFinalShell(genId(), startRound + knockoutRounds);
  const bronze = buildBronzeShell(genId(), startRound + knockoutRounds);
  semis[0].nextMatchupId = final.id; semis[0].nextMatchupSlot = "A";
  semis[0].loserNextMatchupId = bronze.id; semis[0].loserNextMatchupSlot = "A";
  semis[1].nextMatchupId = final.id; semis[1].nextMatchupSlot = "B";
  semis[1].loserNextMatchupId = bronze.id; semis[1].loserNextMatchupSlot = "B";

  const knockoutShells = rounds.flat();

  // Child pair-match rows: built immediately for every non-BYE shell whose
  // both competitors are already known — round 1 always qualifies; a later
  // round can too, if cascading BYEs from round 1 filled both of its slots
  // without either side ever playing a real match. Final/Bronze always stay
  // TBD here — built lazily by the caller once real knockout results fill
  // them (existing App.jsx mechanism, unchanged).
  const pairMatches = [];
  for (const m of knockoutShells){
    if (m.status === "bye") continue;
    if (m.pairAId && m.pairBId) pairMatches.push(buildChildMatch(genId, m));
  }

  return { teamMatchups: [...knockoutShells, final, bronze], pairMatches, conflicts };
}

// True once any knockout-stage (non-round_robin) matchup has a decided
// outcome (BYE or completed) or any of its child matches has started —
// regeneration must be blocked from here on, never silently discarding
// results.
export function hasKnockoutStageStarted(teamMatchups, matches){
  const knockoutMatchups = (teamMatchups || []).filter(m => m.stage && m.stage !== "round_robin");
  if (knockoutMatchups.some(m => m.status !== "pending")) return true;
  const ids = new Set(knockoutMatchups.map(m => m.id));
  return (matches || []).some(m => ids.has(m.teamMatchupId) && (m.status === "in_progress" || m.status === "completed"));
}
