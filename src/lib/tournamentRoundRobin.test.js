import { describe, test, expect } from "vitest";
import { generateRoundRobinSchedule } from "./tournamentRoundRobin.js";

const regs = n => Array.from({ length: n }, (_, i) => ({ id: "r" + (i + 1) }));

describe("generateRoundRobinSchedule", () => {
  for (const n of [5, 6, 7, 8, 10, 20]) {
    test(`N=${n}: every pair meets exactly once`, () => {
      const { rounds } = generateRoundRobinSchedule(regs(n));
      const realMatches = rounds.flatMap(r => r.matches.filter(m => !m.isBye));
      expect(realMatches.length).toBe((n * (n - 1)) / 2);

      const seen = new Set();
      for (const m of realMatches) {
        const key = [m.registrationAId, m.registrationBId].sort().join("|");
        expect(seen.has(key)).toBe(false); // no pair repeats
        seen.add(key);
      }
      expect(seen.size).toBe((n * (n - 1)) / 2);
    });

    test(`N=${n}: correct round count`, () => {
      const { rounds } = generateRoundRobinSchedule(regs(n));
      const padded = n % 2 === 0 ? n : n + 1;
      expect(rounds.length).toBe(padded - 1);
    });

    test(`N=${n}: every participant appears exactly once in every round`, () => {
      const { rounds } = generateRoundRobinSchedule(regs(n));
      for (const round of rounds) {
        // Every real participant shows up in exactly one match this round — either
        // paired with a real opponent, or (odd N only) alone against the virtual BYE
        // seat, whose own null id is filtered out here but the real side stays.
        const ids = round.matches.flatMap(m => [m.registrationAId, m.registrationBId]).filter(x => x != null);
        expect(new Set(ids).size).toBe(ids.length); // no one plays themselves or plays twice in a round
        expect(ids.length).toBe(n);
        expect(round.matches.filter(m => m.isBye).length).toBe(n % 2 === 0 ? 0 : 1);
      }
    });
  }

  test("odd N: each participant sits out (BYE) exactly once across all rounds", () => {
    const n = 7;
    const all = regs(n);
    const { rounds } = generateRoundRobinSchedule(all);
    const byeCounts = new Map(all.map(r => [r.id, 0]));
    for (const round of rounds) {
      const playingIds = new Set(round.matches.filter(m => !m.isBye).flatMap(m => [m.registrationAId, m.registrationBId]));
      const sittingOut = all.filter(r => !playingIds.has(r.id));
      expect(sittingOut.length).toBe(1); // exactly one participant idle this round
      byeCounts.set(sittingOut[0].id, byeCounts.get(sittingOut[0].id) + 1);
    }
    for (const count of byeCounts.values()) expect(count).toBe(1); // and no one sits out twice
  });

  test("N=0 returns no rounds", () => {
    expect(generateRoundRobinSchedule(regs(0)).rounds).toEqual([]);
  });

  test("N=1 pads to a virtual BYE seat: one round, no real match", () => {
    const { rounds } = generateRoundRobinSchedule(regs(1));
    expect(rounds.length).toBe(1);
    expect(rounds[0].matches.every(m => m.isBye)).toBe(true);
  });

  test("N=2: single round, single match", () => {
    const { rounds } = generateRoundRobinSchedule(regs(2));
    expect(rounds.length).toBe(1);
    expect(rounds[0].matches.filter(m => !m.isBye).length).toBe(1);
  });
});
