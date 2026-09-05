// Team-vs-Team Cross Rotation — pure, no DB.

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

export function rankTeams(teams){
  return [...teams].sort((a,b) => {
    const minA = Math.min(...a.pairs.map(p => p.seed ?? Infinity));
    const minB = Math.min(...b.pairs.map(p => p.seed ?? Infinity));
    return minA !== minB ? minA - minB : String(a.teamId).localeCompare(String(b.teamId));
  });
}

export function groupRegistrationsByTeam(registrations, teamGroups){
  const byTeam = new Map((teamGroups||[]).map(t => [t.id, { teamId: t.id, teamName: t.name, bracketGroup: t.bracketGroup || null, pairs: [] }]));
  const unassigned = [];
  for (const r of (registrations||[])){
    if (r.teamId && byTeam.has(r.teamId)) byTeam.get(r.teamId).pairs.push(r);
    else unassigned.push(r);
  }
  for (const team of byTeam.values()) team.pairs.sort((a,c) => (a.seed ?? Infinity) - (c.seed ?? Infinity));
  const teams = [...byTeam.values()].filter(t => t.pairs.length > 0);
  const summary = teams.map(t => ({ teamId: t.teamId, teamName: t.teamName, count: t.pairs.length }));

  if (unassigned.length > 0) return { ok:false, error:"unassigned_pairs", teams:summary, unassignedCount:unassigned.length };
  if (teams.length < 2) return { ok:false, error:"too_few_teams", teams:summary };
  if (new Set(teams.map(t => t.pairs.length)).size > 1) return { ok:false, error:"uneven_team_sizes", teams:summary };
  if (teams.some(t => t.pairs.length < 2)) return { ok:false, error:"team_too_small", teams:summary };
  return { ok:true, teams };
}

export function buildPairMatchesForMatchup(matchup, teams, makeId){
  const genId = makeId || defaultId;
  const teamA = teams.find(t => t.teamId === matchup.teamAId);
  const teamB = teams.find(t => t.teamId === matchup.teamBId);
  if (!teamA || !teamB) return [];
  const n = teamA.pairs.length;
  const rows = [];
  for (let r=0; r<n-1; r++){
    for (let i=0; i<n; i++){
      const j = (i + r) % n;
      rows.push({
        id: genId(), round: matchup.round, bracketPosition: matchup.bracketPosition,
        registrationAId: teamA.pairs[i].id, registrationBId: teamB.pairs[j].id,
        status: "scheduled", winner: null,
        teamMatchupId: matchup.id, pairSlot: r*n + i + 1,
      });
    }
  }
  return rows;
}

export function advanceTeamMatchup(matchups, completedMatchupId, winnerTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.nextMatchupId) return null;
  const next = matchups.find(m => m.id === completed.nextMatchupId);
  if (!next) return null;
  const slotKey = completed.nextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: next.id, patch: { [slotKey]: winnerTeamId, status: "scheduled" } };
}

export function advanceBronzeTeamMatchup(matchups, completedMatchupId, loserTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.loserNextMatchupId) return null;
  const bronze = matchups.find(m => m.id === completed.loserNextMatchupId);
  if (!bronze) return null;
  const slotKey = completed.loserNextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: bronze.id, patch: { [slotKey]: loserTeamId, status: "scheduled" } };
}

export function advanceIndividualMatchup(matchups, completedMatchupId, winnerRegistrationId, winnerTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.nextMatchupId) return null;
  const next = matchups.find(m => m.id === completed.nextMatchupId);
  if (!next) return null;
  const pairSlotKey = completed.nextMatchupSlot === "A" ? "pairAId" : "pairBId";
  const teamSlotKey = completed.nextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: next.id, patch: { [pairSlotKey]: winnerRegistrationId, [teamSlotKey]: winnerTeamId, status: "scheduled" } };
}

export function advanceBronzeIndividualMatchup(matchups, completedMatchupId, loserRegistrationId, loserTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.loserNextMatchupId) return null;
  const bronze = matchups.find(m => m.id === completed.loserNextMatchupId);
  if (!bronze) return null;
  const pairSlotKey = completed.loserNextMatchupSlot === "A" ? "pairAId" : "pairBId";
  const teamSlotKey = completed.loserNextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: bronze.id, patch: { [pairSlotKey]: loserRegistrationId, [teamSlotKey]: loserTeamId, status: "scheduled" } };
}

function stableTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const parity = hash([idA,idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

export function finalizeCrossTeamMatchup(matchup, allPairMatches){
  const own = (allPairMatches||[]).filter(m => m.teamMatchupId === matchup.id);
  if (own.length === 0 || !own.every(m => m.status === "completed")) return null;

  let teamAWins=0, teamBWins=0, diffA=0;
  for (const m of own){
    if (m.winner === "A") teamAWins++; else if (m.winner === "B") teamBWins++;
    const sA = m.score?.scoreA ?? 0, sB = m.score?.scoreB ?? 0;
    diffA += (sA - sB);
  }

  let winnerTeamId;
  if (teamAWins !== teamBWins) winnerTeamId = teamAWins > teamBWins ? matchup.teamAId : matchup.teamBId;
  else if (diffA !== 0) winnerTeamId = diffA > 0 ? matchup.teamAId : matchup.teamBId;
  else winnerTeamId = stableTiebreak(matchup.teamAId, matchup.teamBId) < 0 ? matchup.teamAId : matchup.teamBId;

  return { teamAWins, teamBWins, winnerTeamId };
}
