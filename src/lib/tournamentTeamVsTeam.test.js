import { describe, test, expect } from "vitest";
import {
  rankTeams, groupRegistrationsByTeam,
  buildPairMatchesForMatchup, advanceTeamMatchup, advanceBronzeTeamMatchup,
  advanceIndividualMatchup, advanceBronzeIndividualMatchup,
  finalizeCrossTeamMatchup,
} from "./tournamentTeamVsTeam.js";

const idGen = () => { let i = 0; return () => "m" + (i++); };

// Builds `teamCount` teams, each with `pairsPerTeam` pairs, seeded so that
// team 0's pairs are seeds 1..pairsPerTeam, team 1's are the next block, etc.
// (mirrors what seedByTeamRanking already produces in the real app).
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

describe("rankTeams", () => {
  test("ranks by each team's minimum pair seed, ascending", () => {
    const teams = [
      { teamId: "t2", pairs: [{ seed: 10 }, { seed: 11 }] },
      { teamId: "t0", pairs: [{ seed: 1 }, { seed: 2 }] },
      { teamId: "t1", pairs: [{ seed: 5 }, { seed: 6 }] },
    ];
    expect(rankTeams(teams).map(t => t.teamId)).toEqual(["t0","t1","t2"]);
  });

  test("ties broken deterministically by teamId", () => {
    const teams = [
      { teamId: "zzz", pairs: [{ seed: 1 }] },
      { teamId: "aaa", pairs: [{ seed: 1 }] },
    ];
    expect(rankTeams(teams).map(t => t.teamId)).toEqual(["aaa","zzz"]);
  });
});

describe("groupRegistrationsByTeam", () => {
  const teamGroups = [{ id: "t0", name: "Team A" }, { id: "t1", name: "Team B" }];

  test("success: equal team sizes (>=2 pairs), pairs sorted by seed within each team", () => {
    const regs = [
      { id: "r1", seed: 3, teamId: "t0" }, { id: "r2", seed: 1, teamId: "t0" },
      { id: "r3", seed: 2, teamId: "t1" }, { id: "r4", seed: 4, teamId: "t1" },
    ];
    const result = groupRegistrationsByTeam(regs, teamGroups);
    expect(result.ok).toBe(true);
    const teamA = result.teams.find(t => t.teamId === "t0");
    expect(teamA.pairs.map(p => p.id)).toEqual(["r2","r1"]); // seed 1 before seed 3
  });

  test("failure: any unassigned pair blocks generation", () => {
    const regs = [
      { id: "r1", seed: 1, teamId: "t0" }, { id: "r2", seed: 2, teamId: "t1" },
      { id: "r3", seed: 3, teamId: null },
    ];
    const result = groupRegistrationsByTeam(regs, teamGroups);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("unassigned_pairs");
    expect(result.unassignedCount).toBe(1);
  });

  test("failure: fewer than 2 teams with pairs", () => {
    const regs = [{ id: "r1", seed: 1, teamId: "t0" }];
    const result = groupRegistrationsByTeam(regs, teamGroups);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("too_few_teams");
  });

  test("failure: uneven team sizes, with a per-team breakdown", () => {
    const regs = [
      { id: "r1", seed: 1, teamId: "t0" }, { id: "r2", seed: 2, teamId: "t0" },
      { id: "r3", seed: 3, teamId: "t1" }, { id: "r4", seed: 4, teamId: "t1" },
      { id: "r5", seed: 5, teamId: "t1" },
    ];
    const result = groupRegistrationsByTeam(regs, teamGroups);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("uneven_team_sizes");
    expect(result.teams).toEqual(expect.arrayContaining([
      { teamId: "t0", teamName: "Team A", count: 2 },
      { teamId: "t1", teamName: "Team B", count: 3 },
    ]));
  });

  test("failure: a team with only 1 pair can't be scheduled (N x (N-1) is 0 at N=1)", () => {
    const regs = [
      { id: "r1", seed: 1, teamId: "t0" },
      { id: "r2", seed: 2, teamId: "t1" },
    ];
    const result = groupRegistrationsByTeam(regs, teamGroups);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("team_too_small");
  });
});

describe("buildPairMatchesForMatchup — balanced N x (N-1) cross rotation", () => {
  test("the spec's exact 5x5 rotation table (Match 1..20)", () => {
    const teams = buildTeams(2, 5); // team0 = A1..A5, team1 = B1..B5
    const matchup = { id: "ttm1", round: 1, bracketPosition: 0, teamAId: "team0", teamBId: "team1" };
    const rows = buildPairMatchesForMatchup(matchup, teams, idGen());
    expect(rows.length).toBe(20); // 5 x 4

    const labels = new Map();
    teams[0].pairs.forEach((p,i) => labels.set(p.id, "A"+(i+1)));
    teams[1].pairs.forEach((p,i) => labels.set(p.id, "B"+(i+1)));
    const actual = rows.sort((a,b) => a.pairSlot-b.pairSlot)
      .map(r => [labels.get(r.registrationAId), labels.get(r.registrationBId)]);

    const expected = [
      // Rotation 1
      ["A1","B1"],["A2","B2"],["A3","B3"],["A4","B4"],["A5","B5"],
      // Rotation 2
      ["A1","B2"],["A2","B3"],["A3","B4"],["A4","B5"],["A5","B1"],
      // Rotation 3
      ["A1","B3"],["A2","B4"],["A3","B5"],["A4","B1"],["A5","B2"],
      // Rotation 4
      ["A1","B4"],["A2","B5"],["A3","B1"],["A4","B2"],["A5","B3"],
    ];
    expect(actual).toEqual(expected);
  });

  test("3 pairs -> 6 matches, matching the spec's 3-pair example exactly", () => {
    const teams = buildTeams(2, 3);
    const matchup = { id: "ttm1", round: 1, bracketPosition: 0, teamAId: "team0", teamBId: "team1" };
    const rows = buildPairMatchesForMatchup(matchup, teams, idGen());
    const labels = new Map();
    teams[0].pairs.forEach((p,i) => labels.set(p.id, "A"+(i+1)));
    teams[1].pairs.forEach((p,i) => labels.set(p.id, "B"+(i+1)));
    const actual = rows.sort((a,b) => a.pairSlot-b.pairSlot).map(r => [labels.get(r.registrationAId), labels.get(r.registrationBId)]);
    expect(actual).toEqual([
      ["A1","B1"],["A2","B2"],["A3","B3"],
      ["A1","B2"],["A2","B3"],["A3","B1"],
    ]);
  });

  test.each([[3,6],[4,12],[5,20],[6,30]])("general formula: N=%i pairs -> N*(N-1)=%i matches", (n, expected) => {
    const teams = buildTeams(2, n);
    const matchup = { id: "ttm1", round: 1, bracketPosition: 0, teamAId: "team0", teamBId: "team1" };
    const rows = buildPairMatchesForMatchup(matchup, teams, idGen());
    expect(rows.length).toBe(expected);
  });

  test.each([3,4,5,6])("N=%i: every A pair faces N-1 distinct B pairs, no repeats, no self-match, no duplicate A/B pair", (n) => {
    const teams = buildTeams(2, n);
    const matchup = { id: "ttm1", round: 1, bracketPosition: 0, teamAId: "team0", teamBId: "team1" };
    const rows = buildPairMatchesForMatchup(matchup, teams, idGen());

    expect(rows.length).toBe(n*(n-1));
    const seenPairs = new Set();
    const opponentsByA = new Map();
    for (const r of rows){
      const key = r.registrationAId+"|"+r.registrationBId;
      expect(seenPairs.has(key)).toBe(false); // no duplicate A/B combination
      seenPairs.add(key);
      if (!opponentsByA.has(r.registrationAId)) opponentsByA.set(r.registrationAId, new Set());
      opponentsByA.get(r.registrationAId).add(r.registrationBId);
    }
    for (const opponents of opponentsByA.values()) expect(opponents.size).toBe(n-1); // exactly N-1 distinct opponents
  });

  test("returns [] if either team isn't found (still-TBD matchup)", () => {
    const teams = buildTeams(2, 3);
    expect(buildPairMatchesForMatchup({ id:"x", teamAId:"team0", teamBId:null }, teams, idGen())).toEqual([]);
  });
});

describe("advanceTeamMatchup / advanceBronzeTeamMatchup — wiring correctness", () => {
  test("advanceTeamMatchup fills the winner into the correct next-matchup slot", () => {
    const sf1 = { id:"sf1", nextMatchupId:"final", nextMatchupSlot:"A" };
    const final = { id:"final" };
    const patch = advanceTeamMatchup([sf1, final], "sf1", "team0");
    expect(patch.matchupId).toBe("final");
    expect(patch.patch).toEqual({ teamAId:"team0", status:"pending" });
  });

  test("advanceTeamMatchup returns null when there's no nextMatchupId (a true final)", () => {
    const final = { id:"final" };
    expect(advanceTeamMatchup([final], "final", "team0")).toBeNull();
  });

  test("advanceBronzeTeamMatchup fills both semifinal losers into the bronze matchup", () => {
    const sf1 = { id:"sf1", loserNextMatchupId:"bronze", loserNextMatchupSlot:"A" };
    const sf2 = { id:"sf2", loserNextMatchupId:"bronze", loserNextMatchupSlot:"B" };
    const bronze = { id:"bronze" };
    const p1 = advanceBronzeTeamMatchup([sf1, sf2, bronze], "sf1", "loser1");
    expect(p1).toEqual({ matchupId:"bronze", patch:{ teamAId:"loser1", status:"pending" } });
    const p2 = advanceBronzeTeamMatchup([sf1, sf2, bronze], "sf2", "loser2");
    expect(p2).toEqual({ matchupId:"bronze", patch:{ teamBId:"loser2", status:"pending" } });
  });
});

describe("advanceIndividualMatchup / advanceBronzeIndividualMatchup — wiring correctness", () => {
  test("advanceIndividualMatchup fills the winning PAIR (and its team, informational) into the correct next-matchup slot", () => {
    const sf1 = { id:"sf1", nextMatchupId:"final", nextMatchupSlot:"A" };
    const final = { id:"final" };
    const patch = advanceIndividualMatchup([sf1, final], "sf1", "pairA1", "teamA");
    expect(patch.matchupId).toBe("final");
    expect(patch.patch).toEqual({ pairAId:"pairA1", teamAId:"teamA", status:"pending" });
  });

  test("advanceIndividualMatchup returns null when there's no nextMatchupId (a true final)", () => {
    const final = { id:"final" };
    expect(advanceIndividualMatchup([final], "final", "pairA1", "teamA")).toBeNull();
  });

  test("advanceBronzeIndividualMatchup fills both semifinal losing pairs into the bronze matchup", () => {
    const sf1 = { id:"sf1", loserNextMatchupId:"bronze", loserNextMatchupSlot:"A" };
    const sf2 = { id:"sf2", loserNextMatchupId:"bronze", loserNextMatchupSlot:"B" };
    const bronze = { id:"bronze" };
    const p1 = advanceBronzeIndividualMatchup([sf1, sf2, bronze], "sf1", "loserPair1", "teamA");
    expect(p1).toEqual({ matchupId:"bronze", patch:{ pairAId:"loserPair1", teamAId:"teamA", status:"pending" } });
    const p2 = advanceBronzeIndividualMatchup([sf1, sf2, bronze], "sf2", "loserPair2", "teamB");
    expect(p2).toEqual({ matchupId:"bronze", patch:{ pairBId:"loserPair2", teamBId:"teamB", status:"pending" } });
  });

  test("same-team-both-semifinalists: advancement still carries the correct PAIR identity even when teamAId===teamBId", () => {
    // Both semifinalists share a team — the informational team id is identical on
    // both slots, but the pair-level advancement must still distinguish them.
    const sf1 = { id:"sf1", nextMatchupId:"final", nextMatchupSlot:"A", teamAId:"tA", teamBId:"tA" };
    const final = { id:"final" };
    const patch = advanceIndividualMatchup([sf1, final], "sf1", "a1", "tA");
    expect(patch.patch.pairAId).toBe("a1");
    expect(patch.patch.teamAId).toBe("tA");
  });
});

describe("finalizeCrossTeamMatchup — decides only once every pair match is completed", () => {
  const matchup = { id:"ttm1", teamAId:"A", teamBId:"B" };

  test("returns null while any pair match is still in progress", () => {
    const pairMatches = [
      { teamMatchupId:"ttm1", status:"completed", winner:"A", score:{scoreA:11,scoreB:5} },
      { teamMatchupId:"ttm1", status:"in_progress", winner:null },
    ];
    expect(finalizeCrossTeamMatchup(matchup, pairMatches)).toBeNull();
  });

  test("decides by win count once every pair match is completed", () => {
    const pairMatches = [
      { teamMatchupId:"ttm1", status:"completed", winner:"A", score:{scoreA:11,scoreB:5} },
      { teamMatchupId:"ttm1", status:"completed", winner:"A", score:{scoreA:11,scoreB:7} },
      { teamMatchupId:"ttm1", status:"completed", winner:"B", score:{scoreA:6,scoreB:11} },
    ];
    const result = finalizeCrossTeamMatchup(matchup, pairMatches);
    expect(result).toEqual({ teamAWins:2, teamBWins:1, winnerTeamId:"A" });
  });

  test("tie-break: equal win counts decided by aggregate point differential", () => {
    const pairMatches = [
      { teamMatchupId:"ttm1", status:"completed", winner:"A", score:{scoreA:11,scoreB:2} }, // A +9
      { teamMatchupId:"ttm1", status:"completed", winner:"B", score:{scoreA:10,scoreB:11} }, // A -1 (net +8 so far)
    ];
    // 1-1 on wins, but Team A leads on aggregate point differential (+8) -> Team A wins the tie.
    const result = finalizeCrossTeamMatchup(matchup, pairMatches);
    expect(result.teamAWins).toBe(1);
    expect(result.teamBWins).toBe(1);
    expect(result.winnerTeamId).toBe("A");
  });

  test("tie-break: point differential also tied falls back to a deterministic winner", () => {
    const pairMatches = [
      { teamMatchupId:"ttm1", status:"completed", winner:"A", score:{scoreA:11,scoreB:9} }, // A +2
      { teamMatchupId:"ttm1", status:"completed", winner:"B", score:{scoreA:9,scoreB:11} },  // A -2 (net 0)
    ];
    const result = finalizeCrossTeamMatchup(matchup, pairMatches);
    expect(["A","B"]).toContain(result.winnerTeamId);
    // Deterministic: calling again with the same inputs gives the same answer.
    expect(finalizeCrossTeamMatchup(matchup, pairMatches).winnerTeamId).toBe(result.winnerTeamId);
  });

  test("ignores pair matches belonging to a different matchup", () => {
    const pairMatches = [
      { teamMatchupId:"ttm1", status:"completed", winner:"A", score:{scoreA:11,scoreB:5} },
      { teamMatchupId:"other", status:"in_progress", winner:null },
    ];
    const result = finalizeCrossTeamMatchup(matchup, pairMatches);
    expect(result).toEqual({ teamAWins:1, teamBWins:0, winnerTeamId:"A" });
  });
});
