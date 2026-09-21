import { describe, test, expect } from "vitest";
import {
  generateTeamRoundRobinMatchups, buildTeamStandingsFromRoundRobin,
  isTeamRoundRobinComplete, rankIndividualPairsForSemifinals,
} from "./teamRoundRobin.js";
import { selectQualifiers, generateQualifierBracketShell } from "./teamPlayoffs.js";

const idGen = () => { let i = 0; return () => "id" + (i++); };

function buildTeams(teamCount, pairsPerTeam){
  const teams = [];
  let seed = 1;
  for (let t=0; t<teamCount; t++){
    const teamId = "team"+t;
    const pairs = [];
    for (let p=0; p<pairsPerTeam; p++){ pairs.push({ id: teamId+"-r"+p, seed, teamId }); seed++; }
    teams.push({ teamId, teamName: "Team "+String.fromCharCode(65+t), pairs });
  }
  return teams;
}

describe("generateTeamRoundRobinMatchups", () => {
  test("5 teams x 3 pairs: every team plays every other team exactly once, each matchup has both teams known and a full 3x2 schedule", () => {
    const teams = buildTeams(5, 3);
    const { teamMatchups, pairMatches } = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });

    expect(teamMatchups.length).toBe(5*4/2);
    expect(teamMatchups.every(m => m.stage === "round_robin")).toBe(true);
    expect(teamMatchups.every(m => m.teamAId && m.teamBId)).toBe(true);

    const seen = new Set();
    for (const m of teamMatchups){
      const key = [m.teamAId, m.teamBId].sort().join("|");
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(10);

    const appearances = new Map(teams.map(t => [t.teamId, 0]));
    for (const m of teamMatchups){
      appearances.set(m.teamAId, appearances.get(m.teamAId)+1);
      appearances.set(m.teamBId, appearances.get(m.teamBId)+1);
    }
    for (const count of appearances.values()) expect(count).toBe(4);

    expect(pairMatches.length).toBe(10 * (3*2));
    for (const m of teamMatchups){
      expect(pairMatches.filter(pm => pm.teamMatchupId === m.id).length).toBe(6);
    }
  });

  test("deterministic: same input (with a deterministic id generator) produces the same schedule", () => {
    const teams = buildTeams(4, 2);
    const a = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });
    const b = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });
    const shape = r => r.teamMatchups.map(m => [m.round, m.teamAId, m.teamBId]);
    expect(shape(a)).toEqual(shape(b));
  });
});

describe("buildTeamStandingsFromRoundRobin", () => {
  test("ranks by wins, then head-to-head, then aggregate pair-match win margin", () => {
    const teams = buildTeams(4, 2);
    const [A,B,C,D] = teams.map(t => t.teamId);
    const teamMatchups = [
      { id:"m1", stage:"round_robin", status:"completed", teamAId:A, teamBId:B, teamAWins:2, teamBWins:0, winnerTeamId:A },
      { id:"m2", stage:"round_robin", status:"completed", teamAId:A, teamBId:C, teamAWins:1, teamBWins:1, winnerTeamId:null },
      { id:"m3", stage:"round_robin", status:"completed", teamAId:A, teamBId:D, teamAWins:0, teamBWins:2, winnerTeamId:D },
      { id:"m4", stage:"round_robin", status:"completed", teamAId:B, teamBId:C, teamAWins:2, teamBWins:0, winnerTeamId:B },
      { id:"m5", stage:"round_robin", status:"completed", teamAId:B, teamBId:D, teamAWins:0, teamBWins:2, winnerTeamId:D },
      { id:"m6", stage:"round_robin", status:"completed", teamAId:C, teamBId:D, teamAWins:1, teamBWins:1, winnerTeamId:null },
    ];
    const standings = buildTeamStandingsFromRoundRobin(teams, teamMatchups);
    expect(standings.map(s => s.teamId)).toEqual([D, A, B, C]);
    const d = standings.find(s => s.teamId===D);
    expect(d.wins).toBe(2);
    expect(d.matchesPlayed).toBe(3);
  });

  test("ignores non-round_robin matchups (e.g. a semifinal that happens to be completed)", () => {
    const teams = buildTeams(2, 2);
    const [A,B] = teams.map(t => t.teamId);
    const teamMatchups = [
      { id:"sf1", stage:"semifinal", status:"completed", teamAId:A, teamBId:B, teamAWins:2, teamBWins:0, winnerTeamId:A },
    ];
    const standings = buildTeamStandingsFromRoundRobin(teams, teamMatchups);
    expect(standings).toHaveLength(2);
    for (const row of standings) expect(row).toEqual(expect.objectContaining({ wins:0, losses:0, matchesPlayed:0 }));
    expect(new Set(standings.map(r => r.teamId))).toEqual(new Set([A,B]));
  });
});

describe("buildTeamStandingsFromRoundRobin — Points For/Against/Diff", () => {
  test("aggregates raw pair-match points up to each pair's team; existing wins/losses/margin fields and rank order are unaffected", () => {
    const teams = buildTeams(3, 2);
    const [A, B, C] = teams.map((t) => t.teamId);
    const teamMatchups = [
      { id: "m1", stage: "round_robin", status: "completed", teamAId: A, teamBId: B, teamAWins: 2, teamBWins: 0, winnerTeamId: A },
      { id: "m2", stage: "round_robin", status: "completed", teamAId: A, teamBId: C, teamAWins: 1, teamBWins: 1, winnerTeamId: null },
      { id: "m3", stage: "round_robin", status: "completed", teamAId: B, teamBId: C, teamAWins: 0, teamBWins: 2, winnerTeamId: C },
    ];
    const pairMatches = [
      { teamMatchupId: "m1", status: "completed", registrationAId: "team0-r0", registrationBId: "team1-r0", score: { scoreA: 11, scoreB: 6 } },
      { teamMatchupId: "m1", status: "completed", registrationAId: "team0-r1", registrationBId: "team1-r1", score: { scoreA: 11, scoreB: 8 } },
      { teamMatchupId: "m2", status: "completed", registrationAId: "team0-r0", registrationBId: "team2-r0", score: { scoreA: 11, scoreB: 9 } },
      { teamMatchupId: "m2", status: "completed", registrationAId: "team0-r1", registrationBId: "team2-r1", score: { scoreA: 7, scoreB: 11 } },
      { teamMatchupId: "m3", status: "completed", registrationAId: "team1-r0", registrationBId: "team2-r0", score: { scoreA: 4, scoreB: 11 } },
      { teamMatchupId: "m3", status: "completed", registrationAId: "team1-r1", registrationBId: "team2-r1", score: { scoreA: 9, scoreB: 11 } },
    ];
    const withPoints = buildTeamStandingsFromRoundRobin(teams, teamMatchups, pairMatches);
    const withoutPoints = buildTeamStandingsFromRoundRobin(teams, teamMatchups);
    const a = withPoints.find((s) => s.teamId === A);
    const b = withPoints.find((s) => s.teamId === B);
    const c = withPoints.find((s) => s.teamId === C);

    expect(a.pointsFor).toBe(40); // 11+11+11+7
    expect(a.pointsAgainst).toBe(34); // 6+8+9+11
    expect(a.pointDiff).toBe(6);

    expect(b.pointsFor).toBe(27); // 6+8+4+9
    expect(b.pointsAgainst).toBe(44); // 11+11+11+11
    expect(b.pointDiff).toBe(-17);

    expect(c.pointsFor).toBe(42); // 9+11+11+11
    expect(c.pointsAgainst).toBe(31); // 11+7+4+9
    expect(c.pointDiff).toBe(11);

    // Adding points is purely additive — rank order, wins/losses/margin identical either way.
    expect(withPoints.map((s) => [s.teamId, s.wins, s.losses, s.pairWinMargin, s.rank])).toEqual(
      withoutPoints.map((s) => [s.teamId, s.wins, s.losses, s.pairWinMargin, s.rank])
    );
  });

  test("omitting pairMatches leaves Points For/Against/Diff at zero", () => {
    const teams = buildTeams(2, 2);
    const [A, B] = teams.map((t) => t.teamId);
    const teamMatchups = [
      { id: "m1", stage: "round_robin", status: "completed", teamAId: A, teamBId: B, teamAWins: 2, teamBWins: 0, winnerTeamId: A },
    ];
    const standings = buildTeamStandingsFromRoundRobin(teams, teamMatchups);
    for (const row of standings) {
      expect(row.pointsFor).toBe(0);
      expect(row.pointsAgainst).toBe(0);
      expect(row.pointDiff).toBe(0);
    }
  });

  test("excludes non-round-robin-stage and non-completed pair matches from Points For/Against", () => {
    const teams = buildTeams(2, 1);
    const [A, B] = teams.map((t) => t.teamId);
    const teamMatchups = [
      { id: "rr1", stage: "round_robin", status: "completed", teamAId: A, teamBId: B, teamAWins: 1, teamBWins: 0, winnerTeamId: A },
      { id: "sf1", stage: "semifinal", status: "completed", teamAId: A, teamBId: B, teamAWins: 1, teamBWins: 0, winnerTeamId: A },
    ];
    const pairMatches = [
      { teamMatchupId: "rr1", status: "completed", registrationAId: "team0-r0", registrationBId: "team1-r0", score: { scoreA: 11, scoreB: 5 } },
      // Same pair, but the "semifinal" matchup — must not be pulled into round-robin standings.
      { teamMatchupId: "sf1", status: "completed", registrationAId: "team0-r0", registrationBId: "team1-r0", score: { scoreA: 15, scoreB: 2 } },
    ];
    const standings = buildTeamStandingsFromRoundRobin(teams, teamMatchups, pairMatches);
    const a = standings.find((s) => s.teamId === A);
    const b = standings.find((s) => s.teamId === B);
    expect(a.pointsFor).toBe(11);
    expect(a.pointsAgainst).toBe(5);
    expect(b.pointsFor).toBe(5);
    expect(b.pointsAgainst).toBe(11);
  });
});

describe("isTeamRoundRobinComplete", () => {
  test("false with no round-robin rows, false while any is incomplete, true once all are completed", () => {
    expect(isTeamRoundRobinComplete([])).toBe(false);
    const rows = [
      { stage:"round_robin", status:"completed" },
      { stage:"round_robin", status:"scheduled" },
    ];
    expect(isTeamRoundRobinComplete(rows)).toBe(false);
    rows[1].status = "completed";
    expect(isTeamRoundRobinComplete(rows)).toBe(true);
  });

  test("a completed semifinal alongside an incomplete round_robin row doesn't count as complete", () => {
    const rows = [
      { stage:"round_robin", status:"scheduled" },
      { stage:"semifinal", status:"completed" },
    ];
    expect(isTeamRoundRobinComplete(rows)).toBe(false);
  });
});

function teamsOf(pairSpecs){
  const byTeam = new Map();
  for (const [id, teamId] of pairSpecs){
    if (!byTeam.has(teamId)) byTeam.set(teamId, { teamId, teamName: "Team "+teamId, pairs: [] });
    byTeam.get(teamId).pairs.push({ id, seed: byTeam.get(teamId).pairs.length+1, teamId });
  }
  return [...byTeam.values()];
}
const rrMatchup = { id:"m1", stage:"round_robin" };
const match = (a, b, winner, scoreA, scoreB) => ({
  registrationAId:a, registrationBId:b, winner, status:"completed",
  score:{ scoreA, scoreB }, teamMatchupId:"m1",
});

describe("rankIndividualPairsForSemifinals — combines every pair from every team, no team quota", () => {
  test("tier 1: ranks by individual wins first", () => {
    const teams = teamsOf([["A","tA"],["B","tA"],["C","tB"],["D","tB"]]);
    const pairMatches = [
      match("A","B","A",11,5), match("A","C","A",11,6), match("A","D","A",11,7),
      match("B","C","A",11,8), match("B","D","A",11,4),
      match("C","D","A",11,9),
    ];
    const ranked = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches);
    expect(ranked.map(r => r.registrationId)).toEqual(["A","B","C","D"]);
    expect(ranked[0]).toEqual(expect.objectContaining({ wins:3, losses:0, rank:1 }));
    expect(ranked[3]).toEqual(expect.objectContaining({ wins:0, losses:3, rank:4 }));
  });

  test("tier 2: wins tied -> fewer losses ranks higher", () => {
    const teams = teamsOf([["M","tA"],["N","tA"],["R1","tA"],["R2","tB"],["R3","tB"],["R4","tB"],["R5","tB"]]);
    const pairMatches = [
      match("M","R1","A",11,3), match("M","R2","A",11,4),
      match("N","R3","A",11,5), match("N","R4","A",11,6), match("R5","N","A",11,2),
    ];
    const ranked = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches);
    const m = ranked.find(r => r.registrationId==="M"), n = ranked.find(r => r.registrationId==="N");
    expect(m.wins).toBe(2); expect(m.losses).toBe(0);
    expect(n.wins).toBe(2); expect(n.losses).toBe(1);
    expect(m.rank).toBeLessThan(n.rank);
  });

  test("tier 3: wins and losses tied -> higher point differential ranks higher", () => {
    const teams = teamsOf([["S","tA"],["T","tA"],["U","tB"],["V","tB"],["W","tB"],["X","tB"]]);
    const pairMatches = [
      match("S","U","A",11,1), match("V","S","A",11,5),
      match("T","W","A",11,9), match("X","T","A",11,9),
    ];
    const ranked = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches);
    const s = ranked.find(r => r.registrationId==="S"), t = ranked.find(r => r.registrationId==="T");
    expect(s.wins).toBe(1); expect(s.losses).toBe(1); expect(s.pointDiff).toBe(4);
    expect(t.wins).toBe(1); expect(t.losses).toBe(1); expect(t.pointDiff).toBe(0);
    expect(s.rank).toBeLessThan(t.rank);
  });

  test("tier 4: wins, losses, and point differential all tied -> higher Points For ranks higher", () => {
    const teams = teamsOf([["G","tA"],["H","tA"],["I","tB"],["J","tB"],["K","tB"],["L","tB"]]);
    const pairMatches = [
      match("G","I","A",15,13), match("J","G","A",15,13),
      match("H","K","A",11,9), match("L","H","A",11,9),
    ];
    const ranked = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches);
    const g = ranked.find(r => r.registrationId==="G"), h = ranked.find(r => r.registrationId==="H");
    expect(g.pointDiff).toBe(0); expect(h.pointDiff).toBe(0);
    expect(g.pointsFor).toBe(28); expect(h.pointsFor).toBe(20);
    expect(g.rank).toBeLessThan(h.rank);
  });

  test("tier 5: everything tied -> deterministic (not random) final tiebreak", () => {
    const teams = teamsOf([["P1","tA"],["P2","tB"]]);
    const pairMatches = [match("P1","P2","A",11,9), match("P2","P1","A",11,9)];
    const first = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches).map(r => r.registrationId);
    const second = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches).map(r => r.registrationId);
    expect(first).toEqual(second);
  });

  test("only counts completed matches belonging to round_robin-stage matchups (excludes semifinal/bronze/final pair matches)", () => {
    const teams = teamsOf([["A","tA"],["B","tB"]]);
    const teamMatchups = [{ id:"m1", stage:"round_robin" }, { id:"sf1", stage:"semifinal" }];
    const pairMatches = [
      { registrationAId:"A", registrationBId:"B", winner:"A", status:"completed", score:{scoreA:11,scoreB:5}, teamMatchupId:"m1" },
      { registrationAId:"B", registrationBId:"A", winner:"B", status:"completed", score:{scoreA:3,scoreB:11}, teamMatchupId:"sf1" },
      { registrationAId:"A", registrationBId:"B", winner:"A", status:"in_progress", score:{}, teamMatchupId:"m1" },
    ];
    const ranked = rankIndividualPairsForSemifinals(teams, teamMatchups, pairMatches);
    expect(ranked.find(r => r.registrationId==="A")).toEqual(expect.objectContaining({ wins:1, losses:0, matchesPlayed:1 }));
    expect(ranked.find(r => r.registrationId==="B")).toEqual(expect.objectContaining({ wins:0, losses:1, matchesPlayed:1 }));
  });
});

describe("end-to-end: round robin -> Team Standings (unchanged) + Individual ranking -> Top 4 pairs -> Semifinals -> Bronze/Final", () => {
  test("a realistic 5-team x 5-pair division flows through every stage with correct match counts, and Team Standings stays a separate, still-correct view", () => {
    const teams = buildTeams(5, 5);
    const { teamMatchups: rrMatchups, pairMatches: rrPairs } = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });
    expect(rrMatchups.length).toBe(10);
    expect(rrPairs.length).toBe(10 * 20);

    const completedPairMatches = rrPairs.map(pm => {
      const aTeam = Number(pm.registrationAId.split("-r")[0].replace("team",""));
      const bTeam = Number(pm.registrationBId.split("-r")[0].replace("team",""));
      const winner = aTeam < bTeam ? "A" : "B";
      return { ...pm, status:"completed", winner, score: winner==="A" ? {scoreA:11,scoreB:5} : {scoreA:5,scoreB:11} };
    });
    const completedMatchups = rrMatchups.map(m => {
      const aIsBetter = Number(m.teamAId.replace("team","")) < Number(m.teamBId.replace("team",""));
      const winnerTeamId = aIsBetter ? m.teamAId : m.teamBId;
      return { ...m, status:"completed", winnerTeamId, teamAWins: aIsBetter?20:0, teamBWins: aIsBetter?0:20 };
    });
    expect(isTeamRoundRobinComplete(completedMatchups)).toBe(true);

    const standings = buildTeamStandingsFromRoundRobin(teams, completedMatchups);
    expect(standings.map(s => s.teamId)).toEqual(["team0","team1","team2","team3","team4"]);

    // Points For/Against: team0 is the lowest-numbered team, so per the
    // winner rule above it wins every pair match 11-5 against all 4 other
    // teams — each team-matchup has 5*4=20 cross pair matches (see
    // generateTeamRoundRobinMatchups' own "10 * 20" assertion above), so
    // team0 plays 4 team-matchups * 20 = 80 pair matches, all won 11-5.
    // team4, the highest-numbered, loses all of its 80 the same way.
    const standingsWithPoints = buildTeamStandingsFromRoundRobin(teams, completedMatchups, completedPairMatches);
    const team0 = standingsWithPoints.find(s => s.teamId === "team0");
    const team4 = standingsWithPoints.find(s => s.teamId === "team4");
    expect(team0.pointsFor).toBe(880); expect(team0.pointsAgainst).toBe(400); expect(team0.pointDiff).toBe(480);
    expect(team4.pointsFor).toBe(400); expect(team4.pointsAgainst).toBe(880); expect(team4.pointDiff).toBe(-480);
    // Adding points doesn't change rank/wins/losses — same order as the points-less call above.
    expect(standingsWithPoints.map(s => s.teamId)).toEqual(standings.map(s => s.teamId));

    const ranked = rankIndividualPairsForSemifinals(teams, completedMatchups, completedPairMatches);
    expect(ranked.length).toBe(25);
    expect(ranked.slice(0,4).every(r => r.teamId==="team0")).toBe(true);

    const qualifiers = selectQualifiers(ranked, "top_x", 4);
    const { teamMatchups: shellMatchups, pairMatches: shellPairs } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), startRound: 5 });
    const sf1 = shellMatchups.find(m => m.stage==="semifinal" && m.bracketPosition===0);
    const sf2 = shellMatchups.find(m => m.stage==="semifinal" && m.bracketPosition===1);
    expect(sf1.teamAId).toBe("team0"); expect(sf1.teamBId).toBe("team0");
    expect(sf1.pairAId).not.toBe(sf1.pairBId);
    expect(shellPairs.filter(pm => pm.teamMatchupId===sf1.id).length).toBe(1);
    expect(shellPairs.filter(pm => pm.teamMatchupId===sf2.id).length).toBe(1);

    const sf1Match = shellPairs.find(pm => pm.teamMatchupId===sf1.id);
    expect([sf1.pairAId, sf1.pairBId]).toContain(sf1Match.registrationAId);

    const final = shellMatchups.find(m => m.stage==="final");
    const bronze = shellMatchups.find(m => m.stage==="bronze");
    expect(final.stageLabel).toBe("Final");
    expect(bronze.stageLabel).toBe("Bronze Match");
    expect(bronze).toBeTruthy();

    const standingsAgain = buildTeamStandingsFromRoundRobin(teams, completedMatchups);
    expect(standingsAgain).toEqual(standings);
    const perTeamQualifiers = selectQualifiers(ranked, "top_x_per_team", 2);
    expect(perTeamQualifiers.length).toBe(10);
    const standingsOnceMore = buildTeamStandingsFromRoundRobin(teams, completedMatchups);
    expect(standingsOnceMore).toEqual(standings);
  });
});
