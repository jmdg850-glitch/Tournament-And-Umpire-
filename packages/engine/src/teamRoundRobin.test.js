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

// Pair-match fixture for team standings: `id`, pairs "teamN-rM", RR matchup id.
const pm = (id, teamMatchupId, a, b, scoreA, scoreB, status = "completed") => ({
  id, teamMatchupId, status, registrationAId: a, registrationBId: b,
  winner: status === "completed" ? (scoreA > scoreB ? "A" : "B") : null,
  score: { scoreA, scoreB },
});

describe("buildTeamStandingsFromRoundRobin — every completed round-robin pair match counts", () => {
  const teams = buildTeams(2, 3);
  const [A, B] = teams.map(t => t.teamId);
  // One team-vs-team matchup still in progress — the table must not wait for it.
  const rr = { id: "rr1", stage: "round_robin", status: "in_progress", teamAId: A, teamBId: B, teamAWins: 0, teamBWins: 0, winnerTeamId: null };

  test("one completed match: correct W/L/MP/PF/PA/+-", () => {
    const rows = buildTeamStandingsFromRoundRobin(teams, [rr], [pm("p1", "rr1", "team0-r0", "team1-r0", 11, 5)]);
    expect(rows.find(r => r.teamId === A)).toEqual(expect.objectContaining({ wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 11, pointsAgainst: 5, pointDiff: 6 }));
    expect(rows.find(r => r.teamId === B)).toEqual(expect.objectContaining({ wins: 0, losses: 1, matchesPlayed: 1, pointsFor: 5, pointsAgainst: 11, pointDiff: -6 }));
  });

  test("multiple completed matches accumulate (11-5, 11-9, 7-11 -> W2 L1 MP3 PF29 PA25 +4)", () => {
    const rows = buildTeamStandingsFromRoundRobin(teams, [rr], [
      pm("p1", "rr1", "team0-r0", "team1-r0", 11, 5),
      pm("p2", "rr1", "team0-r1", "team1-r1", 11, 9),
      pm("p3", "rr1", "team0-r2", "team1-r2", 7, 11),
    ]);
    const a = rows.find(r => r.teamId === A);
    expect(a).toEqual(expect.objectContaining({ wins: 2, losses: 1, matchesPlayed: 3, pointsFor: 29, pointsAgainst: 25, pointDiff: 4 }));
    expect(a.matchesPlayed).toBe(a.wins + a.losses);
    expect(rows.find(r => r.teamId === B)).toEqual(expect.objectContaining({ wins: 1, losses: 2, matchesPlayed: 3, pointsFor: 25, pointsAgainst: 29, pointDiff: -4 }));
  });

  test("unfinished (scheduled / in_progress) matches do not affect standings; a duplicated row is counted once", () => {
    const rows = buildTeamStandingsFromRoundRobin(teams, [rr], [
      pm("p1", "rr1", "team0-r0", "team1-r0", 11, 5),
      pm("p1", "rr1", "team0-r0", "team1-r0", 11, 5),
      pm("p2", "rr1", "team0-r1", "team1-r1", 9, 9, "in_progress"),
      pm("p3", "rr1", "team0-r2", "team1-r2", 0, 0, "scheduled"),
    ]);
    expect(rows.find(r => r.teamId === A)).toEqual(expect.objectContaining({ wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 11, pointsAgainst: 5 }));
  });

  test("all qualification rounds (several round-robin matchups, 3 teams) are included", () => {
    const t3 = buildTeams(3, 2);
    const [X, Y, Z] = t3.map(t => t.teamId);
    const mus = [
      { id: "m1", stage: "round_robin", status: "completed", teamAId: X, teamBId: Y, winnerTeamId: X },
      { id: "m2", stage: "round_robin", status: "completed", teamAId: X, teamBId: Z, winnerTeamId: Z },
      { id: "m3", stage: "round_robin", status: "scheduled", teamAId: Y, teamBId: Z, winnerTeamId: null },
    ];
    const rows = buildTeamStandingsFromRoundRobin(t3, mus, [
      pm("a", "m1", "team0-r0", "team1-r0", 11, 6), pm("b", "m1", "team0-r1", "team1-r1", 11, 8),
      pm("c", "m2", "team0-r0", "team2-r0", 9, 11), pm("d", "m2", "team0-r1", "team2-r1", 5, 11),
      pm("e", "m3", "team1-r0", "team2-r0", 11, 3),
    ]);
    expect(rows.find(r => r.teamId === X)).toEqual(expect.objectContaining({ wins: 2, losses: 2, matchesPlayed: 4, pointsFor: 36, pointsAgainst: 36, teamMatchupWins: 1, teamMatchupLosses: 1 }));
    expect(rows.find(r => r.teamId === Y)).toEqual(expect.objectContaining({ wins: 1, losses: 2, matchesPlayed: 3, pointsFor: 25, pointsAgainst: 25 }));
    expect(rows.find(r => r.teamId === Z)).toEqual(expect.objectContaining({ wins: 2, losses: 1, matchesPlayed: 3, pointsFor: 25, pointsAgainst: 25 }));
  });

  test("semifinal, bronze and final pair matches are excluded", () => {
    const mus = [
      rr,
      { id: "sf1", stage: "semifinal", status: "completed", teamAId: A, teamBId: B, winnerTeamId: A },
      { id: "br", stage: "bronze", status: "completed", teamAId: A, teamBId: B, winnerTeamId: B },
      { id: "fi", stage: "final", status: "completed", teamAId: A, teamBId: B, winnerTeamId: A },
    ];
    const rows = buildTeamStandingsFromRoundRobin(teams, mus, [
      pm("p1", "rr1", "team0-r0", "team1-r0", 11, 5),
      pm("s", "sf1", "team0-r0", "team1-r0", 15, 2),
      pm("b", "br", "team0-r1", "team1-r1", 3, 15),
      pm("f", "fi", "team0-r2", "team1-r2", 15, 13),
    ]);
    expect(rows.find(r => r.teamId === A)).toEqual(expect.objectContaining({ wins: 1, losses: 0, matchesPlayed: 1, pointsFor: 11, pointsAgainst: 5 }));
    expect(rows.find(r => r.teamId === B)).toEqual(expect.objectContaining({ wins: 0, losses: 1, matchesPlayed: 1, pointsFor: 5, pointsAgainst: 11 }));
  });

  test("ranking: more W ranks higher; equal W -> higher +/- ranks higher", () => {
    const t3 = buildTeams(3, 2);
    const [X, Y, Z] = t3.map(t => t.teamId);
    const mus = ["m1", "m2", "m3"].map(id => ({ id, stage: "round_robin", status: "in_progress" }));
    // Y 3W, X 2W, Z 0W.
    const rows = buildTeamStandingsFromRoundRobin(t3, mus, [
      pm("a", "m1", "team0-r0", "team1-r0", 11, 9), pm("b", "m1", "team0-r1", "team1-r1", 9, 11),
      pm("c", "m2", "team0-r0", "team2-r0", 11, 9),
      pm("d", "m3", "team1-r0", "team2-r0", 11, 3), pm("e", "m3", "team1-r1", "team2-r1", 11, 3),
    ]);
    expect(rows.map(r => [r.teamId, r.wins])).toEqual([[Y, 3], [X, 2], [Z, 0]]);

    // Both 1W 1L; B has +6, A has -6 -> B first.
    const byDiff = buildTeamStandingsFromRoundRobin(teams, [rr], [
      pm("p1", "rr1", "team0-r0", "team1-r0", 11, 9),
      pm("p2", "rr1", "team0-r1", "team1-r1", 3, 11),
    ]);
    expect(byDiff.map(r => [r.teamId, r.wins, r.pointDiff, r.rank])).toEqual([[B, 1, 6, 1], [A, 1, -6, 2]]);
  });

  test("equal W and +/- -> head-to-head; fully tied teams share a rank (no hidden arbitrary order)", () => {
    const tied = [pm("p1", "rr1", "team0-r0", "team1-r0", 11, 9), pm("p2", "rr1", "team0-r1", "team1-r1", 9, 11)];
    expect(buildTeamStandingsFromRoundRobin(teams, [rr], tied).map(r => r.rank)).toEqual([1, 1]);

    const h2hDecided = buildTeamStandingsFromRoundRobin(teams, [{ ...rr, status: "completed", winnerTeamId: B }], tied);
    expect(h2hDecided.map(r => [r.teamId, r.rank])).toEqual([[B, 1], [A, 2]]);
  });

  test("with no pair matches every team is 0-0", () => {
    const rows = buildTeamStandingsFromRoundRobin(teams, [{ ...rr, status: "completed", winnerTeamId: A }]);
    for (const row of rows) expect(row).toEqual(expect.objectContaining({ wins: 0, losses: 0, matchesPlayed: 0, pointsFor: 0, pointsAgainst: 0, pointDiff: 0 }));
  });
});

describe("buildTeamStandingsFromRoundRobin — Points For/Against/Diff", () => {

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

  test("rows separated only by the stable fallback are flagged tieUnresolved; others are not", () => {
    const teams = teamsOf([["P1","tA"],["P2","tB"],["Q","tA"],["R","tB"]]);
    const pairMatches = [match("P1","P2","A",11,9), match("P2","P1","A",11,9), match("Q","R","A",11,0)];
    const ranked = rankIndividualPairsForSemifinals(teams, [rrMatchup], pairMatches);
    const flag = id => ranked.find(r => r.registrationId === id).tieUnresolved;
    expect(flag("P1")).toBe(true);
    expect(flag("P2")).toBe(true);
    expect(flag("Q")).toBe(false);
    expect(flag("R")).toBe(false);
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
