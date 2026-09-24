// Team Elimination round-robin stage — teams as grouping/scheduling only. Pure, no DB.

import { rankTeams, buildPairMatchesForMatchup } from "./teamVsTeam.js";
import { generateRoundRobinSchedule } from "./roundRobin.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

function stableTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const parity = hash([idA,idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

export function generateTeamRoundRobinMatchups(teams, { makeId } = {}){
  const genId = makeId || defaultId;
  const pairsPerMatchup = teams[0].pairs.length;
  const ranked = rankTeams(teams);
  const { rounds } = generateRoundRobinSchedule(ranked.map(t => ({ id: t.teamId })));

  const teamMatchups = [];
  const pairMatches = [];
  for (const rnd of rounds){
    let pos = 0;
    for (const match of rnd.matches){
      if (match.isBye) continue;
      const shell = {
        id: genId(), round: rnd.round, bracketPosition: pos++,
        teamAId: match.registrationAId, teamBId: match.registrationBId,
        teamAWins: 0, teamBWins: 0, pairsPerMatchup, winnerTeamId: null, status: "scheduled",
        stage: "round_robin", stageLabel: "Round " + rnd.round,
      };
      teamMatchups.push(shell);
      pairMatches.push(...buildPairMatchesForMatchup(shell, teams, genId));
    }
  }
  assertNoRepeatPairOpponents(pairMatches);
  return { teamMatchups, pairMatches };
}

export function assertNoRepeatPairOpponents(pairMatches) {
  const seen = new Set();
  for (const m of pairMatches || []) {
    if (!m.registrationAId || !m.registrationBId) continue;
    const key = [m.registrationAId, m.registrationBId].sort().join("|");
    if (seen.has(key)) {
      const err = new Error("Duplicate pair-vs-pair opponent in elimination schedule");
      err.code = "REPEAT_OPPONENT";
      throw err;
    }
    seen.add(key);
  }
}

// Team standings for the round-robin qualification stage only. Every
// completed round-robin PAIR match counts toward its two teams as it finishes
// (W/L/MP/PF/PA), so the table accumulates live — it does not wait for a whole
// team-vs-team matchup to complete. Semifinal/bronze/final matchups (and their
// pair matches) are out of scope. Team-matchup-level results are still kept
// as teamMatchupWins/teamMatchupLosses and feed the head-to-head tiebreak.
// Rank: W desc -> +/- desc -> head-to-head -> shared rank (never a hidden
// arbitrary tiebreak; fully tied teams get the same rank number).
export function buildTeamStandingsFromRoundRobin(teams, teamMatchups, pairMatches){
  const rows = new Map(teams.map(t => [t.teamId, { teamId:t.teamId, teamName:t.teamName, wins:0, losses:0, matchesPlayed:0, pairMatchWins:0, pairMatchLosses:0, pairWinMargin:0, teamMatchupWins:0, teamMatchupLosses:0, pointsFor:0, pointsAgainst:0, pointDiff:0 }]));
  const roundRobinMatchups = (teamMatchups||[]).filter(m => m.stage === "round_robin");
  const completed = roundRobinMatchups.filter(m => m.status === "completed" && m.teamAId && m.teamBId);

  for (const m of completed){
    const a = rows.get(m.teamAId), b = rows.get(m.teamBId);
    if (!a || !b) continue;
    if (m.winnerTeamId === m.teamAId){ a.teamMatchupWins++; b.teamMatchupLosses++; }
    else if (m.winnerTeamId === m.teamBId){ b.teamMatchupWins++; a.teamMatchupLosses++; }
  }

  const registrationToTeam = new Map();
  for (const team of teams) for (const pair of team.pairs) registrationToTeam.set(pair.id, team.teamId);
  const roundRobinMatchupIds = new Set(roundRobinMatchups.map(m => m.id));
  const counted = new Set();
  for (const pm of pairMatches || []){
    if (pm.status !== "completed" || !roundRobinMatchupIds.has(pm.teamMatchupId)) continue;
    if (pm.id != null){ if (counted.has(pm.id)) continue; counted.add(pm.id); }
    const a = rows.get(registrationToTeam.get(pm.registrationAId));
    const b = rows.get(registrationToTeam.get(pm.registrationBId));
    if (!a || !b || a === b) continue;
    const ptsA = pm.score?.scoreA ?? 0, ptsB = pm.score?.scoreB ?? 0;
    a.matchesPlayed++; b.matchesPlayed++;
    a.pointsFor += ptsA; a.pointsAgainst += ptsB;
    b.pointsFor += ptsB; b.pointsAgainst += ptsA;
    if (pm.winner === "A"){ a.wins++; b.losses++; }
    else if (pm.winner === "B"){ b.wins++; a.losses++; }
  }
  for (const r of rows.values()){
    r.pointDiff = r.pointsFor - r.pointsAgainst;
    r.pairMatchWins = r.wins; r.pairMatchLosses = r.losses;
    r.pairWinMargin = r.wins - r.losses;
  }

  const headToHeadWinner = (idA, idB) => {
    const m = completed.find(x => (x.teamAId===idA && x.teamBId===idB) || (x.teamAId===idB && x.teamBId===idA));
    if (!m || !m.winnerTeamId) return 0;
    return m.winnerTeamId === idA ? -1 : 1;
  };
  const officialCompare = (x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
    return headToHeadWinner(x.teamId, y.teamId);
  };

  // Display order for fully tied rows is deterministic, but they share a rank.
  const sorted = [...rows.values()].sort((x,y) => officialCompare(x, y) || stableTiebreak(x.teamId, y.teamId));
  let rank = 0;
  return sorted.map((r,i) => {
    if (i === 0 || officialCompare(sorted[i-1], r) !== 0) rank = i + 1;
    return { ...r, rank };
  });
}

export function isTeamRoundRobinComplete(teamMatchups){
  const rows = (teamMatchups||[]).filter(m => m.stage === "round_robin");
  return rows.length > 0 && rows.every(m => m.status === "completed");
}

function stablePairTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const parity = hash([idA,idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

export function rankIndividualPairsForSemifinals(teams, teamMatchups, pairMatches){
  const roundRobinMatchupIds = new Set((teamMatchups||[]).filter(m => m.stage === "round_robin").map(m => m.id));
  const completed = (pairMatches||[]).filter(m => m.status === "completed" && roundRobinMatchupIds.has(m.teamMatchupId));

  const rows = new Map();
  for (const team of teams){
    for (const pair of team.pairs){
      rows.set(pair.id, {
        registrationId: pair.id, teamId: team.teamId, teamName: team.teamName,
        wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0, matchesPlayed: 0,
      });
    }
  }

  for (const m of completed){
    const a = rows.get(m.registrationAId), b = rows.get(m.registrationBId);
    if (!a || !b) continue;
    const ptsA = m.score?.scoreA ?? 0, ptsB = m.score?.scoreB ?? 0;
    a.matchesPlayed++; b.matchesPlayed++;
    a.pointsFor += ptsA; a.pointsAgainst += ptsB;
    b.pointsFor += ptsB; b.pointsAgainst += ptsA;
    if (m.winner === "A"){ a.wins++; b.losses++; } else if (m.winner === "B"){ b.wins++; a.losses++; }
  }
  for (const r of rows.values()) r.pointDiff = r.pointsFor - r.pointsAgainst;

  const sorted = [...rows.values()].sort((x,y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (x.losses !== y.losses) return x.losses - y.losses;
    if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
    if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
    return stablePairTiebreak(x.registrationId, y.registrationId);
  });

  // Rows equal on every official criterion were only separated by the stable
  // fallback above — flag them so the tie is visible instead of silent.
  return sorted.map((r,i) => ({
    ...r,
    rank: i+1,
    tieUnresolved: [sorted[i-1], sorted[i+1]].some(o => o && pairsOfficiallyTied(o, r)),
  }));
}

export function pairsOfficiallyTied(x, y){
  return x.wins === y.wins && x.losses === y.losses && x.pointDiff === y.pointDiff && x.pointsFor === y.pointsFor;
}
