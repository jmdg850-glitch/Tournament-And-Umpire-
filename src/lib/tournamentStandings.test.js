import { describe, test, expect } from "vitest";
import { buildTournamentStandings } from "./tournamentStandings.js";

const regs = ids => ids.map(id => ({ id }));
// completed=true is implicit; every match below already carries status:"completed".
const m = (a, b, winner, scoreA, scoreB) => ({
  registrationAId: a, registrationBId: b, status: "completed", winner,
  score: { scoreA, scoreB },
});
const rowFor = (rows, id) => rows.find(r => r.registrationId === id);
const posOf = (rows, id) => rows.findIndex(r => r.registrationId === id);

describe("buildTournamentStandings tie-breaker order", () => {
  test("tier 1 — Wins decides outright", () => {
    // Every id referenced by a match must also be in the registrations list passed in,
    // or buildTournamentStandings silently drops that match (rows.get returns undefined).
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), [
      m("r1", "r3", "A", 11, 5), m("r1", "r4", "A", 11, 5), // r1: 2 wins
      m("r2", "r3", "A", 11, 5), // r2: 1 win
    ]);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 2 — Win% decides when Wins are tied but match counts differ", () => {
    // r1: 2 wins / 2 played = 100%. r2: 2 wins / 3 played = 66.7%.
    const matches = [
      m("r1", "r3", "A", 11, 5), m("r1", "r4", "A", 11, 5),
      m("r2", "r3", "A", 11, 5), m("r2", "r4", "A", 11, 5), m("r2", "r5", "B", 5, 11),
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4", "r5"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins); // tied on wins (2 each)
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2")); // r1's 100% beats r2's 66.7%
  });

  test("tier 3 — Point Differential decides when Wins and Win% are tied", () => {
    const matches = [
      m("r1", "r3", "A", 21, 4),  // r1: +17
      m("r2", "r4", "A", 11, 7),  // r2: +4
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);
    expect(rowFor(rows, "r1").winPct).toBe(rowFor(rows, "r2").winPct);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2"));
  });

  test("tier 4 — Head-to-Head decides when Wins/Win%/PointDiff are all tied", () => {
    // r1 beats r2 head-to-head (11-9); each also has one further, offsetting result
    // so their aggregate wins/winPct/pointDiff end up identical.
    const matches = [
      m("r1", "r2", "A", 11, 9),   // r1 beats r2: r1 +2, r2 -2
      m("r1", "r3", "B", 5, 11),   // r1 loses: r1 -6  (r1 total diff: 2-6=-4)
      m("r2", "r4", "A", 9, 11),   // r2 "wins" this one (winner:"A") but nets -2 (r2 total diff: -2-2=-4)
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);       // 1 win / 1 loss each
    expect(rowFor(rows, "r1").winPct).toBe(rowFor(rows, "r2").winPct);
    expect(rowFor(rows, "r1").pointDiff).toBe(rowFor(rows, "r2").pointDiff); // both -4
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2")); // h2h: r1 beat r2
  });

  test("tier 5 — Total Points Scored decides when no head-to-head meeting exists", () => {
    const matches = [
      m("r1", "r3", "A", 21, 19), // r1: +2, pointsFor 21
      m("r2", "r4", "A", 11, 9),  // r2: +2, pointsFor 11
    ];
    const rows = buildTournamentStandings(regs(["r1", "r2", "r3", "r4"]), matches);
    expect(rowFor(rows, "r1").wins).toBe(rowFor(rows, "r2").wins);
    expect(rowFor(rows, "r1").winPct).toBe(rowFor(rows, "r2").winPct);
    expect(rowFor(rows, "r1").pointDiff).toBe(rowFor(rows, "r2").pointDiff);
    expect(posOf(rows, "r1")).toBeLessThan(posOf(rows, "r2")); // r1's 21 beats r2's 11
  });

  test("tier 6 — deterministic random draw is the last resort AND is stable across calls", () => {
    // Fully identical on every deterministic tier, and never met each other.
    const matches = [
      m("r1", "r3", "A", 11, 9),
      m("r2", "r4", "A", 11, 9),
    ];
    const registrations = regs(["r1", "r2", "r3", "r4"]);
    const run1 = buildTournamentStandings(registrations, matches).map(r => r.registrationId);
    const run2 = buildTournamentStandings(registrations, matches).map(r => r.registrationId);
    const run3 = buildTournamentStandings([...registrations].reverse(), matches).map(r => r.registrationId);
    expect(run1).toEqual(run2); // same fixture, called twice -> identical order (not Math.random-based)
    expect(run1).toEqual(run3); // order of the input `registrations` array doesn't affect the outcome
  });

  test("winPct guards divide-by-zero for a registration with no completed matches", () => {
    const rows = buildTournamentStandings(regs(["r1"]), []);
    expect(rows[0].winPct).toBe(0);
    expect(rows[0].matchesPlayed).toBe(0);
  });
});
