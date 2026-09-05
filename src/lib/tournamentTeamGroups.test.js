import { describe, test, expect } from "vitest";
import {
  partitionTeamsByBracketGroup, rankGroups, computeStageLabels,
  generateGroupedTeamVsTeamBracket, fillMergeGroupChampion, isMergeRoundRobinComplete,
  buildTeamStandings, generateMergeFinalAndBronze, legacyGenerateTeamVsTeamBracket as generateTeamVsTeamBracket,
} from "./tournamentTeamGroups.js";

const idGen = () => { let i = 0; return () => "m" + (i++); };

// teamCount teams x pairsPerTeam pairs, seeded consecutively; every teamCount
// teams (in order) assigned a bracketGroup label from `groupLabels` (round-robin
// over the label list, so e.g. groupLabels=["A","B"] with 4 teams -> A,B,A,B).
function buildTeams(teamCount, pairsPerTeam, groupLabels=null){
  const teams = [];
  let seed = 1;
  for (let t=0; t<teamCount; t++){
    const teamId = "team"+t;
    const pairs = [];
    for (let p=0; p<pairsPerTeam; p++){ pairs.push({ id: teamId+"-r"+p, seed, teamId }); seed++; }
    const bracketGroup = groupLabels ? groupLabels[t % groupLabels.length] : null;
    teams.push({ teamId, teamName: "Team "+String.fromCharCode(65+t), bracketGroup, pairs });
  }
  return teams;
}

describe("partitionTeamsByBracketGroup", () => {
  test("no team has a bracketGroup -> not grouped", () => {
    const teams = buildTeams(4, 2);
    const result = partitionTeamsByBracketGroup(teams);
    expect(result).toEqual({ ok:true, grouped:false, teams });
  });

  test("every team shares the same single label -> treated as not grouped", () => {
    const teams = buildTeams(4, 2, ["Solo"]);
    const result = partitionTeamsByBracketGroup(teams);
    expect(result.ok).toBe(true);
    expect(result.grouped).toBe(false);
  });

  test("2 distinct labels, every team assigned -> grouped, sorted by label", () => {
    const teams = buildTeams(4, 2, ["Bracket B","Bracket A"]); // team0=B,team1=A,team2=B,team3=A
    const result = partitionTeamsByBracketGroup(teams);
    expect(result.ok).toBe(true);
    expect(result.grouped).toBe(true);
    expect(result.groups.map(g => g.label)).toEqual(["Bracket A","Bracket B"]);
    expect(result.groups.find(g => g.label==="Bracket A").teams.length).toBe(2);
  });

  test("partial assignment (some teams grouped, some not) is a hard error", () => {
    const teams = buildTeams(4, 2, ["A","A"]);
    teams[2].bracketGroup = null; teams[3].bracketGroup = null;
    const result = partitionTeamsByBracketGroup(teams);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("partial_group_assignment");
    expect(result.ungroupedCount).toBe(2);
  });

  test("a group with only 1 team is rejected", () => {
    const teams = buildTeams(3, 2, ["A","B","B"]); // A has 1 team, B has 2
    const result = partitionTeamsByBracketGroup(teams);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("group_too_small");
    expect(result.groupLabel).toBe("A");
    expect(result.count).toBe(1);
  });

  test("uneven team COUNTS across groups (not pair counts) is allowed", () => {
    const teams = buildTeams(5, 2, ["A","A","A","B","B"]); // A=3 teams, B=2 teams
    const result = partitionTeamsByBracketGroup(teams);
    expect(result.ok).toBe(true);
    expect(result.grouped).toBe(true);
  });
});

describe("rankGroups", () => {
  test("ranks by the minimum pair-seed among any of a group's teams' pairs", () => {
    const groups = [
      { label:"B", teams:[{ teamId:"t2", pairs:[{seed:10}] }] },
      { label:"A", teams:[{ teamId:"t0", pairs:[{seed:1}] }, { teamId:"t1", pairs:[{seed:5}] }] },
    ];
    expect(rankGroups(groups).map(g => g.label)).toEqual(["A","B"]);
  });

  test("ties broken by label", () => {
    const groups = [
      { label:"Z", teams:[{ teamId:"t0", pairs:[{seed:1}] }] },
      { label:"A", teams:[{ teamId:"t1", pairs:[{seed:1}] }] },
    ];
    expect(rankGroups(groups).map(g => g.label)).toEqual(["A","Z"]);
  });
});

describe("computeStageLabels — the core bug-fix regression tests", () => {
  test("flat 4-team bracket (no groups): round 1 = Elimination Round, round 2 = Final (never Semifinal)", () => {
    const teams = buildTeams(4, 5);
    const { teamMatchups } = generateTeamVsTeamBracket(teams, { makeId: idGen() });
    const labeled = computeStageLabels(teamMatchups, { isFlatFinal:true });
    expect(labeled.filter(m => m.round===1).every(m => m.stageLabel==="Elimination Round")).toBe(true);
    expect(labeled.find(m => m.round===2).stageLabel).toBe("Final");
  });

  test("flat 8-team bracket: Elimination Round -> Semifinal -> Final", () => {
    const teams = buildTeams(8, 5);
    const { teamMatchups } = generateTeamVsTeamBracket(teams, { makeId: idGen() });
    const labeled = computeStageLabels(teamMatchups, { isFlatFinal:true });
    expect(labeled.filter(m => m.round===1).every(m => m.stageLabel==="Elimination Round")).toBe(true);
    expect(labeled.filter(m => m.round===2).every(m => m.stageLabel==="Semifinal")).toBe(true);
    expect(labeled.find(m => m.round===3).stageLabel).toBe("Final");
  });

  test("flat 2-team bracket: the sole round is Final, not Elimination Round", () => {
    const teams = buildTeams(2, 5);
    const { teamMatchups } = generateTeamVsTeamBracket(teams, { makeId: idGen() });
    const labeled = computeStageLabels(teamMatchups, { isFlatFinal:true });
    expect(labeled.length).toBe(1);
    expect(labeled[0].stageLabel).toBe("Final");
  });

  test("bronze row is always Bronze Match regardless of round position", () => {
    const teams = buildTeams(4, 5);
    const { teamMatchups } = generateTeamVsTeamBracket(teams, { makeId: idGen(), bronzeMatch:true });
    const labeled = computeStageLabels(teamMatchups, { isFlatFinal:true });
    expect(labeled.find(m => m.bracketSide==="bronze").stageLabel).toBe("Bronze Match");
  });

  test("a group's own tier-1 rows (isFlatFinal:false): 1-round group is Elimination Round, not Semifinal", () => {
    const teams = buildTeams(2, 5);
    const { teamMatchups } = generateTeamVsTeamBracket(teams, { makeId: idGen() });
    const labeled = computeStageLabels(teamMatchups, { isFlatFinal:false });
    expect(labeled[0].stageLabel).toBe("Elimination Round");
  });

  test("a group's own tier-1 rows: 2-round group is Elimination Round -> Semifinal (its decider, not Final)", () => {
    const teams = buildTeams(4, 5);
    const { teamMatchups } = generateTeamVsTeamBracket(teams, { makeId: idGen() });
    const labeled = computeStageLabels(teamMatchups, { isFlatFinal:false });
    expect(labeled.filter(m => m.round===1).every(m => m.stageLabel==="Elimination Round")).toBe(true);
    expect(labeled.find(m => m.round===2).stageLabel).toBe("Semifinal");
  });
});

describe("generateGroupedTeamVsTeamBracket — 2 groups (worked examples from spec)", () => {
  test("4 teams / 2 groups of 2: each group's sole round = Elimination Round, merge Final wired directly, no Semifinal anywhere", () => {
    const teams = buildTeams(4, 5, ["Bracket A","Bracket B"]); // t0=A,t1=B,t2=A,t3=B
    const partition = partitionTeamsByBracketGroup(teams);
    expect(partition.grouped).toBe(true);
    const { teamMatchups, pairMatches } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen() });

    const deciders = teamMatchups.filter(m => m.bracketGroup);
    expect(deciders.length).toBe(2); // one match per group
    expect(deciders.every(m => m.stageLabel==="Elimination Round")).toBe(true);

    const final = teamMatchups.find(m => m.isFinal);
    expect(final).toBeTruthy();
    expect(final.stageLabel).toBe("Final");
    expect(final.teamAId).toBeNull(); // not known until group deciders complete
    expect(deciders.every(d => d.nextMatchupId === final.id)).toBe(true);
    expect(new Set(deciders.map(d => d.nextMatchupSlot))).toEqual(new Set(["A","B"]));
    expect(teamMatchups.some(m => m.stageLabel==="Semifinal")).toBe(false);

    // pair matches only exist for the 2 group-decider matchups (real teams known), not the still-TBD Final.
    expect(pairMatches.length).toBe(10); // 2 deciders x 5 pairs
  });

  test("8 teams / 2 groups of 4: Elimination Round -> Semifinal (group decider) -> Final", () => {
    const teams = buildTeams(8, 5, ["Bracket A","Bracket B"]);
    const partition = partitionTeamsByBracketGroup(teams);
    const { teamMatchups } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen() });

    const groupA = teamMatchups.filter(m => m.bracketGroup==="Bracket A");
    expect(groupA.filter(m => m.round===1).every(m => m.stageLabel==="Elimination Round")).toBe(true);
    expect(groupA.find(m => m.round===2).stageLabel).toBe("Semifinal");
    expect(teamMatchups.find(m => m.isFinal).stageLabel).toBe("Final");
  });

  test("bronze (2 groups) wires the two group deciders' losers, not any merge-tier row", () => {
    const teams = buildTeams(4, 5, ["Bracket A","Bracket B"]);
    const partition = partitionTeamsByBracketGroup(teams);
    const { teamMatchups } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen(), bronzeMatch:true });
    const bronze = teamMatchups.find(m => m.bracketSide==="bronze");
    expect(bronze).toBeTruthy();
    const deciders = teamMatchups.filter(m => m.bracketGroup);
    expect(deciders.every(d => d.loserNextMatchupId === bronze.id)).toBe(true);
  });
});

describe("generateGroupedTeamVsTeamBracket — 3+ groups, round-robin merge", () => {
  test("3 groups of 2: round-robin merge shells scheduled, tagged by group label, no Final/Bronze pre-generated", () => {
    const teams = buildTeams(6, 5, ["A","B","C"]);
    const partition = partitionTeamsByBracketGroup(teams);
    expect(partition.groups.length).toBe(3);
    const { teamMatchups } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen(), bronzeMatch:true });

    const mergeRows = teamMatchups.filter(m => m.mergeGroupA || m.mergeGroupB);
    expect(mergeRows.length).toBe(3); // A-B, A-C, B-C (round robin of 3)
    expect(mergeRows.every(m => m.stageLabel==="Champions Round Robin")).toBe(true);
    expect(mergeRows.every(m => m.teamAId===null && m.teamBId===null)).toBe(true);
    expect(teamMatchups.some(m => m.isFinal)).toBe(false);
    expect(teamMatchups.some(m => m.bracketSide==="bronze")).toBe(false);
  });

  test("4 groups of 2: round-robin merge has exactly one bye slot per round (odd... even group count -> no bye)", () => {
    const teams = buildTeams(8, 5, ["A","B","C","D"]);
    const partition = partitionTeamsByBracketGroup(teams);
    const { teamMatchups } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen() });
    const mergeRows = teamMatchups.filter(m => m.mergeGroupA || m.mergeGroupB);
    expect(mergeRows.length).toBe(6); // C(4,2) = 6 total round-robin matches among 4 groups
  });

  test("fillMergeGroupChampion patches every merge row referencing a decided group's slot", () => {
    const teams = buildTeams(6, 5, ["A","B","C"]);
    const partition = partitionTeamsByBracketGroup(teams);
    const { teamMatchups } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen() });
    const patches = fillMergeGroupChampion(teamMatchups, "A", "team0");
    expect(patches.length).toBe(2); // group A plays B and C once each
    for (const p of patches) expect(Object.values(p.patch)[0]).toBe("team0");
  });

  test("isMergeRoundRobinComplete: false with no merge rows, false with any pending, true once all completed", () => {
    const flatTeams = buildTeams(4, 5);
    const { teamMatchups: flat } = generateTeamVsTeamBracket(flatTeams, { makeId: idGen() });
    expect(isMergeRoundRobinComplete(flat)).toBe(false);

    const teams = buildTeams(6, 5, ["A","B","C"]);
    const partition = partitionTeamsByBracketGroup(teams);
    const { teamMatchups } = generateGroupedTeamVsTeamBracket(partition.groups, { makeId: idGen() });
    expect(isMergeRoundRobinComplete(teamMatchups)).toBe(false);
    const completed = teamMatchups.map(m => (m.mergeGroupA||m.mergeGroupB) ? { ...m, status:"completed", winnerTeamId:"team0" } : m);
    expect(isMergeRoundRobinComplete(completed)).toBe(true);
  });
});

describe("buildTeamStandings", () => {
  const teams = [
    { teamId:"A", pairs:[] }, { teamId:"B", pairs:[] }, { teamId:"C", pairs:[] }, { teamId:"D", pairs:[] },
  ];
  test("ranks by wins, then head-to-head, then pair-win margin", () => {
    const matchups = [
      { teamAId:"A", teamBId:"B", teamAWins:3, teamBWins:1, winnerTeamId:"A", status:"completed", mergeGroupA:"A", mergeGroupB:"B" },
      { teamAId:"A", teamBId:"C", teamAWins:3, teamBWins:2, winnerTeamId:"A", status:"completed", mergeGroupA:"A", mergeGroupB:"C" },
      { teamAId:"B", teamBId:"C", teamAWins:3, teamBWins:0, winnerTeamId:"B", status:"completed", mergeGroupA:"B", mergeGroupB:"C" },
      { teamAId:"B", teamBId:"D", teamAWins:3, teamBWins:1, winnerTeamId:"B", status:"completed", mergeGroupA:"B", mergeGroupB:"D" },
      { teamAId:"C", teamBId:"D", teamAWins:1, teamBWins:3, winnerTeamId:"D", status:"completed", mergeGroupA:"C", mergeGroupB:"D" },
      { teamAId:"A", teamBId:"D", teamAWins:3, teamBWins:0, winnerTeamId:"A", status:"completed", mergeGroupA:"A", mergeGroupB:"D" },
    ];
    const standings = buildTeamStandings(teams, matchups);
    expect(standings[0].teamId).toBe("A"); // 3 wins
    expect(standings.map(s => s.rank)).toEqual([1,2,3,4]);
  });
});

describe("generateMergeFinalAndBronze", () => {
  const teams = [
    { teamId:"A", pairs:[{id:"a1",seed:1}] }, { teamId:"B", pairs:[{id:"b1",seed:2}] },
    { teamId:"C", pairs:[{id:"c1",seed:3}] }, { teamId:"D", pairs:[{id:"d1",seed:4}] },
  ];
  const standings4 = [
    { teamId:"A", rank:1 }, { teamId:"B", rank:2 }, { teamId:"C", rank:3 }, { teamId:"D", rank:4 },
  ];
  const standings3 = standings4.slice(0,3);

  test("G==4 standings: Final = #1 vs #2, Bronze = #3 vs #4", () => {
    const { teamMatchups } = generateMergeFinalAndBronze(standings4, teams, { makeId: idGen(), bronzeMatch:true });
    const final = teamMatchups.find(m => m.isFinal);
    expect(final.teamAId).toBe("A"); expect(final.teamBId).toBe("B");
    const bronze = teamMatchups.find(m => m.bracketSide==="bronze");
    expect(bronze.teamAId).toBe("C"); expect(bronze.teamBId).toBe("D");
  });

  test("G==3 standings: Final only, no Bronze (no real 4th place)", () => {
    const { teamMatchups } = generateMergeFinalAndBronze(standings3, teams, { makeId: idGen(), bronzeMatch:true });
    expect(teamMatchups.length).toBe(1);
    expect(teamMatchups[0].isFinal).toBe(true);
    expect(teamMatchups.some(m => m.bracketSide==="bronze")).toBe(false);
  });

  test("pair matches are generated for the dynamically-created Final", () => {
    const { pairMatches } = generateMergeFinalAndBronze(standings4, teams, { makeId: idGen(), bronzeMatch:true });
    expect(pairMatches.length).toBeGreaterThan(0);
    expect(pairMatches.every(pm => pm.teamMatchupId)).toBe(true);
  });
});
