import { describe, test, expect } from "vitest";
import { seedOrder, generateBracket, advanceBracket, advanceBronzeMatchSlot, generateTop4PlayoffShell, computeSemifinalFillPatches } from "./tournamentBracket.js";

const regs = n => Array.from({ length: n }, (_, i) => ({ id: "r" + (i + 1) }));
const idGen = () => { let i = 0; return () => "m" + (i++); };

describe("seedOrder — standard mirror-seed sequence", () => {
  test("size 2", () => expect(seedOrder(2)).toEqual([1, 2]));
  test("size 4", () => expect(seedOrder(4)).toEqual([1, 4, 2, 3]));
  test("size 8", () => expect(seedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]));
  test("size 16", () => expect(seedOrder(16)).toEqual([1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]));

  test("size 32 is a valid permutation of 1..32 (top seeds never meet early)", () => {
    const order = seedOrder(32);
    expect(order.length).toBe(32);
    expect(new Set(order).size).toBe(32);
    expect(Math.min(...order)).toBe(1);
    expect(Math.max(...order)).toBe(32);
    // Round-1 pairing: seed 1 and seed 2 (the top two) must land in different halves
    // of the bracket, i.e. never paired against each other in round 1.
    const round1Pairs = Array.from({ length: 16 }, (_, i) => [order[i * 2], order[i * 2 + 1]]);
    expect(round1Pairs.some(([a, b]) => (a === 1 && b === 2) || (a === 2 && b === 1))).toBe(false);
  });
});

describe("generateBracket — bronze match wiring", () => {
  test("N=4 with bronzeMatch:true wires exactly one bronze match from the two semifinal losers", () => {
    const matches = generateBracket(regs(4), { makeId: idGen(), bronzeMatch: true });
    const bronze = matches.filter(m => m.bracketSide === "bronze");
    expect(bronze.length).toBe(1);

    const semis = matches.filter(m => m.round === 1);
    expect(semis.length).toBe(2);
    for (const s of semis) {
      expect(s.loserNextMatchId).toBe(bronze[0].id);
    }
    expect(new Set(semis.map(s => s.loserNextMatchSlot))).toEqual(new Set(["A", "B"]));
  });

  test("bronzeMatch:false (or omitted) never creates a bronze match", () => {
    const matches = generateBracket(regs(4), { makeId: idGen() });
    expect(matches.some(m => m.bracketSide === "bronze")).toBe(false);
  });

  test("N=4 round-1 is exactly seed1-vs-seed4 and seed2-vs-seed3", () => {
    const registrations = regs(4);
    const matches = generateBracket(registrations, { makeId: idGen() });
    const round1 = matches.filter(m => m.round === 1);
    const pairKey = m => [m.registrationAId, m.registrationBId].sort().join("|");
    expect(new Set(round1.map(pairKey))).toEqual(new Set([
      [registrations[0].id, registrations[3].id].sort().join("|"),
      [registrations[1].id, registrations[2].id].sort().join("|"),
    ]));
  });
});

describe("generateBracket — non-power-of-2 phantom-bye resolution", () => {
  for (const n of [5, 6, 7, 10]) {
    test(`N=${n}: round 1 has exactly the right number of byes, correct round count`, () => {
      const matches = generateBracket(regs(n), { makeId: idGen() });
      let size = 1; while (size < n) size *= 2;
      const expectedByes = size - n;
      const round1 = matches.filter(m => m.round === 1);
      expect(round1.filter(m => m.status === "bye").length).toBe(expectedByes);
      const totalRounds = Math.max(...matches.filter(m => m.bracketSide !== "bronze").map(m => m.round));
      expect(totalRounds).toBe(Math.log2(size));
    });
  }
});

describe("advanceBracket / advanceBronzeMatchSlot — pure patch generation", () => {
  test("advanceBracket fills the winner into the next match's correct slot", () => {
    const registrations = regs(4);
    const matches = generateBracket(registrations, { makeId: idGen() });
    const firstSemi = matches.find(m => m.round === 1);
    const patch = advanceBracket(matches, firstSemi.id, registrations[0].id);
    expect(patch.matchId).toBe(firstSemi.nextMatchId);
    expect(Object.values(patch.patch)).toContain(registrations[0].id);
  });

  test("advanceBracket returns null for the true final (no nextMatchId)", () => {
    const registrations = regs(2);
    const matches = generateBracket(registrations, { makeId: idGen() });
    const final = matches[0]; // N=2: single match IS the final
    expect(advanceBracket(matches, final.id, registrations[0].id)).toBeNull();
  });

  test("advanceBronzeMatchSlot fills both semifinal losers into the bronze match", () => {
    const registrations = regs(4);
    const matches = generateBracket(registrations, { makeId: idGen(), bronzeMatch: true });
    const semis = matches.filter(m => m.round === 1);
    const bronzeId = semis[0].loserNextMatchId;

    const p1 = advanceBronzeMatchSlot(matches, semis[0].id, "loser_of_semi_1");
    expect(p1.matchId).toBe(bronzeId);
    const p2 = advanceBronzeMatchSlot(matches, semis[1].id, "loser_of_semi_2");
    expect(p2.matchId).toBe(bronzeId);
    // Different slots (A vs B), so both losers land in the bronze match without collision.
    expect(Object.keys(p1.patch)[0]).not.toBe(Object.keys(p2.patch)[0]);
  });
});

describe("generateTop4PlayoffShell — Round Robin + Top 4 Playoffs shell wiring", () => {
  test("produces exactly 2 Semifinal + 1 Final + 1 Bronze, all fully TBD", () => {
    const shells = generateTop4PlayoffShell({ makeId: idGen() });
    expect(shells.length).toBe(4);
    for (const m of shells) {
      expect(m.registrationAId).toBeNull();
      expect(m.registrationBId).toBeNull();
      expect(m.status).not.toBe("bye"); // placeholder slots must never be mistaken for a bye
    }
    expect(shells.filter(m => m.bracketSide === "winners").length).toBe(2);
    expect(shells.filter(m => m.bracketSide === "final").length).toBe(1);
    expect(shells.filter(m => m.bracketSide === "bronze").length).toBe(1);
  });

  test("the two Semifinals occupy bracketPosition 0 and 1 (the seed1v4 / seed2v3 slots)", () => {
    const shells = generateTop4PlayoffShell({ makeId: idGen() });
    const semis = shells.filter(m => m.bracketSide === "winners");
    expect(new Set(semis.map(m => m.bracketPosition))).toEqual(new Set([0, 1]));
  });

  test("both Semifinals feed the Final via nextMatchId (one each into slot A/B)", () => {
    const shells = generateTop4PlayoffShell({ makeId: idGen() });
    const semis = shells.filter(m => m.bracketSide === "winners");
    const final = shells.find(m => m.bracketSide === "final");
    for (const s of semis) expect(s.nextMatchId).toBe(final.id);
    expect(new Set(semis.map(m => m.nextMatchSlot))).toEqual(new Set(["A", "B"]));
  });

  test("both Semifinals feed Bronze via loserNextMatchId (one each into slot A/B)", () => {
    const shells = generateTop4PlayoffShell({ makeId: idGen() });
    const semis = shells.filter(m => m.bracketSide === "winners");
    const bronze = shells.find(m => m.bracketSide === "bronze");
    for (const s of semis) expect(s.loserNextMatchId).toBe(bronze.id);
    expect(new Set(semis.map(m => m.loserNextMatchSlot))).toEqual(new Set(["A", "B"]));
  });
});

describe("computeSemifinalFillPatches — standings-driven Semifinal auto-fill", () => {
  const semiShells = () => generateTop4PlayoffShell({ makeId: idGen() }).filter(m => m.bracketSide === "winners");
  const standingsOf = ids => ids.map(registrationId => ({ registrationId }));

  test("fills bracketPosition:0 with rank1 vs rank4, bracketPosition:1 with rank2 vs rank3", () => {
    const semis = semiShells();
    const standings = standingsOf(["rank1", "rank2", "rank3", "rank4"]);
    const patches = computeSemifinalFillPatches(standings, semis);
    expect(patches.length).toBe(2);

    const bySlot = [...semis].sort((a, b) => a.bracketPosition - b.bracketPosition);
    const p0 = patches.find(p => p.matchId === bySlot[0].id);
    const p1 = patches.find(p => p.matchId === bySlot[1].id);
    expect([p0.patch.registrationAId, p0.patch.registrationBId].sort()).toEqual(["rank1", "rank4"].sort());
    expect([p1.patch.registrationAId, p1.patch.registrationBId].sort()).toEqual(["rank2", "rank3"].sort());
  });

  test("returns no patches with fewer than 4 eligible standings rows", () => {
    const semis = semiShells();
    expect(computeSemifinalFillPatches(standingsOf(["r1", "r2", "r3"]), semis)).toEqual([]);
  });

  test("idempotent: returns no patches once the Semifinals are already filled", () => {
    const semis = semiShells();
    const standings = standingsOf(["rank1", "rank2", "rank3", "rank4"]);
    const firstPass = computeSemifinalFillPatches(standings, semis);
    // Apply the first pass's patches onto the shells, exactly like the real caller would.
    const filled = semis.map(m => {
      const p = firstPass.find(x => x.matchId === m.id);
      return p ? { ...m, ...p.patch } : m;
    });
    expect(computeSemifinalFillPatches(standings, filled)).toEqual([]);
  });
});
