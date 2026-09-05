// Bracket Groups for Team Elimination — optional NBA-style splitting on top of
// tournamentTeamVsTeam.js's flat bracket. A Team (tournament_teams row) may
// carry a free-text `bracketGroup` label (e.g. "Bracket A"); teams sharing a
// label play their own tier-1 single-elimination bracket (reusing
// generateTeamVsTeamBracket UNMODIFIED, one call per group) until a group
// champion emerges. Group champions then meet in a merge stage:
//   - 2 groups: a single pre-wired Final shell (+ Bronze from the two group
//     deciders' losers), patched in via the existing nextMatchupId/
//     nextMatchupSlot advancement convention — no new advancement mechanism.
//   - 3+ groups: a round robin among the champions (reusing
//     generateRoundRobinSchedule from tournamentRoundRobin.js verbatim), so a
//     full ranking always exists — Final = standings #1 vs #2, Bronze (only
//     when there's a real #4) = standings #3 vs #4, generated dynamically
//     once every round-robin merge matchup completes (mirrors
//     tournamentPoolPlay.js's generateKnockoutFromPools, which likewise only
//     builds its knockout stage once pool play concludes and advancers are
//     known).
//
// 0 or 1 distinct bracketGroup label in use = "not grouped" — the caller
// should fall back to plain generateTeamVsTeamBracket, unchanged. This module
// never touches that function's own behavior or tests.
//
// UNUSED by the app since the Team Elimination redesign (see
// tournamentTeamRoundRobin.js): that format is now always one flat round
// robin across every team, never split into Bracket Groups. This module is
// kept in place, not deleted, per explicit instruction not to blindly remove
// existing features — but it's fully orphaned from the live app going
// forward. Its own generateTeamVsTeamBracket/buildPairMatchesForMatchup
// ("Pair i vs Pair i", majority-decided) are therefore defined LOCALLY below
// rather than imported from tournamentTeamVsTeam.js, which has since been
// rewritten for the new N x (N-1) cross-rotation format — importing the new
// versions here would silently change this orphaned module's own behavior
// (and break its still-passing test suite) for no reason.

import { generateRoundRobinSchedule } from "./tournamentRoundRobin.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

// Local, frozen copy of the pre-redesign seedOrder (tournamentBracket.js's
// own export is still the live one used by every other format — duplicated
// here, not imported, so this orphaned module has zero live-code dependents
// pulling it back in).
function legacySeedOrder(size){
  let order = [1];
  while (order.length < size){
    const k = order.length;
    order = order.flatMap(s => [s, 2*k + 1 - s]);
  }
  return order;
}

// Local, frozen copy of the pre-redesign "Pair i vs Pair i" pair-match builder.
function legacyBuildPairMatchesForMatchup(matchup, teams, makeId){
  const genId = makeId || defaultId;
  const teamA = teams.find(t => t.teamId === matchup.teamAId);
  const teamB = teams.find(t => t.teamId === matchup.teamBId);
  if (!teamA || !teamB) return [];
  return teamA.pairs.map((pairA,i) => ({
    id: genId(), round: matchup.round, bracketPosition: matchup.bracketPosition,
    registrationAId: pairA.id, registrationBId: teamB.pairs[i].id,
    status: "pending", winner: null,
    teamMatchupId: matchup.id, pairSlot: i + 1,
  }));
}

// Local, frozen copy of the pre-redesign knockout-shell generator (rank +
// bye + nextMatchupId/loserNextMatchupId wiring), used only for a Bracket
// Group's own tier-1 mini-bracket.
export function legacyGenerateTeamVsTeamBracket(teams, { makeId, bronzeMatch } = {}){
  const genId = makeId || defaultId;
  const n = teams.length;
  if (n < 2) return { teamMatchups: [], pairMatches: [] };
  const pairsPerMatchup = teams[0].pairs.length;

  let size = 1; while (size < n) size *= 2;
  const totalRounds = Math.log2(size);
  const ranked = [...teams].sort((a,b) => {
    const minA = Math.min(...a.pairs.map(p => p.seed ?? Infinity));
    const minB = Math.min(...b.pairs.map(p => p.seed ?? Infinity));
    return minA !== minB ? minA - minB : String(a.teamId).localeCompare(String(b.teamId));
  });
  const order = legacySeedOrder(size);
  const teamForSeed = s => s <= n ? ranked[s-1] : null;
  const slots = order.map(teamForSeed);

  const rounds = [];
  let roundSize = size / 2;
  for (let r=0; r<totalRounds; r++){
    const shells = [];
    for (let i=0; i<roundSize; i++){
      shells.push({
        id: genId(), round: r+1, bracketPosition: i,
        teamAId: null, teamBId: null, teamAWins: 0, teamBWins: 0,
        pairsPerMatchup, winnerTeamId: null, status: "pending",
      });
    }
    rounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize/2));
  }

  for (let i=0; i<rounds[0].length; i++){
    const a = slots[i*2], b = slots[i*2+1];
    const m = rounds[0][i];
    m.teamAId = a?.teamId ?? null;
    m.teamBId = b?.teamId ?? null;
    if (!a || !b){ m.status = "bye"; m.winnerTeamId = a ? a.teamId : b.teamId; }
  }

  for (let r=0; r<rounds.length-1; r++){
    for (let i=0; i<rounds[r].length; i++){
      const m = rounds[r][i];
      const next = rounds[r+1][Math.floor(i/2)];
      m.nextMatchupId = next.id;
      m.nextMatchupSlot = i % 2 === 0 ? "A" : "B";
      if (m.status === "bye" && m.winnerTeamId){
        if (m.nextMatchupSlot === "A") next.teamAId = m.winnerTeamId;
        else next.teamBId = m.winnerTeamId;
      }
    }
  }

  const teamMatchups = rounds.flat();

  if (bronzeMatch && totalRounds >= 2){
    const semis = rounds[totalRounds - 2];
    const bronze = {
      id: genId(), round: totalRounds, bracketPosition: 1,
      teamAId: null, teamBId: null, teamAWins: 0, teamBWins: 0,
      pairsPerMatchup, winnerTeamId: null, status: "pending", bracketSide: "bronze",
    };
    semis[0].loserNextMatchupId = bronze.id; semis[0].loserNextMatchupSlot = "A";
    semis[1].loserNextMatchupId = bronze.id; semis[1].loserNextMatchupSlot = "B";
    teamMatchups.push(bronze);
  }

  const pairMatches = [];
  for (const m of rounds[0]){
    if (m.status === "bye" || !m.teamAId || !m.teamBId) continue;
    pairMatches.push(...legacyBuildPairMatchesForMatchup(m, teams, genId));
  }

  return { teamMatchups, pairMatches };
}

// Deterministic last-resort tiebreak (mirrors tournamentStandings.js's own
// stableRandomTiebreak — not exported there, so re-implemented here rather
// than reaching into that module's internals for one small pure helper).
function stableTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const parity = hash([idA,idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

// Splits already-team-grouped, equal-pair-count-validated teams (the `teams`
// array from tournamentTeamVsTeam.js's groupRegistrationsByTeam) by their
// .bracketGroup field. Three explicit failure modes, same spirit as
// groupRegistrationsByTeam's own error shapes.
export function partitionTeamsByBracketGroup(teams){
  const labels = new Set(teams.map(t => t.bracketGroup).filter(Boolean));
  const ungroupedCount = teams.filter(t => !t.bracketGroup).length;

  if (labels.size === 0) return { ok:true, grouped:false, teams };
  if (labels.size === 1 && ungroupedCount === 0) return { ok:true, grouped:false, teams }; // one label used by everyone = same as flat
  if (ungroupedCount > 0) return { ok:false, error:"partial_group_assignment", ungroupedCount };

  const groups = [...labels].sort().map(label => ({ label, teams: teams.filter(t => t.bracketGroup === label) }));
  const tooSmall = groups.find(g => g.teams.length < 2);
  if (tooSmall) return { ok:false, error:"group_too_small", groupLabel:tooSmall.label, count:tooSmall.teams.length };

  return { ok:true, grouped:true, groups };
}

// Group rank = the minimum pair-seed among ALL of its teams' pairs — mirrors
// rankTeams' "team rank = min seed among its pairs" one level up. Ties broken
// by label for determinism.
export function rankGroups(groups){
  return [...groups].sort((a,b) => {
    const minA = Math.min(...a.teams.flatMap(t => t.pairs.map(p => p.seed ?? Infinity)));
    const minB = Math.min(...b.teams.flatMap(t => t.pairs.map(p => p.seed ?? Infinity)));
    return minA !== minB ? minA - minB : String(a.label).localeCompare(String(b.label));
  });
}

// Per-self-contained-bracket-tree labeler (used for the flat/legacy path AND,
// independently, for each Bracket Group's own tier-1 rows). `isFlatFinal`
// means "this tree's own last round genuinely crowns the tournament champion"
// (true only for the flat/ungrouped path — a grouped tier-1 decider always
// feeds a separate merge stage, never the true Final itself). Round 1 is
// always "Elimination Round" UNLESS it's simultaneously the tree's only round
// AND that round really is the true Final (a 2-team flat bracket).
export function computeStageLabels(matchups, { isFlatFinal=false } = {}){
  const totalRounds = Math.max(0, ...matchups.filter(m => m.bracketSide !== "bronze").map(m => m.round));
  return matchups.map(m => {
    if (m.bracketSide === "bronze") return { ...m, stageLabel:"Bronze Match" };
    const fromEnd = totalRounds - m.round;
    const effDist = isFlatFinal ? fromEnd : fromEnd + 1; // +1: one more stage (the merge tier) still separates a group decider from the true Final
    if (m.round === 1 && effDist !== 0) return { ...m, stageLabel:"Elimination Round" };
    if (effDist === 0) return { ...m, stageLabel:"Final" };
    if (effDist === 1) return { ...m, stageLabel:"Semifinal" };
    if (effDist === 2) return { ...m, stageLabel:"Quarterfinal" };
    return { ...m, stageLabel:"Round "+m.round };
  });
}

// Tier 1 (per group, via the existing unmodified generateTeamVsTeamBracket) +
// tier 2 (merge stage, shape depends on group count — see module comment).
// `groups`: output of partitionTeamsByBracketGroup(...).groups (already
// validated: 2+ groups, each >=2 teams). Returns { teamMatchups, pairMatches }
// — same shape as generateTeamVsTeamBracket, ready for bulk insert.
export function generateGroupedTeamVsTeamBracket(groups, { makeId, bronzeMatch } = {}){
  const genId = makeId || defaultId;
  const teamMatchups = [];
  const pairMatches = [];
  const deciderByLabel = new Map();

  for (const group of groups){
    const generated = legacyGenerateTeamVsTeamBracket(group.teams, { makeId: genId });
    const totalRounds = Math.max(0, ...generated.teamMatchups.map(m => m.round));
    const labeled = computeStageLabels(generated.teamMatchups, { isFlatFinal:false })
      .map(m => ({ ...m, bracketGroup: group.label }));
    teamMatchups.push(...labeled);
    pairMatches.push(...generated.pairMatches);
    deciderByLabel.set(group.label, labeled.find(m => m.round === totalRounds));
  }

  const ranked = rankGroups(groups);
  const pairsPerMatchup = groups[0].teams[0].pairs.length;
  const maxDeciderRound = Math.max(...[...deciderByLabel.values()].map(m => m.round));

  if (groups.length === 2){
    const [g0, g1] = ranked;
    const d0 = deciderByLabel.get(g0.label), d1 = deciderByLabel.get(g1.label);
    const final = {
      id: genId(), round: maxDeciderRound+1, bracketPosition: 0,
      teamAId:null, teamBId:null, teamAWins:0, teamBWins:0, pairsPerMatchup,
      winnerTeamId:null, status:"pending", isFinal:true, stageLabel:"Final",
    };
    d0.nextMatchupId = final.id; d0.nextMatchupSlot = "A";
    d1.nextMatchupId = final.id; d1.nextMatchupSlot = "B";
    teamMatchups.push(final);

    if (bronzeMatch){
      const bronze = {
        id: genId(), round: maxDeciderRound+1, bracketPosition: 1,
        teamAId:null, teamBId:null, teamAWins:0, teamBWins:0, pairsPerMatchup,
        winnerTeamId:null, status:"pending", bracketSide:"bronze", stageLabel:"Bronze Match",
      };
      d0.loserNextMatchupId = bronze.id; d0.loserNextMatchupSlot = "A";
      d1.loserNextMatchupId = bronze.id; d1.loserNextMatchupSlot = "B";
      teamMatchups.push(bronze);
    }
  } else {
    // 3+ groups: round robin among ranked group champions. Real team ids are
    // unknown at generation time — filled in later via fillMergeGroupChampion
    // as each group's own decider completes. Final/Bronze are NOT
    // pre-generated here; they're built dynamically once every merge-stage
    // matchup below is completed (see generateMergeFinalAndBronze).
    const { rounds } = generateRoundRobinSchedule(ranked.map(g => ({ id: g.label })));
    for (const rnd of rounds){
      let pos = 0;
      for (const match of rnd.matches){
        if (match.isBye) continue;
        teamMatchups.push({
          id: genId(), round: rnd.round, bracketPosition: pos++,
          teamAId:null, teamBId:null, teamAWins:0, teamBWins:0, pairsPerMatchup,
          winnerTeamId:null, status:"pending",
          mergeGroupA: match.registrationAId, mergeGroupB: match.registrationBId,
          stageLabel:"Champions Round Robin",
        });
      }
    }
  }

  return { teamMatchups, pairMatches };
}

// Once a Bracket Group's own decider completes (winner known), every
// round-robin merge-stage matchup scheduled against that group's slot needs
// the real team id filled in — a group's champion plays G-1 merge matches, so
// this can patch more than one row. No-op (returns []) for the 2-group case,
// since those matchups are wired via the normal nextMatchupId mechanism
// instead (see advanceTeamMatchup in tournamentTeamVsTeam.js).
export function fillMergeGroupChampion(matchups, groupLabel, championTeamId){
  const patches = [];
  for (const m of matchups){
    if (m.mergeGroupA === groupLabel && m.teamAId !== championTeamId) patches.push({ matchupId:m.id, patch:{ teamAId:championTeamId } });
    if (m.mergeGroupB === groupLabel && m.teamBId !== championTeamId) patches.push({ matchupId:m.id, patch:{ teamBId:championTeamId } });
  }
  return patches;
}

// True once every round-robin merge-stage matchup (tagged via mergeGroupA/B)
// has been played to completion — the signal to compute standings and
// generate the Final/Bronze. False (not just "no matchups yet") when there
// are no merge-stage rows at all, so callers can't mistake a 2-group/flat
// bracket (which never has any mergeGroupA/B rows) for "complete."
export function isMergeRoundRobinComplete(matchups){
  const mergeRows = matchups.filter(m => m.mergeGroupA || m.mergeGroupB);
  return mergeRows.length > 0 && mergeRows.every(m => m.status === "completed");
}

// Team-level standings from completed round-robin merge matchups — direct
// adaptation of tournamentStandings.js's buildTournamentStandings, one level
// up (teams instead of pairs, tournament_team_matchups instead of
// tournament_matches). Tiebreak order: Wins -> Head-to-Head -> aggregate pair-
// match win margin across all merge matchups -> deterministic last resort.
export function buildTeamStandings(teams, teamMatchups){
  const rows = new Map(teams.map(t => [t.teamId, { teamId:t.teamId, wins:0, losses:0, matchesPlayed:0, pairWinMargin:0 }]));
  const completed = teamMatchups.filter(m => m.status === "completed" && m.teamAId && m.teamBId && (m.mergeGroupA || m.mergeGroupB));

  for (const m of completed){
    const a = rows.get(m.teamAId), b = rows.get(m.teamBId);
    if (!a || !b) continue;
    a.matchesPlayed++; b.matchesPlayed++;
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

// Called once isMergeRoundRobinComplete(...) is true. `standings`: output of
// buildTeamStandings, already ranked. `teams`: the full flat teams array
// (groupRegistrationsByTeam's output) so pair matches can be built. Bronze is
// only generated when a genuine 4th-ranked team exists — round robin among
// exactly 3 groups has no real "4th place," so Bronze is silently unavailable
// there even if the division has Battle for Bronze enabled (surfaced by the
// caller in the UI, not an error here).
export function generateMergeFinalAndBronze(standings, teams, { makeId, bronzeMatch } = {}){
  const genId = makeId || defaultId;
  if (standings.length < 2) return { teamMatchups:[], pairMatches:[] };
  const pairsPerMatchup = teams[0].pairs.length;

  const final = {
    id: genId(), round:1, bracketPosition:0,
    teamAId: standings[0].teamId, teamBId: standings[1].teamId,
    teamAWins:0, teamBWins:0, pairsPerMatchup, winnerTeamId:null, status:"pending",
    isFinal:true, stageLabel:"Final",
  };
  const teamMatchups = [final];
  let pairMatches = legacyBuildPairMatchesForMatchup(final, teams, genId);

  if (bronzeMatch && standings.length >= 4){
    const bronze = {
      id: genId(), round:1, bracketPosition:1,
      teamAId: standings[2].teamId, teamBId: standings[3].teamId,
      teamAWins:0, teamBWins:0, pairsPerMatchup, winnerTeamId:null, status:"pending",
      bracketSide:"bronze", stageLabel:"Bronze Match",
    };
    teamMatchups.push(bronze);
    pairMatches = pairMatches.concat(legacyBuildPairMatchesForMatchup(bronze, teams, genId));
  }

  return { teamMatchups, pairMatches };
}
