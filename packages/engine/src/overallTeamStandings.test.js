import { describe, expect, test } from "vitest";
import { buildOverallTeamStandings, normalizeTeamNameKey, validateDefaultWinScore } from "./index.js";

const divisions = [{ id: "d1", name: "Men's Doubles" }, { id: "d2", name: "Women's Doubles" }];
const teams = [
  { id: "t1a", name: "ONSE", divisionId: "d1" },
  { id: "t1b", name: "NEXTG", divisionId: "d1" },
  { id: "t2a", name: "  onse ", divisionId: "d2" },
  { id: "t2b", name: "Next  G", divisionId: "d2" },
];
const r = (matchId, divisionId, teamAId, teamBId, scoreA, scoreB, winnerSlot = scoreA > scoreB ? "A" : "B") =>
  ({ matchId, divisionId, teamAId, teamBId, winnerSlot, scoreA, scoreB });

describe("normalizeTeamNameKey", () => {
  test("trims, collapses whitespace, ignores case", () => {
    expect(normalizeTeamNameKey("  ONSE  Club ")).toBe("onse club");
    expect(normalizeTeamNameKey(null)).toBe("");
  });
});

describe("buildOverallTeamStandings", () => {
  test("combines the same team name across divisions and totals W/L/PF/PA/PD with a division breakdown", () => {
    const rows = buildOverallTeamStandings({
      teams, divisions,
      pairResults: [
        r("m1", "d1", "t1a", "t1b", 11, 7),
        r("m2", "d1", "t1a", "t1b", 9, 11),
        r("m3", "d2", "t2a", "t2b", 11, 4),
      ],
    });
    const onse = rows.find((x) => x.key === "onse");
    expect(onse).toMatchObject({ name: "ONSE", played: 3, wins: 2, losses: 1, pointsFor: 31, pointsAgainst: 22, pointDiff: 9, rank: 1 });
    expect(onse.teamIds).toEqual(["t1a", "t2a"]);
    expect(onse.divisions.map((d) => [d.divisionName, d.wins, d.losses, d.pointDiff])).toEqual([
      ["Men's Doubles", 1, 1, 2],
      ["Women's Doubles", 1, 0, 7],
    ]);
    // "NEXTG" and "Next  G" are different names → not merged.
    expect(rows.filter((x) => x.key.startsWith("next"))).toHaveLength(2);
  });

  test("a win by default counts as W/L; its points are the recorded score, or 0–0", () => {
    const rows = buildOverallTeamStandings({
      teams, divisions,
      pairResults: [r("wo1", "d1", "t1a", "t1b", 0, 0, "B"), r("wo2", "d1", "t1a", "t1b", 11, 0, "A")],
    });
    const onse = rows.find((x) => x.key === "onse");
    const nextg = rows.find((x) => x.key === "nextg");
    expect(onse).toMatchObject({ played: 2, wins: 1, losses: 1, pointsFor: 11, pointsAgainst: 0 });
    expect(nextg).toMatchObject({ played: 2, wins: 1, losses: 1, pointsFor: 0, pointsAgainst: 11 });
  });

  test("each match counts once; results without a winner are ignored", () => {
    const rows = buildOverallTeamStandings({
      teams, divisions,
      pairResults: [r("m1", "d1", "t1a", "t1b", 11, 7), r("m1", "d1", "t1a", "t1b", 11, 7), { ...r("m9", "d1", "t1a", "t1b", 3, 2), winnerSlot: null }],
    });
    expect(rows.find((x) => x.key === "onse")).toMatchObject({ played: 1, wins: 1 });
  });

  test("ranks W → PD → PF; full ties share a rank and list by name, deterministically", () => {
    const tied = [
      { id: "x", name: "Zeta", divisionId: "d1" },
      { id: "y", name: "Alpha", divisionId: "d1" },
      { id: "z", name: "Mid", divisionId: "d1" },
      { id: "w", name: "Low", divisionId: "d1" },
    ];
    const results = [
      r("1", "d1", "x", "w", 11, 5),
      r("2", "d1", "y", "w", 11, 5),
      r("3", "d1", "z", "w", 11, 8),
    ];
    const a = buildOverallTeamStandings({ teams: tied, divisions, pairResults: results });
    const b = buildOverallTeamStandings({ teams: [...tied].reverse(), divisions, pairResults: [...results].reverse() });
    expect(a.map((x) => [x.name, x.rank])).toEqual([["Alpha", 1], ["Zeta", 1], ["Mid", 3], ["Low", 4]]);
    expect(b.map((x) => [x.name, x.rank])).toEqual(a.map((x) => [x.name, x.rank]));
  });

  test("teams with no counted matches still appear with zeros", () => {
    const rows = buildOverallTeamStandings({ teams, divisions, pairResults: [] });
    expect(rows.every((x) => x.played === 0 && x.rank === 1)).toBe(true);
  });
});

describe("validateDefaultWinScore", () => {
  const rules = { winTo: 11, bestOf: 1 };
  test("no score is allowed (plain W/O)", () => {
    expect(validateDefaultWinScore(null, "A", rules)).toEqual({ ok: true, score: null });
    expect(validateDefaultWinScore(undefined, "B", rules)).toEqual({ ok: true, score: null });
  });
  test("a score the winner leads is accepted", () => {
    expect(validateDefaultWinScore({ a: 11, b: 0 }, "A", rules)).toEqual({ ok: true, score: { a: 11, b: 0 } });
    expect(validateDefaultWinScore({ a: 3, b: 7 }, "B", rules)).toEqual({ ok: true, score: { a: 3, b: 7 } });
  });
  test("rejects a score that contradicts the winner, a tie, bad numbers, over-target, multi-game", () => {
    expect(validateDefaultWinScore({ a: 0, b: 11 }, "A", rules).code).toBe("SCORE_WINNER_MISMATCH");
    expect(validateDefaultWinScore({ a: 5, b: 5 }, "A", rules).code).toBe("SCORE_WINNER_MISMATCH");
    expect(validateDefaultWinScore({ a: -1, b: 0 }, "B", rules).code).toBe("INVALID_SCORE");
    expect(validateDefaultWinScore({ a: 1.5, b: 0 }, "A", rules).code).toBe("INVALID_SCORE");
    expect(validateDefaultWinScore({ a: 12, b: 0 }, "A", rules).code).toBe("INVALID_SCORE");
    expect(validateDefaultWinScore([11, 0], "A", rules).code).toBe("INVALID_SCORE");
    expect(validateDefaultWinScore({ a: 11, b: 0 }, "A", { winTo: 11, bestOf: 3 }).code).toBe("CORRECTION_UNSUPPORTED");
  });
});
