// Team Elimination qualification + same-team-aware knockout bracket — pure, no DB.

import { seedOrder } from "./bracket.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

function nextPow2(n){ let s = 1; while (s < n) s *= 2; return s; }

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
    if (teamI == null) continue;
    let best = null, bestCost = Infinity;
    for (let j = 0; j < size; j++){
      const podStartJ = Math.floor(j / podSize) * podSize;
      if (podStartJ === podStartI) continue;
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

export function placeQualifiersWithPolicy(qualifiers, policy){
  const size = nextPow2(qualifiers.length);
  const podSize = podSizeForPolicy(policy, size);
  let seedSlots = seedOrder(size);
  if (podSize > 1) seedSlots = repairPods(seedSlots, qualifiers, podSize);
  const conflicts = detectConflicts(seedSlots, qualifiers, podSize);
  const order = seedSlots.map(s => s <= qualifiers.length ? qualifiers[s - 1] : null);
  return { order, conflicts, size };
}

export function selectQualifiers(rankedPairs, mode, count){
  if (mode === "top_x") return rankedPairs.slice(0, Math.max(0, Number(count) || 4));
  if (mode === "top_x_per_team"){
    const perTeamCount = new Map();
    const keepIds = new Set();
    for (const p of rankedPairs){
      const c = perTeamCount.get(p.teamId) || 0;
      if (c < count){ keepIds.add(p.registrationId); perTeamCount.set(p.teamId, c + 1); }
    }
    return rankedPairs.filter(p => keepIds.has(p.registrationId));
  }
  return [];
}

function knockoutStageLabel(fromFinal){
  if (fromFinal === 1) return "Semifinal";
  if (fromFinal === 2) return "Quarterfinal";
  return "Round of " + Math.pow(2, fromFinal + 1);
}

function buildFinalShell(id, round){
  return { id, round, bracketPosition: 0, teamAId: null, teamBId: null, pairAId: null, pairBId: null,
    teamAWins: 0, teamBWins: 0, pairsPerMatchup: 1, winnerTeamId: null, status: "scheduled",
    stage: "final", stageLabel: "Final" };
}
function buildBronzeShell(id, round){
  return { id, round, bracketPosition: 1, teamAId: null, teamBId: null, pairAId: null, pairBId: null,
    teamAWins: 0, teamBWins: 0, pairsPerMatchup: 1, winnerTeamId: null, status: "scheduled",
    bracketSide: "bronze", stage: "bronze", stageLabel: "Bronze Match" };
}
function buildChildMatch(genId, matchup){
  return { id: genId(), round: matchup.round, bracketPosition: matchup.bracketPosition,
    registrationAId: matchup.pairAId, registrationBId: matchup.pairBId,
    status: "scheduled", winner: null, teamMatchupId: matchup.id, pairSlot: 1 };
}

export function generateQualifierBracketShell(qualifiers, { makeId, startRound = 1, sameTeamPolicy = "allow_anywhere" } = {}){
  const genId = makeId || defaultId;
  const M = qualifiers.length;
  if (M < 2) return { teamMatchups: [], pairMatches: [], conflicts: [] };

  if (M === 2){
    const final = { ...buildFinalShell(genId(), startRound),
      teamAId: qualifiers[0].teamId, teamBId: qualifiers[1].teamId,
      pairAId: qualifiers[0].registrationId, pairBId: qualifiers[1].registrationId };
    return { teamMatchups: [final], pairMatches: [buildChildMatch(genId, final)], conflicts: [] };
  }

  const { order, conflicts, size } = placeQualifiersWithPolicy(qualifiers, sameTeamPolicy);
  const knockoutRounds = Math.log2(size) - 1;

  const rounds = [];
  let roundSize = size / 2;
  for (let r = 0; r < knockoutRounds; r++){
    const fromFinal = knockoutRounds - r;
    const shells = [];
    for (let i = 0; i < roundSize; i++){
      shells.push({
        id: genId(), round: startRound + r, bracketPosition: i,
        teamAId: null, teamBId: null, pairAId: null, pairBId: null,
        teamAWins: 0, teamBWins: 0, pairsPerMatchup: 1, winnerTeamId: null, status: "scheduled",
        stage: fromFinal === 1 ? "semifinal" : "knockout",
        stageLabel: knockoutStageLabel(fromFinal),
      });
    }
    rounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize / 2));
  }

  for (let i = 0; i < rounds[0].length; i++){
    const a = order[i * 2], b = order[i * 2 + 1];
    const m = rounds[0][i];
    m.teamAId = a?.teamId ?? null; m.pairAId = a?.registrationId ?? null;
    m.teamBId = b?.teamId ?? null; m.pairBId = b?.registrationId ?? null;
    if (!a || !b){ m.status = "bye"; m.winnerTeamId = a ? a.teamId : b.teamId; }
  }

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

  const semis = rounds[knockoutRounds - 1];
  const final = buildFinalShell(genId(), startRound + knockoutRounds);
  const bronze = buildBronzeShell(genId(), startRound + knockoutRounds);
  semis[0].nextMatchupId = final.id; semis[0].nextMatchupSlot = "A";
  semis[0].loserNextMatchupId = bronze.id; semis[0].loserNextMatchupSlot = "A";
  semis[1].nextMatchupId = final.id; semis[1].nextMatchupSlot = "B";
  semis[1].loserNextMatchupId = bronze.id; semis[1].loserNextMatchupSlot = "B";

  const knockoutShells = rounds.flat();

  const pairMatches = [];
  for (const m of knockoutShells){
    if (m.status === "bye") continue;
    if (m.pairAId && m.pairBId) pairMatches.push(buildChildMatch(genId, m));
  }

  return { teamMatchups: [...knockoutShells, final, bronze], pairMatches, conflicts };
}

export function hasKnockoutStageStarted(teamMatchups, matches){
  const knockoutMatchups = (teamMatchups || []).filter(m => m.stage && m.stage !== "round_robin");
  if (knockoutMatchups.some(m => m.status !== "scheduled")) return true;
  const ids = new Set(knockoutMatchups.map(m => m.id));
  return (matches || []).some(m => ids.has(m.teamMatchupId) && (m.status === "in_progress" || m.status === "completed"));
}
