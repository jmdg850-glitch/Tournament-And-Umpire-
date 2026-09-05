import { describe, test, expect } from "vitest";
import { seedByTeamRanking } from "./tournamentSeeding.js";

// roster entries shaped like the app's directory/accountsDirectory rows this
// function is actually called with (DivisionDetailPanel.jsx passes `directory`).
const roster = [
  { id: "p1", doublesRating: 5.0 }, { id: "p2", doublesRating: 4.8 }, // Team Strong's pair 1 (avg 4.9)
  { id: "p3", doublesRating: 4.6 }, { id: "p4", doublesRating: 4.4 }, // Team Strong's pair 2 (avg 4.5)
  { id: "p5", doublesRating: 3.0 }, { id: "p6", doublesRating: 3.0 }, // Team Weak's pair 1 (avg 3.0)
  { id: "p7", doublesRating: 2.0 }, { id: "p8", doublesRating: 2.0 }, // Team Weak's pair 2 (avg 2.0)
];
const reg = (id, teamId, playerIds) => ({ id, teamId, playerIds, playerNames: {} });

describe("seedByTeamRanking", () => {
  test("a stronger team's pairs all sort ahead of a weaker team's, as a block", () => {
    const regs = [
      reg("weak1", "weak", ["p5","p6"]),
      reg("strong1", "strong", ["p1","p2"]),
      reg("weak2", "weak", ["p7","p8"]),
      reg("strong2", "strong", ["p3","p4"]),
    ];
    const ordered = seedByTeamRanking(regs, roster, true).map(r => r.id);
    // Team "strong" (avg of 4.9,4.5 = 4.7) entirely ahead of team "weak" (avg of 3.0,2.0 = 2.5).
    expect(ordered.slice(0,2).sort()).toEqual(["strong1","strong2"]);
    expect(ordered.slice(2,4).sort()).toEqual(["weak1","weak2"]);
  });

  test("within a team, the higher-individually-rated pair sorts first (tiebreaker)", () => {
    const regs = [
      reg("strong2", "strong", ["p3","p4"]), // avg 4.5
      reg("strong1", "strong", ["p1","p2"]), // avg 4.9
    ];
    const ordered = seedByTeamRanking(regs, roster, true).map(r => r.id);
    expect(ordered).toEqual(["strong1","strong2"]);
  });

  test("an untagged registration (no teamId) is ranked as its own team-of-one, by its own rating", () => {
    const regs = [
      reg("solo", null, ["p7","p8"]),   // rating 2.0, no team
      reg("strong1", "strong", ["p1","p2"]), // rating 4.9
    ];
    const ordered = seedByTeamRanking(regs, roster, true).map(r => r.id);
    expect(ordered).toEqual(["strong1","solo"]);
  });

  test("a player missing from the roster falls back to baseRating rather than crashing/NaN", () => {
    const regs = [ reg("ghost", "t0", ["unknown1","unknown2"]) ];
    expect(() => seedByTeamRanking(regs, roster, true)).not.toThrow();
    expect(seedByTeamRanking(regs, roster, true, 3).length).toBe(1);
  });
});
