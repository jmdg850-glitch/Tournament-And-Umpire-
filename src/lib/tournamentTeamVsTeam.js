// Team-vs-Team Cross Rotation — pure, no DB. The bracket competitor is the
// TEAM, not the pair, but a Team-vs-Team matchup is no longer a knockout
// eliminator decided by "Pair i vs Pair i" majority. It's a full ROUND-ROBIN
// SCHEDULE OF TEAMS (see tournamentTeamRoundRobin.js) whose matchups each
// play a balanced N x (N-1) cross-rotation of individual pair matches: every
// pair on Team A faces N-1 DIFFERENT pairs on Team B (never the same
// opponent twice), and the team with more individual-match wins wins the
// matchup — decided only once every individual match has been played, not by
// early majority.
//
// Individual pair matches remain plain (existing tournament_matches rows,
// unmodified infrastructure — scoring/umpire/history/realtime all keep
// working exactly as today), linked to their parent matchup via
// team_matchup_id/pair_slot (migration 136).

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

// Each team's rank = the minimum seed among its pairs. Reuses the existing
// seedByTeamRanking feature (which already clusters a team's pairs into
// consecutive best-team-first seed numbers) as the team-rank input rather
// than inventing a second, separate "team seed" concept — works under any
// seeding method, not just Team Ranking. Ties broken by teamId for determinism.
export function rankTeams(teams){
  return [...teams].sort((a,b) => {
    const minA = Math.min(...a.pairs.map(p => p.seed ?? Infinity));
    const minB = Math.min(...b.pairs.map(p => p.seed ?? Infinity));
    return minA !== minB ? minA - minB : String(a.teamId).localeCompare(String(b.teamId));
  });
}

// registrations: active (non-withdrawn) pairs {id, seed, teamId}. teamGroups:
// [{id, name}] (tournament_teams rows). Four distinct failure modes, each with
// an actionable message the UI can render directly — richer than a bare null.
// team_too_small: the N x (N-1) cross-rotation formula produces ZERO matches
// at N=1, so a team of exactly 1 pair can never be scheduled under this format.
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

// The balanced N x (N-1) cross rotation: for rotation r (0-based, 0..N-2),
// pair i on Team A faces pair (i+r)%N on Team B — every A pair meets N-1
// DISTINCT B pairs, never itself, never a repeat. Matches are generated in
// rotation order (rotation 0's N matches, then rotation 1's N matches, ...),
// numbered via pairSlot = r*N + i + 1 (1-based, matching "Match 1..N*(N-1)"),
// which is exactly how the UI derives "Rotation K" grouping later
// (floor((pairSlot-1)/N)+1) without needing a separate stored column.
//
// Shared by generateTeamRoundRobinMatchups (round-robin stage — both teams
// always known at generation time) and generateTeamPlayoffShell (semifinals —
// also both teams known immediately from standings). Final/Bronze shells are
// generated TBD-vs-TBD and call this again once advanceTeamMatchup/
// advanceBronzeTeamMatchup fill in their real team ids (see App.jsx).
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
        status: "pending", winner: null,
        teamMatchupId: matchup.id, pairSlot: r*n + i + 1,
      });
    }
  }
  return rows;
}

// Mirrors advanceBracket exactly, at team granularity. No "scheduled" branch
// (unlike advanceBracket) — a team matchup has no Start button of its own,
// only its child pair matches do, so there's nothing for a second status
// value to gate.
export function advanceTeamMatchup(matchups, completedMatchupId, winnerTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.nextMatchupId) return null;
  const next = matchups.find(m => m.id === completed.nextMatchupId);
  if (!next) return null;
  const slotKey = completed.nextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: next.id, patch: { [slotKey]: winnerTeamId, status: "pending" } };
}

// Mirrors advanceBronzeMatchSlot exactly, at team granularity — routes the
// LOSING team of a bronze-wired semifinal matchup into the bronze matchup.
export function advanceBronzeTeamMatchup(matchups, completedMatchupId, loserTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.loserNextMatchupId) return null;
  const bronze = matchups.find(m => m.id === completed.loserNextMatchupId);
  if (!bronze) return null;
  const slotKey = completed.loserNextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: bronze.id, patch: { [slotKey]: loserTeamId, status: "pending" } };
}

// Individual-stage counterparts of advanceTeamMatchup/advanceBronzeTeamMatchup
// (Knockout/Semifinal/Bronze/Final, pairsPerMatchup always 1 — see
// generateQualifierBracketShell in tournamentTeamPlayoffs.js). Pure pointer-followers
// that work at any round depth, unmodified by same-team-avoidance policy — that's a
// bracket-PLACEMENT concern decided once at generation time, never here. The winner/
// loser of a single pair-vs-pair match is already known directly (no
// team-level win-tally to derive it from, unlike the round-robin stage) —
// callers pass both the winning/losing PAIR's registrationId (the new
// authoritative pairAId/pairBId slot) and its TEAM id (teamAId/teamBId,
// informational display only from this stage on) so both land in one patch.
export function advanceIndividualMatchup(matchups, completedMatchupId, winnerRegistrationId, winnerTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.nextMatchupId) return null;
  const next = matchups.find(m => m.id === completed.nextMatchupId);
  if (!next) return null;
  const pairSlotKey = completed.nextMatchupSlot === "A" ? "pairAId" : "pairBId";
  const teamSlotKey = completed.nextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: next.id, patch: { [pairSlotKey]: winnerRegistrationId, [teamSlotKey]: winnerTeamId, status: "pending" } };
}

export function advanceBronzeIndividualMatchup(matchups, completedMatchupId, loserRegistrationId, loserTeamId){
  const completed = matchups.find(m => m.id === completedMatchupId);
  if (!completed?.loserNextMatchupId) return null;
  const bronze = matchups.find(m => m.id === completed.loserNextMatchupId);
  if (!bronze) return null;
  const pairSlotKey = completed.loserNextMatchupSlot === "A" ? "pairAId" : "pairBId";
  const teamSlotKey = completed.loserNextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: bronze.id, patch: { [pairSlotKey]: loserRegistrationId, [teamSlotKey]: loserTeamId, status: "pending" } };
}

// Deterministic last-resort tiebreak (mirrors tournamentTeamGroups.js's own
// stableTiebreak — duplicated here as a small pure helper rather than reaching
// into that module, since this one applies at the individual-matchup level
// and that one at the standings level).
function stableTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const parity = hash([idA,idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

// The matchup-decision logic — pure, fully isolated from any DB/orchestration
// concern. Every individual pair match in a Team-vs-Team matchup is meant to
// be PLAYED OUT (no early majority short-circuit, no cancelling siblings) —
// this only decides a winner once every one of the matchup's own pair matches
// (found in `allPairMatches`, the division's full match list) is "completed".
// Returns null while any are still pending/in_progress/scheduled (matchup
// stays in progress; caller should still tally live win counts per-match as
// they complete, independent of this function).
//
// Tie-break (N x (N-1) is always even, so an exact win-count tie is possible):
// aggregate point differential across every pair match in the matchup
// (registrationAId always belongs to Team A per buildPairMatchesForMatchup's
// own convention, so score.scoreA/scoreB orientation is stable), then a
// deterministic stableTiebreak fallback for the vanishingly rare exact tie.
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
