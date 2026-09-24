import { describe, test, expect } from "vitest";
import { podSizeForPolicy, placeQualifiersWithPolicy, selectQualifiers, generateQualifierBracketShell, hasKnockoutStageStarted, expectedQualifierCount, findCutoffTies } from "./teamPlayoffs.js";
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

  test("M=4 invariant: exactly 2 semifinal + 1 final + 1 bronze shells, zero intermediate knockout-stage matches (Direct Semifinals relies on this)", () => {
    const qualifiers = [q("p1","tA"), q("p2","tB"), q("p3","tC"), q("p4","tD")];
    const { teamMatchups } = generateQualifierBracketShell(qualifiers, { makeId: idGen() });
    expect(teamMatchups).toHaveLength(4);
    expect(teamMatchups.filter(m => m.stage === "semifinal")).toHaveLength(2);
    expect(teamMatchups.filter(m => m.stage === "final")).toHaveLength(1);
    expect(teamMatchups.filter(m => m.stage === "bronze")).toHaveLength(1);
    expect(teamMatchups.filter(m => m.stage === "knockout")).toHaveLength(0);
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

// Screenshot regression: 2 teams (NEXTG, ONSE) x 5 pairs, round robin complete.
// Rows are in rankIndividualPairsForSemifinals order (W -> L -> +/- -> PF).
describe("qualification: top X per team (screenshot scenario)", () => {
  const row = (registrationId, teamId, wins, losses, pointDiff, pointsFor) => ({ registrationId, teamId, wins, losses, pointDiff, pointsFor });
  const ranked = (jeffreyPF, gracePF) => [
    row("KENNETH/JENNY", "NEXTG", 4, 0, 15, 44),
    row("CARL/LOY G", "ONSE", 3, 1, 8, 41),
    ...(jeffreyPF >= gracePF
      ? [row("JEFFREY/REM", "NEXTG", 3, 1, 2, jeffreyPF), row("GRACE/REIN", "NEXTG", 3, 1, 2, gracePF)]
      : [row("GRACE/REIN", "NEXTG", 3, 1, 2, gracePF), row("JEFFREY/REM", "NEXTG", 3, 1, 2, jeffreyPF)]),
    row("AKI/MAE MAE", "ONSE", 3, 1, 0, 38),
    row("ADO/MAMEN", "NEXTG", 2, 2, 0, 36),
    row("KEISHA/RONA", "NEXTG", 1, 3, -6, 30),
    row("DEVAN/KEMP", "ONSE", 1, 3, -7, 29),
    row("JOSHUA C./SANDRA", "ONSE", 0, 4, -7, 33),
    row("ALIE/JEROME", "ONSE", 0, 4, -7, 32),
  ];
  const byTeam = (qs) => qs.reduce((m, p) => ({ ...m, [p.teamId]: (m[p.teamId] || 0) + 1 }), {});

  test("2 per team x 2 teams -> exactly 4: NEXTG 2, ONSE 2, top two of each team, no duplicates", () => {
    const qs = selectQualifiers(ranked(40, 39), "top_x_per_team", 2);
    expect(qs.map(p => p.registrationId)).toEqual(["KENNETH/JENNY", "CARL/LOY G", "JEFFREY/REM", "AKI/MAE MAE"]);
    expect(byTeam(qs)).toEqual({ NEXTG: 2, ONSE: 2 });
    expect(new Set(qs.map(p => p.registrationId)).size).toBe(4);
    expect(qs.find(p => p.registrationId === "AKI/MAE MAE").teamId).toBe("ONSE");
    expect(qs.length).toBe(expectedQualifierCount("top_x_per_team", 2, 2));
  });

  test("global top 4 is NOT what per-team uses (it would take GRACE/REIN and drop AKI/MAE MAE)", () => {
    const globalTop4 = selectQualifiers(ranked(40, 39), "top_x", 4).map(p => p.registrationId);
    expect(globalTop4).toContain("GRACE/REIN");
    expect(globalTop4).not.toContain("AKI/MAE MAE");
    expect(selectQualifiers(ranked(40, 39), "top_x_per_team", 2).map(p => p.registrationId)).not.toContain("GRACE/REIN");
  });

  test("the old stored count (4 per team) is what produced 8", () => {
    const qs = selectQualifiers(ranked(40, 39), "top_x_per_team", 4);
    expect(qs).toHaveLength(8);
    expect(expectedQualifierCount("top_x_per_team", 4, 2)).toBe(8);
  });

  test("JEFFREY/REM vs GRACE/REIN (3W +2): Points For decides when it differs, and no cutoff tie is reported", () => {
    const qs = selectQualifiers(ranked(38, 40), "top_x_per_team", 2);
    expect(qs.map(p => p.registrationId)).toContain("GRACE/REIN");
    expect(findCutoffTies(ranked(38, 40), qs, "top_x_per_team")).toEqual([]);
  });

  test("equal on W, L, +/- and PF -> cutoff tie is reported for that team only", () => {
    const r = ranked(40, 40);
    const qs = selectQualifiers(r, "top_x_per_team", 2);
    expect(findCutoffTies(r, qs, "top_x_per_team")).toEqual([
      { teamId: "NEXTG", qualified: "JEFFREY/REM", excluded: "GRACE/REIN" },
    ]);
  });
});

describe("expectedQualifierCount — derived from mode, never a fixed 4", () => {
  test("per team: teams x per-team", () => {
    expect(expectedQualifierCount("top_x_per_team", 2, 2)).toBe(4);
    expect(expectedQualifierCount("top_x_per_team", 2, 3)).toBe(6);
    expect(expectedQualifierCount("top_x_per_team", 3, 2)).toBe(6);
  });
  test("overall: the count itself; manual: null", () => {
    expect(expectedQualifierCount("top_x", 4, 5)).toBe(4);
    expect(expectedQualifierCount("manual", 4, 2)).toBeNull();
  });
});

// ---- Qualification -> Semifinals regression suite (per-team only) ----
import { rankIndividualPairsForSemifinals } from "./teamRoundRobin.js";

// Builds teams + completed round-robin pair matches from a per-pair list of
// [wins, losses, pointsFor, pointsAgainst] records against a dummy opponent
// pool, so ranking runs through the real engine function.
function scenario(spec){
  const teams = Object.entries(spec).map(([teamId, pairs]) => ({
    teamId, teamName: teamId, pairs: pairs.map((_, i) => ({ id: `${teamId}${i+1}`, teamId })),
  }));
  teams.push({ teamId: "_OPP", teamName: "_OPP", pairs: [{ id: "_opp" }] });
  const pairMatches = [];
  let n = 0;
  for (const [teamId, pairs] of Object.entries(spec)){
    pairs.forEach(([w, l, pf, pa], i) => {
      const id = `${teamId}${i+1}`;
      const games = w + l;
      for (let g = 0; g < games; g++){
        const won = g < w;
        // Spread PF/PA across games; the last game absorbs rounding.
        const last = g === games - 1;
        const a = last ? pf - Math.floor(pf / games) * (games - 1) : Math.floor(pf / games);
        const b = last ? pa - Math.floor(pa / games) * (games - 1) : Math.floor(pa / games);
        pairMatches.push({ id: "m" + (n++), teamMatchupId: "rr", status: "completed", registrationAId: id, registrationBId: "_opp", winner: won ? "A" : "B", score: { scoreA: a, scoreB: b } });
      }
    });
  }
  const ranked = rankIndividualPairsForSemifinals(teams, [{ id: "rr", stage: "round_robin" }], pairMatches).filter(r => r.teamId !== "_OPP");
  return ranked;
}
const ids = qs => qs.map(q => q.registrationId);
const perTeam = qs => qs.reduce((m, q) => ({ ...m, [q.teamId]: (m[q.teamId] || 0) + 1 }), {});

describe("per-team qualification (server always uses top_x_per_team for team elimination)", () => {
  test("1. 2 teams x 5 pairs, 2 per team: A1+A2 and B1+B2 by wins, 4 total, no 3rd-placed pair", () => {
    const ranked = scenario({
      A: [[4,0,44,29], [1,3,30,40], [3,1,40,35], [2,2,36,36], [0,4,20,44]],
      B: [[3,1,41,33], [0,4,25,44], [2,2,38,38], [3,1,39,37], [1,3,30,40]],
    });
    const qs = selectQualifiers(ranked, "top_x_per_team", 2);
    expect(perTeam(qs)).toEqual({ A: 2, B: 2 });
    expect(qs).toHaveLength(4);
    expect(new Set(ids(qs))).toEqual(new Set(["A1", "A3", "B1", "B4"]));
    expect(ids(qs)).not.toContain("A4"); // A's 3rd-placed pair
    expect(ids(qs)).not.toContain("B3"); // B's 3rd-placed pair
  });

  test("2. different team sizes (3 vs 7), 2 per team -> exactly 2 from each", () => {
    const ranked = scenario({
      A: [[1,2,30,33], [2,1,33,30], [0,3,20,33]],
      B: [[6,0,66,30], [5,1,60,40], [4,2,55,45], [3,3,50,50], [2,4,45,55], [1,5,40,60], [0,6,30,66]],
    });
    const qs = selectQualifiers(ranked, "top_x_per_team", 2);
    expect(perTeam(qs)).toEqual({ A: 2, B: 2 });
    expect(new Set(ids(qs))).toEqual(new Set(["A2", "A1", "B1", "B2"]));
  });

  test("3. qualifierCount = 1 -> exactly 1 per team", () => {
    const ranked = scenario({ A: [[2,1,30,25], [3,0,33,20], [1,2,25,30]], B: [[0,3,20,33], [1,2,25,30], [2,1,30,25]] });
    const qs = selectQualifiers(ranked, "top_x_per_team", 1);
    expect(perTeam(qs)).toEqual({ A: 1, B: 1 });
    expect(new Set(ids(qs))).toEqual(new Set(["A2", "B3"]));
  });

  test("4. qualifierCount = 3 -> exactly 3 per team when enough pairs exist", () => {
    const ranked = scenario({
      A: [[4,0,44,20], [3,1,40,30], [2,2,35,35], [1,3,30,40], [0,4,20,44]],
      B: [[0,4,20,44], [1,3,30,40], [2,2,35,35], [3,1,40,30], [4,0,44,20]],
    });
    const qs = selectQualifiers(ranked, "top_x_per_team", 3);
    expect(perTeam(qs)).toEqual({ A: 3, B: 3 });
    expect(new Set(ids(qs))).toEqual(new Set(["A1", "A2", "A3", "B5", "B4", "B3"]));
    expect(expectedQualifierCount("top_x_per_team", 3, 2)).toBe(6);
  });

  test("5. wins tie -> +/- decides; +/- tie too -> Points For decides (existing official order)", () => {
    const byDiff = scenario({ A: [[3,1,40,38], [3,1,42,35], [0,4,10,44]], B: [[1,3,1,1]] });
    expect(ids(selectQualifiers(byDiff, "top_x_per_team", 1))).toContain("A2"); // +7 beats +2
    const byPF = scenario({ A: [[3,1,40,38], [3,1,44,42], [0,4,10,44]], B: [[1,3,1,1]] });
    const q = selectQualifiers(byPF, "top_x_per_team", 1);
    expect(ids(q)).toContain("A2"); // both +2, PF 44 beats 40
    expect(findCutoffTies(byPF, q, "top_x_per_team")).toEqual([]);
  });
});

describe("qualified pairs -> semifinals (Direct Semifinals, 2 teams x 2)", () => {
  // Every possible overall-rank order of two A and two B qualifiers.
  const orders = ["AABB", "ABAB", "ABBA", "BAAB", "BABA", "BBAA"];
  const build = pattern => {
    const n = { A: 0, B: 0 };
    return pattern.split("").map(t => q(`${t}${++n[t]}`, t));
  };
  const semis = shell => shell.teamMatchups.filter(m => m.stage === "semifinal");

  test.each(orders)("6. avoid_semis, rank order %s: both semifinals are cross-team", pattern => {
    const qualifiers = build(pattern);
    const shell = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "avoid_semis" });
    expect(shell.conflicts).toEqual([]);
    const sf = semis(shell);
    expect(sf).toHaveLength(2);
    for (const m of sf) expect(m.teamAId).not.toBe(m.teamBId);
  });

  test.each(orders)("7-8. rank order %s: semifinal participants are exactly the qualified set, once each", pattern => {
    const qualifiers = build(pattern);
    const shell = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "avoid_semis" });
    const placed = semis(shell).flatMap(m => [m.pairAId, m.pairBId]);
    expect(placed.slice().sort()).toEqual(ids(qualifiers).sort());
    expect(new Set(placed).size).toBe(4);
    // Pair child matches exist only for the semifinals; the final and bronze wait for results.
    expect(shell.pairMatches).toHaveLength(2);
    const final = shell.teamMatchups.find(m => m.stage === "final");
    const bronze = shell.teamMatchups.find(m => m.stage === "bronze");
    expect([final.pairAId, final.pairBId, bronze.pairAId, bronze.pairBId]).toEqual([null, null, null, null]);
  });

  test("allow_anywhere keeps plain seeding, so a same-team semifinal is possible (policy is what prevents it)", () => {
    const shell = generateQualifierBracketShell(build("ABBA"), { makeId: idGen(), sameTeamPolicy: "allow_anywhere" });
    expect(semis(shell).some(m => m.teamAId === m.teamBId)).toBe(true);
  });
});
