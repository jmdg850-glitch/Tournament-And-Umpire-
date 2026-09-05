import { describe, test, expect } from "vitest";
import { assignPools, selectAdvancers, generateKnockoutFromPools } from "./tournamentPoolPlay.js";

const regs = n => Array.from({ length: n }, (_, i) => ({ id: "r" + (i + 1) }));
const m = (a, b, winner, scoreA, scoreB, poolId) => ({
  registrationAId: a, registrationBId: b, status: "completed", winner, poolId,
  score: { scoreA, scoreB },
});

describe("assignPools", () => {
  for (const n of [5, 6, 7, 8, 10, 20, 50, 100]) {
    test(`poolCount:1 is a supported input at N=${n} (the "Round Robin + Knockout" preset)`, () => {
      const registrations = regs(n);
      const pools = assignPools(registrations, 1);
      expect(pools.length).toBe(1);
      expect(pools[0].registrations.length).toBe(n);
      expect(pools[0].registrations.map(r => r.id)).toEqual(registrations.map(r => r.id));
    });
  }

  test("distributes evenly (snake seed) across multiple pools", () => {
    const pools = assignPools(regs(8), 4);
    expect(pools.length).toBe(4);
    for (const p of pools) expect(p.registrations.length).toBe(2);
  });
});

describe("selectAdvancers", () => {
  test("picks exactly the top-K per pool by the standings order", () => {
    const registrations = regs(5);
    const pool = { id: "pool_0", registrations };
    // r1 > r2 > r3 > r4 > r5 by wins (4,3,2,1,0).
    const matches = [
      m("r1", "r2", "A", 11, 5, "pool_0"), m("r1", "r3", "A", 11, 5, "pool_0"),
      m("r1", "r4", "A", 11, 5, "pool_0"), m("r1", "r5", "A", 11, 5, "pool_0"),
      m("r2", "r3", "A", 11, 5, "pool_0"), m("r2", "r4", "A", 11, 5, "pool_0"), m("r2", "r5", "A", 11, 5, "pool_0"),
      m("r3", "r4", "A", 11, 5, "pool_0"), m("r3", "r5", "A", 11, 5, "pool_0"),
      m("r4", "r5", "A", 11, 5, "pool_0"),
    ];
    const advancers = selectAdvancers([pool], matches, 4);
    expect(advancers.map(r => r.id)).toEqual(["r1", "r2", "r3", "r4"]); // top 4, r5 dropped
  });
});

describe("Round Robin + Knockout: semifinal seeding is never random", () => {
  for (const n of [4, 8, 20]) {
    test(`N=${n} pool, top-4 advance -> exact seed1-vs-seed4 / seed2-vs-seed3 semifinals`, () => {
      const registrations = regs(n);
      const pool = { id: "pool_0", registrations };
      // Round-robin every pair so standings are fully determined; registration i beats
      // every registration with a higher index (so rank order === r1..rN by index).
      const matches = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          matches.push(m(registrations[i].id, registrations[j].id, "A", 11, 5, "pool_0"));
        }
      }
      const advancers = selectAdvancers([pool], matches, 4);
      expect(advancers.map(r => r.id)).toEqual(["r1", "r2", "r3", "r4"]);

      const bracket = generateKnockoutFromPools(advancers, "single_elimination", { makeId: (() => { let i = 0; return () => "m" + (i++); })() });
      const round1 = bracket.filter(bm => bm.round === 1);
      expect(round1.length).toBe(2);
      const pairKey = bm => [bm.registrationAId, bm.registrationBId].sort().join("|");
      expect(new Set(round1.map(pairKey))).toEqual(new Set([
        ["r1", "r4"].sort().join("|"), // seed 1 vs seed 4
        ["r2", "r3"].sort().join("|"), // seed 2 vs seed 3
      ]));
    });
  }
});
