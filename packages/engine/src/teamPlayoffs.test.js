import { describe, test, expect } from "vitest";
import { podSizeForPolicy, placeQualifiersWithPolicy, selectQualifiers, generateQualifierBracketShell, hasKnockoutStageStarted } from "./teamPlayoffs.js";
import { advanceIndividualMatchup, advanceBronzeIndividualMatchup } from "./teamVsTeam.js";

const idGen = () => { let i = 0; return () => "id" + (i++); };
const q = (registrationId, teamId) => ({ registrationId, teamId });

describe("podSizeForPolicy", () => {
  test("allow_anywhere / never -> 0 (no avoidance)", () => {
    expect(podSizeForPolicy("allow_anywhere", 8)).toBe(0);
    expect(podSizeForPolicy("never", 8)).toBe(0);
    expect(podSizeForPolicy(undefined, 8)).toBe(0);
  });
  test("avoid_quarterfinals=2, avoid_semis=4, avoid_until_final=size/2 at size 16", () => {
    expect(podSizeForPolicy("avoid_quarterfinals", 16)).toBe(2);
    expect(podSizeForPolicy("avoid_semis", 16)).toBe(4);
    expect(podSizeForPolicy("avoid_until_final", 16)).toBe(8);
  });
  test("clamped to size/2 so no policy can ever forbid a same-Team Final — all three avoidance levels collapse to 2 at size 4", () => {
    expect(podSizeForPolicy("avoid_quarterfinals", 4)).toBe(2);
    expect(podSizeForPolicy("avoid_semis", 4)).toBe(2);
    expect(podSizeForPolicy("avoid_until_final", 4)).toBe(2);
  });
});

describe("placeQualifiersWithPolicy", () => {
  test("allow_anywhere: pure pass-through of seedOrder, no conflict detection performed", () => {
    const qualifiers = [q("s1","A"), q("s2","A"), q("s3","A"), q("s4","A")];
    const { order, conflicts } = placeQualifiersWithPolicy(qualifiers, "allow_anywhere");
    expect(conflicts).toEqual([]);
    expect(order.map(o => o?.registrationId)).toEqual(["s1","s4","s2","s3"]);
  });

  test("avoid_quarterfinals: a same-Team pair seeded into the same round-1 pod gets separated, minimal displacement, zero conflicts left", () => {
    const qualifiers = [
      q("s1","X"), q("s2","T2"), q("s3","T3"), q("s4","T4"),
      q("s5","T5"), q("s6","T6"), q("s7","T7"), q("s8","X"),
    ];
    const { order, conflicts, size } = placeQualifiersWithPolicy(qualifiers, "avoid_quarterfinals");
    expect(size).toBe(8);
    expect(conflicts).toEqual([]);
    for (let podStart = 0; podStart < 8; podStart += 2){
      const teams = [order[podStart]?.teamId, order[podStart+1]?.teamId].filter(Boolean);
      expect(new Set(teams).size).toBe(teams.length);
    }
  });

  test("deterministic: repeated calls with the same input produce identical placement", () => {
    const qualifiers = [q("s1","X"), q("s2","T2"), q("s3","T3"), q("s4","T4"), q("s5","T5"), q("s6","T6"), q("s7","T7"), q("s8","X")];
    const a = placeQualifiersWithPolicy(qualifiers, "avoid_quarterfinals");
    const b = placeQualifiersWithPolicy(qualifiers, "avoid_quarterfinals");
    expect(a.order.map(o => o?.registrationId)).toEqual(b.order.map(o => o?.registrationId));
  });

  test("impossibility case: every qualifier on one Team under the strongest policy -> returns synchronously with unresolved conflicts, no crash", () => {
    const qualifiers = Array.from({ length: 8 }, (_, i) => q("s"+(i+1), "onlyTeam"));
    const { order, conflicts, size } = placeQualifiersWithPolicy(qualifiers, "avoid_until_final");
    expect(size).toBe(8);
    expect(order.every(o => o != null)).toBe(true);
    expect(conflicts.length).toBeGreaterThan(0);
  });

  test("BYE (phantom) slots never count as a conflict", () => {
    const qualifiers = [q("s1","X"), q("s2","X"), q("s3","Y")];
    const { order, conflicts, size } = placeQualifiersWithPolicy(qualifiers, "avoid_quarterfinals");
    expect(size).toBe(4);
    expect(order.filter(o => o == null).length).toBe(1);
    expect(Array.isArray(conflicts)).toBe(true);
  });
});

describe("selectQualifiers", () => {
  const ranked = [q("r1","A"), q("r2","B"), q("r3","A"), q("r4","A"), q("r5","B"), q("r6","C")];

  test("top_x (Top 4 Overall): exactly the first 4, ignoring Team", () => {
    expect(selectQualifiers(ranked, "top_x", 4).map(p => p.registrationId)).toEqual(["r1","r2","r3","r4"]);
  });

  test("top_x honors qualifierCount instead of always slicing 4", () => {
    expect(selectQualifiers(ranked, "top_x", 2).map(p => p.registrationId)).toEqual(["r1","r2"]);
    expect(selectQualifiers(ranked, "top_x", 6).map(p => p.registrationId)).toEqual(["r1","r2","r3","r4","r5","r6"]);
  });

  test("top_x_per_team: keeps the first `count` per Team, preserves ORIGINAL overall-rank order (never re-sorted by Team)", () => {
    const result = selectQualifiers(ranked, "top_x_per_team", 2);
    expect(result.map(p => p.registrationId)).toEqual(["r1","r2","r3","r5","r6"]);
  });

  test("manual: returns [] — caller filters `ranked` by its own selected id list instead", () => {
    expect(selectQualifiers(ranked, "manual", 4)).toEqual([]);
  });
});

describe("generateQualifierBracketShell", () => {
  test("M=2: straight to a Final, both competitors already known, no Semifinal/Bronze", () => {
    const qualifiers = [q("p1","A"), q("p2","B")];
    const { teamMatchups, pairMatches, conflicts } = generateQualifierBracketShell(qualifiers, { makeId: idGen() });
    expect(teamMatchups).toHaveLength(1);
    expect(teamMatchups[0].stage).toBe("final");
    expect(teamMatchups[0].pairAId).toBe("p1"); expect(teamMatchups[0].pairBId).toBe("p2");
    expect(pairMatches).toHaveLength(1);
    expect(pairMatches[0]).toEqual(expect.objectContaining({ registrationAId:"p1", registrationBId:"p2", status:"scheduled" }));
    expect(conflicts).toEqual([]);
  });

  test("M=4: parity with the original fixed-4 shape — SF1=seed1v4, SF2=seed2v3, wired to Final/Bronze", () => {
    const qualifiers = [q("p1","tA"), q("p2","tB"), q("p3","tA"), q("p4","tB")];
    const { teamMatchups, pairMatches } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), startRound: 5 });

    const sf1 = teamMatchups.find(m => m.stage==="semifinal" && m.bracketPosition===0);
    const sf2 = teamMatchups.find(m => m.stage==="semifinal" && m.bracketPosition===1);
    expect(sf1.round).toBe(5); expect(sf1.stageLabel).toBe("Semifinal");
    expect(sf1.pairAId).toBe("p1"); expect(sf1.pairBId).toBe("p4");
    expect(sf2.pairAId).toBe("p2"); expect(sf2.pairBId).toBe("p3");
    expect(sf1.pairsPerMatchup).toBe(1);

    const final = teamMatchups.find(m => m.stage==="final");
    const bronze = teamMatchups.find(m => m.stage==="bronze");
    expect(final.round).toBe(6); expect(final.stageLabel).toBe("Final");
    expect(bronze.stageLabel).toBe("Bronze Match"); expect(bronze.bracketSide).toBe("bronze");
    expect(sf1.nextMatchupId).toBe(final.id); expect(sf2.nextMatchupId).toBe(final.id);
    expect(sf1.loserNextMatchupId).toBe(bronze.id); expect(sf2.loserNextMatchupId).toBe(bronze.id);
    expect(final.pairAId).toBeNull(); expect(bronze.pairAId).toBeNull();

    expect(pairMatches).toHaveLength(2);
    expect(pairMatches.filter(pm => pm.teamMatchupId===sf1.id)).toEqual([
      expect.objectContaining({ registrationAId:"p1", registrationBId:"p4", pairSlot:1, status:"scheduled" }),
    ]);
  });

  test("avoid_semis repairs 1v4/2v3 so two Team A pairs are not in the same semifinal", () => {
    const qualifiers = [q("A1","tA"), q("B1","tB"), q("B2","tB"), q("A2","tA")];
    const raw = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "allow_anywhere" });
    const rawSf = raw.teamMatchups.filter(m => m.stage === "semifinal");
    const rawSameTeam = rawSf.some(m => m.teamAId && m.teamAId === m.teamBId);
    expect(rawSameTeam).toBe(true);

    const { teamMatchups } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "avoid_semis" });
    const sfs = teamMatchups.filter(m => m.stage === "semifinal");
    expect(sfs).toHaveLength(2);
    for (const m of sfs) {
      expect(m.teamAId).not.toBe(m.teamBId);
    }
    const final = teamMatchups.find(m => m.stage === "final");
    expect(final).toBeTruthy();
  });

  test("M=8: Quarterfinal -> Semifinal -> Bronze/Final, correct stage labels and round count", () => {
    const qualifiers = Array.from({ length: 8 }, (_, i) => q("p"+(i+1), "t"+(i%4)));
    const { teamMatchups } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), startRound: 3 });
    const qfRows = teamMatchups.filter(m => m.stage==="knockout");
    const sfRows = teamMatchups.filter(m => m.stage==="semifinal");
    expect(qfRows).toHaveLength(4); expect(qfRows.every(m => m.stageLabel==="Quarterfinal" && m.round===3)).toBe(true);
    expect(sfRows).toHaveLength(2); expect(sfRows.every(m => m.stageLabel==="Semifinal" && m.round===4)).toBe(true);
    expect(teamMatchups.find(m => m.stage==="final").round).toBe(5);
    expect(teamMatchups.find(m => m.stage==="bronze")).toBeTruthy();
  });

  test("M=16: three pre-final rounds, labeled Round of 16 / Quarterfinal / Semifinal", () => {
    const qualifiers = Array.from({ length: 16 }, (_, i) => q("p"+(i+1), "t"+(i%8)));
    const { teamMatchups } = generateQualifierBracketShell(qualifiers, { makeId: idGen() });
    const byRound = new Map();
    for (const m of teamMatchups.filter(m => m.stage==="knockout" || m.stage==="semifinal")){
      if (!byRound.has(m.round)) byRound.set(m.round, []);
      byRound.get(m.round).push(m);
    }
    const rounds = [...byRound.keys()].sort((a,b) => a-b);
    expect(rounds).toHaveLength(3);
    expect(byRound.get(rounds[0])).toHaveLength(8); expect(byRound.get(rounds[0])[0].stageLabel).toBe("Round of 16");
    expect(byRound.get(rounds[1])).toHaveLength(4); expect(byRound.get(rounds[1])[0].stageLabel).toBe("Quarterfinal");
    expect(byRound.get(rounds[2])).toHaveLength(2); expect(byRound.get(rounds[2])[0].stageLabel).toBe("Semifinal");
    expect(teamMatchups).toHaveLength(8+4+2+1+1);
  });

  test("M=12 (non-power-of-2): pads to 16 with deterministic BYEs, Bronze wired only off the true Semifinal round", () => {
    const qualifiers = Array.from({ length: 12 }, (_, i) => q("p"+(i+1), "t"+(i%6)));
    const { teamMatchups, pairMatches } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), startRound: 1 });
    const round1 = teamMatchups.filter(m => m.round===1);
    expect(round1).toHaveLength(8);
    const byes = round1.filter(m => m.status==="bye");
    expect(byes.length).toBe(16-12);
    for (const bye of byes){
      expect(bye.winnerTeamId).toBeTruthy();
      expect(bye.pairAId || bye.pairBId).toBeTruthy();
    }
    const seatedIds = round1.flatMap(m => [m.pairAId, m.pairBId]).filter(Boolean);
    expect(new Set(seatedIds).size).toBe(12);
    const semis = teamMatchups.filter(m => m.stage==="semifinal");
    const bronze = teamMatchups.find(m => m.stage==="bronze");
    expect(semis.every(m => m.loserNextMatchupId===bronze.id)).toBe(true);
    expect(teamMatchups.filter(m => m.stage==="knockout").every(m => !m.loserNextMatchupId)).toBe(true);
    expect(pairMatches.filter(pm => round1.some(m => m.id===pm.teamMatchupId))).toHaveLength(8-byes.length);
  });

  test("M<2 returns empty shells", () => {
    expect(generateQualifierBracketShell([q("p1","A")], { makeId: idGen() })).toEqual({ teamMatchups:[], pairMatches:[], conflicts:[] });
    expect(generateQualifierBracketShell([], { makeId: idGen() })).toEqual({ teamMatchups:[], pairMatches:[], conflicts:[] });
  });
});

describe("same-Team Final behavior — the engine never overrides actual results", () => {
  const qualifiers = [q("A1","tA"), q("B1","tB"), q("A2","tA"), q("B2","tB")];

  function buildAndSimulate(sf1Winner, sf1WinnerTeam, sf1Loser, sf1LoserTeam, sf2Winner, sf2WinnerTeam, sf2Loser, sf2LoserTeam){
    const { teamMatchups } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "avoid_until_final" });
    const sf1 = teamMatchups.find(m => m.stage==="semifinal" && m.bracketPosition===0);
    const sf2 = teamMatchups.find(m => m.stage==="semifinal" && m.bracketPosition===1);
    expect(new Set([sf1.pairAId, sf1.pairBId])).toEqual(new Set(["A1","B2"]));
    expect(new Set([sf2.pairAId, sf2.pairBId])).toEqual(new Set(["B1","A2"]));

    let matchups = teamMatchups;
    const apply = patch => { if (patch) matchups = matchups.map(m => m.id===patch.matchupId ? { ...m, ...patch.patch } : m); };
    apply(advanceIndividualMatchup(matchups, sf1.id, sf1Winner, sf1WinnerTeam));
    apply(advanceBronzeIndividualMatchup(matchups, sf1.id, sf1Loser, sf1LoserTeam));
    apply(advanceIndividualMatchup(matchups, sf2.id, sf2Winner, sf2WinnerTeam));
    apply(advanceBronzeIndividualMatchup(matchups, sf2.id, sf2Loser, sf2LoserTeam));
    return matchups;
  }

  test("Test 48: SF winners naturally share a Team -> Final is same-Team, and that's allowed", () => {
    const matchups = buildAndSimulate("A1","tA","B2","tB", "A2","tA","B1","tB");
    const final = matchups.find(m => m.stage==="final");
    expect(new Set([final.pairAId, final.pairBId])).toEqual(new Set(["A1","A2"]));
    expect(final.teamAId).toBe("tA"); expect(final.teamBId).toBe("tA");
  });

  test("Test 49: SF winners naturally come from different Teams -> Final is cross-Team", () => {
    const matchups = buildAndSimulate("A1","tA","B2","tB", "B1","tB","A2","tA");
    const final = matchups.find(m => m.stage==="final");
    expect(new Set([final.pairAId, final.pairBId])).toEqual(new Set(["A1","B1"]));
  });
});

describe("hasKnockoutStageStarted", () => {
  test("false when every knockout-stage matchup is still scheduled with no started child matches", () => {
    const teamMatchups = [{ id:"m1", stage:"round_robin", status:"completed" }, { id:"sf1", stage:"semifinal", status:"scheduled" }];
    const matches = [{ teamMatchupId:"sf1", status:"scheduled" }];
    expect(hasKnockoutStageStarted(teamMatchups, matches)).toBe(false);
  });
  test("true once a knockout-stage matchup itself is decided (e.g. a BYE)", () => {
    const teamMatchups = [{ id:"qf1", stage:"knockout", status:"bye" }];
    expect(hasKnockoutStageStarted(teamMatchups, [])).toBe(true);
  });
  test("true once any child match under a knockout-stage matchup has started or completed", () => {
    const teamMatchups = [{ id:"sf1", stage:"semifinal", status:"scheduled" }];
    expect(hasKnockoutStageStarted(teamMatchups, [{ teamMatchupId:"sf1", status:"in_progress" }])).toBe(true);
    expect(hasKnockoutStageStarted(teamMatchups, [{ teamMatchupId:"sf1", status:"completed" }])).toBe(true);
  });
});
