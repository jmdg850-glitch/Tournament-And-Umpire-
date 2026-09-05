import { describe, test, expect } from "vitest";
import { generateDoubleEliminationBracket, advanceDoubleEliminationBracket } from "./doubleElimination.js";

const regs = n => Array.from({ length: n }, (_, i) => ({ id: "r" + (i + 1) }));
const idGen = () => { let i = 0; return () => "m" + (i++); };

describe("generateDoubleEliminationBracket — grand final detection", () => {
  for (const n of [2, 3, 4, 5, 8]) {
    test(`N=${n}: exactly one bracketSide:"final" match, with no nextMatchId`, () => {
      const matches = generateDoubleEliminationBracket(regs(n), { makeId: idGen() });
      const finals = matches.filter(m => m.bracketSide === "final");
      expect(finals.length).toBe(1);
      expect(finals[0].nextMatchId).toBeNull();
    });
  }

  test("every non-final match has phantomSlot in {null,'A','B','both'}", () => {
    const matches = generateDoubleEliminationBracket(regs(5), { makeId: idGen() });
    for (const m of matches) expect([null, "A", "B", "both"]).toContain(m.phantomSlot);
  });
});

describe("advanceDoubleEliminationBracket", () => {
  test("completing the grand final produces zero patches (nothing further to advance)", () => {
    const matches = generateDoubleEliminationBracket(regs(4), { makeId: idGen() });
    const final = matches.find(m => m.bracketSide === "final");
    const patches = advanceDoubleEliminationBracket(matches, final.id, "someWinner", "someLoser");
    expect(patches).toEqual([]);
  });

  test("a winners-bracket round-1 loser routes into the losers bracket", () => {
    const matches = generateDoubleEliminationBracket(regs(4), { makeId: idGen() });
    const wbR1 = matches.filter(m => m.bracketSide === "winners" && m.round === 1);
    const first = wbR1[0];
    const patches = advanceDoubleEliminationBracket(matches, first.id, "winnerId", "loserId");
    const lbPatch = patches.find(p => p.matchId === first.loserNextMatchId);
    expect(lbPatch).toBeDefined();
    expect(Object.values(lbPatch.patch)).toContain("loserId");
  });

  test("phantom-slot cascade terminates for a sparse (N=5-in-8) bracket without throwing", () => {
    expect(() => generateDoubleEliminationBracket(regs(5), { makeId: idGen() })).not.toThrow();
    const matches = generateDoubleEliminationBracket(regs(5), { makeId: idGen() });
    expect(matches.filter(m => m.bracketSide === "final").length).toBe(1);
    expect(matches.every(m => typeof m.id === "string" && Number.isInteger(m.round))).toBe(true);
  });

  test("N=2 is degenerate: no losers bracket, winner and loser both route to the grand final", () => {
    const matches = generateDoubleEliminationBracket(regs(2), { makeId: idGen() });
    expect(matches.filter(m => m.bracketSide === "losers").length).toBe(0);
    const only = matches.find(m => m.bracketSide === "winners");
    const final = matches.find(m => m.bracketSide === "final");
    expect(only.nextMatchId).toBe(final.id);
    expect(only.loserNextMatchId).toBe(final.id);
    expect(only.nextMatchSlot).not.toBe(only.loserNextMatchSlot);
  });
});
