// Team Elimination's division-wide flow: every Team plays every other Team
// once (a flat round robin, reusing generateRoundRobinSchedule's circle
// method verbatim — teams stand in for pairs), each matchup is a balanced
// N x (N-1) cross-rotation of individual pair matches (tournamentTeamVsTeam.js).
// TEAMS ARE A GROUPING/SCHEDULING DEVICE ONLY — they do not by themselves decide
// qualification. Once the round robin completes, every INDIVIDUAL PAIR from every
// team is ranked by its own accumulated record (rankIndividualPairsForSemifinals);
// which of those ranked pairs actually qualify (Top 4 Overall / Top X Per Team /
// Manual) and how the resulting knockout bracket is constructed (Quarterfinal/
// Round of 16/.../Semifinal -> Battle for Bronze + Final, with an optional
// same-team-avoidance placement policy) lives in tournamentTeamPlayoffs.js, not
// here. Team Standings (buildTeamStandingsFromRoundRobin) are still computed and
// shown separately, as Team-vs-Team stage information — they are not what decides
// qualification.
//
// Bracket Groups (optional "pools" split, tournamentTeamGroups.js) are
// deliberately NOT used here — this format is always one flat pool across
// every team in the division. That module is left in place, unused for
// team_elimination going forward.

import { rankTeams, buildPairMatchesForMatchup } from "./tournamentTeamVsTeam.js";
import { generateRoundRobinSchedule } from "./tournamentRoundRobin.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

// Deterministic last-resort tiebreak — same shape as tournamentTeamGroups.js's
// own stableTiebreak, duplicated locally (small, pure, not worth importing a
// module this one doesn't otherwise depend on).
function stableTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const parity = hash([idA,idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

// teams: output of groupRegistrationsByTeam(...).teams (already validated:
// >=2 teams, equal pair counts, every team >=2 pairs). Every team-vs-team
// pairing gets its real teamAId/teamBId immediately (round robin needs no
// TBD-slot waiting, unlike a knockout bracket's round 2+) — so its pair
// matches are generated right away too. Returns { teamMatchups, pairMatches },
// ready for one bulk insert.
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
        teamAWins: 0, teamBWins: 0, pairsPerMatchup, winnerTeamId: null, status: "pending",
        stage: "round_robin", stageLabel: "Round " + rnd.round,
      };
      teamMatchups.push(shell);
      pairMatches.push(...buildPairMatchesForMatchup(shell, teams, genId));
    }
  }
  return { teamMatchups, pairMatches };
}

// Team-level standings from completed round-robin-stage matchups — direct
// adaptation of tournamentTeamGroups.js's buildTeamStandings, one filter
// swapped: `stage==="round_robin"` (every matchup in the division's main
// pool) instead of that module's mergeGroupA/B tag (a handful of
// group-champion merge rows). Same tiebreak order: Wins -> Head-to-Head ->
// aggregate pair-match win margin -> deterministic last resort.
export function buildTeamStandingsFromRoundRobin(teams, teamMatchups){
  const rows = new Map(teams.map(t => [t.teamId, { teamId:t.teamId, teamName:t.teamName, wins:0, losses:0, matchesPlayed:0, pairMatchWins:0, pairMatchLosses:0, pairWinMargin:0 }]));
  const completed = (teamMatchups||[]).filter(m => m.stage === "round_robin" && m.status === "completed" && m.teamAId && m.teamBId);

  for (const m of completed){
    const a = rows.get(m.teamAId), b = rows.get(m.teamBId);
    if (!a || !b) continue;
    a.matchesPlayed++; b.matchesPlayed++;
    a.pairMatchWins += m.teamAWins; a.pairMatchLosses += m.teamBWins;
    b.pairMatchWins += m.teamBWins; b.pairMatchLosses += m.teamAWins;
    a.pairWinMargin += (m.teamAWins - m.teamBWins); b.pairWinMargin += (m.teamBWins - m.teamAWins);
    if (m.winnerTeamId === m.teamAId){ a.wins++; b.losses++; }
    else if (m.winnerTeamId === m.teamBId){ b.wins++; a.losses++; }
  }

  const headToHeadWinner = (idA, idB) => {
    const m = completed.find(x => (x.teamAId===idA && x.teamBId===idB) || (x.teamAId===idB && x.teamBId===idA));
    if (!m || !m.winnerTeamId) return 0;
    return m.winnerTeamId === idA ? -1 : 1;
  };

  const sorted = [...rows.values()].sort((x,y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    const h2h = headToHeadWinner(x.teamId, y.teamId);
    if (h2h) return h2h;
    if (y.pairWinMargin !== x.pairWinMargin) return y.pairWinMargin - x.pairWinMargin;
    return stableTiebreak(x.teamId, y.teamId);
  });

  return sorted.map((r,i) => ({ ...r, rank:i+1 }));
}

// True once every round-robin-stage matchup in the division has been played
// to completion — the signal to compute standings and generate the Top-4
// Semifinal/Bronze/Final shell. False (not just "no matchups yet") when there
// are no round-robin rows at all.
export function isTeamRoundRobinComplete(teamMatchups){
  const rows = (teamMatchups||[]).filter(m => m.stage === "round_robin");
  return rows.length > 0 && rows.every(m => m.status === "completed");
}

// The actual semifinal qualifiers are INDIVIDUAL PAIRS, not Teams — Teams are
// only a grouping/scheduling device for the round-robin stage. Ranks every
// pair from EVERY team (no team quota — all 4 could come from one team) by
// its own accumulated round-robin record. `teams`: groupRegistrationsByTeam's
// output (for teamId/teamName lookup per pair). `teamMatchups`: full division
// list, used only to find which matchup ids belong to the round-robin stage.
// `pairMatches`: full division tournament_matches list — filtering by
// "belongs to a round_robin-stage matchup id" (rather than a stage column on
// tournament_matches itself, which doesn't exist) is what keeps this safe to
// call even after Semifinal/Bronze/Final pair matches start being created and
// completing; those carry a different teamMatchupId and are automatically
// excluded. Not gated on isTeamRoundRobinComplete here — callers decide (a
// live "Individual Qualification Standings" preview may want partial stats
// mid-stage; the real qualification decision gates separately).
//
// Tiebreak — deliberately NOT the same chain as buildTournamentStandings
// (plain Round Robin's own pair ranking): Wins -> Losses -> Point
// Differential -> Points For -> deterministic last resort. No Win% step (in
// this format every pair plays the same total match count by construction,
// so it would never separate a Wins tie anyway) and no Head-to-Head step —
// this format's spec explicitly calls for Points For as the 4th tier instead.
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

  return sorted.map((r,i) => ({ ...r, rank: i+1 }));
}

// generateIndividualPlayoffShell (fixed at exactly 4 qualifiers, no team quota, no
// same-team avoidance) has been superseded by generateQualifierBracketShell in
// tournamentTeamPlayoffs.js, which generalizes this to any qualifier count (Top 4
// Overall / Top X Per Team / Manual) and an optional same-team avoidance policy.
