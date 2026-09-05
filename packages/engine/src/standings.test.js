import { describe, test, expect } from "vitest";
import { buildTournamentStandings } from "./standings.js";

const regs = ids => ids.map(id => ({ id }));
const m = (a, b, winner, scoreA, scoreB) => ({
  registrationAId: a, registrationBId: b, status: "completed", winner,
  score: { scoreA, scoreB },
});
const rowFor = (rows, id) => rows.find(r => r.registrationId === id);
const posOf = (rows, id) => rows.findIndex(r => r.registrationId === id);

describe("buildTournamentStandings tie-breaker order", () => {
  test("tier 1 — Wins decides outright", () => {
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), [
      m("r1", "r3", "A", 11, 5), m("r1", "r4", "A", 11, 5),
      m("r2", "r3", "A", 11, 5),
    ]);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 2 — Win% decides when Wins are tied but match counts differ", () => {
    const matches = [
      m("r1", "r3", "A", 11, 5), m("r1", "r4", "A", 11, 5),
      m("r2", "r3", "A", 11, 5), m("r2", "r4", "A", 11, 5), m("r2", "r5", "B", 5, 11),
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4", "r5"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 3 — Point Differential decides when Wins and Win% are tied", () => {
    const matches = [
      m("r1", "r3", "A", 21, 4),
      m("r2", "r4", "A", 11, 7),
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);
    expect(rowFor(rows, "r1").winPct).toBe(rowFor(rows, "r2").winPct);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 4 — Head-to-Head decides when Wins/Win%/PointDiff are all tied", () => {
    const matches = [
      m("r1", "r2", "A", 11, 9),
      m("r1", "r3", "B", 5, 11),
      m("r2", "r4", "A", 9, 11),
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);
    expect(rowFor(rows, "r1").winPct).toBe(rowFor(rows, "r2").winPct);
    expect(rowFor(rows, "r1").pointDiff).toBe(rowFor(rows, "r2").pointDiff);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 5 — Total Points Scored decides when no head-to-head meeting exists", () => {
    const matches = [
      m("r1", "r3", "A", 21, 19),
      m("r2", "r4", "A", 11, 9),
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);
    expect(rowFor(rows, "r1").winPct).toBe(rowFor(rows, "r2").winPct);
    expect(rowFor(rows, "r1").pointDiff).toBe(rowFor(rows, "r2").pointDiff);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 6 — deterministic random draw is the last resort AND is stable across calls", () => {
    const matches = [
      m("r1", "r3", "A", 11, 9),
      m("r2", "r4", "A", 11, 9),
    ];
    const registrations = regs(["r1", "r2", "r3", "r4"]);
    const run1 = buildTournamentStandings(registrations, matches).map(r => r.registrationId);
    const run2 = buildTournamentStandings(registrations, matches).map(r => r.registrationId);
    const run3 = buildTournamentStandings([...registrations].reverse(), matches).map(r => r.registrationId);
    expect(run1).toEqual(run2);
    expect(run1).toEqual(run3);
  });

  test("winPct guards divide-by-zero for a registration with no completed matches", () => {
    const rows = buildTournamentStandings(regs(["r1"]), []);
    expect(rows[0].winPct).toBe(0);
    expect(rows[0].matchesPlayed).toBe(0);
  });
});
