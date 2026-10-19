// Stage labels, W/O score line, overall team standings and seeded playoff
// slots — the pure helpers behind Matches, Brackets, Results and Edit
// qualifiers (React rendering itself has no harness in this project).
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchStageTitle, parseOptionalScore, scoreLine, overallTeamStandings, seededPlayoffSlots } from "./lib.js";

const teamDivision = [
  { id: "rr", division_id: "d1", stage_id: "s-rr", stage_label: "round_robin", round: 1, parent_match_id: null },
  { id: "qf", division_id: "d1", stage_id: "s-ko", stage_label: "knockout", round: 2, parent_match_id: null },
  { id: "sf", division_id: "d1", stage_id: "s-ko", stage_label: "semifinal", round: 3, parent_match_id: null },
  { id: "fi", division_id: "d1", stage_id: "s-ko", stage_label: "final", round: 4, parent_match_id: null },
  { id: "br", division_id: "d1", stage_id: "s-ko", stage_label: "bronze", round: 4, parent_match_id: null },
  { id: "rr-p", division_id: "d1", stage_id: "s-rr", stage_label: null, round: 1, parent_match_id: "rr" },
  { id: "sf-p", division_id: "d1", stage_id: "s-ko", stage_label: null, round: 3, parent_match_id: "sf" },
];

test("matchStageTitle: team elimination — matchups by stored stage, pair matches inherit their matchup's stage", () => {
  const t = (id) => matchStageTitle(teamDivision.find((m) => m.id === id), teamDivision);
  assert.equal(t("rr"), "Qualification");
  assert.equal(t("rr-p"), "Qualification");
  assert.equal(t("qf"), "Quarterfinals");
  assert.equal(t("sf"), "Semifinals");
  assert.equal(t("sf-p"), "Semifinals");
  assert.equal(t("fi"), "Final");
  assert.equal(t("br"), "Bronze");
});

test("matchStageTitle: single elimination — derived from the round (no stored label)", () => {
  const se = [1, 1, 1, 1, 2, 2, 3].map((round, i) => ({ id: `m${i}`, division_id: "d2", round, stage_label: null, parent_match_id: null }));
  se.push({ id: "b", division_id: "d2", round: 3, stage_label: "bronze", bracket_side: "bronze", parent_match_id: null });
  assert.equal(matchStageTitle(se[0], se), "Quarterfinals");
  assert.equal(matchStageTitle(se[4], se), "Semifinals");
  assert.equal(matchStageTitle(se[6], se), "Final");
  assert.equal(matchStageTitle(se[7], se), "Bronze");
  const big = [1, 2, 3, 4].map((round) => ({ id: `r${round}`, division_id: "d3", round, stage_label: null }));
  assert.equal(matchStageTitle(big[0], big), "Round 1");
  assert.equal(matchStageTitle({ id: "x", round: 1, stage_label: null }, [{ id: "x", round: 1, stage_label: null }]), "Final");
});

test("scoreLine: a win by default shows W/O, with the recorded administrative score when there is one", () => {
  assert.equal(scoreLine({ score_state: { defaultWin: { winner: "A" } } }, { score_a: 0, score_b: 0 }), "W/O");
  assert.equal(scoreLine({ score_state: { defaultWin: { winner: "A", score: { a: 11, b: 0 } }, scoreA: 11, scoreB: 0 } }, { score_a: 11, score_b: 0 }), "W/O 11–0");
  assert.equal(scoreLine({ score_state: { scoreA: 11, scoreB: 7 } }, { score_a: 11, score_b: 7 }), "11–7");
});

test("parseOptionalScore: empty = no score, half-filled = invalid, else numbers", () => {
  assert.equal(parseOptionalScore("", " "), undefined);
  assert.equal(parseOptionalScore("11", ""), "invalid");
  assert.deepEqual(parseOptionalScore("11", "0"), { a: 11, b: 0 });
});

function deskData() {
  const m = (id, division_id, parent_match_id, status, winner, extra = {}) => ({ id, division_id, parent_match_id, status, winner, score_state: {}, ...extra });
  const side = (match_id, slot, participant_id, team_id) => ({ id: `${match_id}${slot}`, match_id, slot, participant_id, team_id });
  return {
    divisions: [{ id: "d1", name: "Men", format: "team_elimination" }, { id: "d2", name: "Women", format: "team_elimination" }, { id: "d3", name: "Open", format: "single_elim" }],
    teams: [
      { id: "t1", name: "ONSE", division_id: "d1" }, { id: "t2", name: "NEXTG", division_id: "d1" },
      { id: "t3", name: "onse", division_id: "d2" }, { id: "t4", name: "NEXTG", division_id: "d2" },
    ],
    matches: [
      m("p1", "d1", "mu1", "completed", "A"), m("p2", "d1", "mu1", "completed", "B"),
      m("p3", "d2", "mu2", "completed", "A", { score_state: { defaultWin: { winner: "A", score: { a: 11, b: 0 } }, scoreA: 11, scoreB: 0 } }),
      m("p4", "d2", "mu2", "cancelled", null),
      m("p5", "d3", null, "completed", "A"),
    ],
    matchParticipants: [
      side("p1", "A", "a1", "t1"), side("p1", "B", "b1", "t2"),
      side("p2", "A", "a2", "t1"), side("p2", "B", "b2", "t2"),
      side("p3", "A", "a3", "t3"), side("p3", "B", "b3", "t4"),
      side("p4", "A", "a4", "t3"), side("p4", "B", "b4", "t4"),
    ],
    results: [
      { match_id: "p1", score_a: 11, score_b: 5 }, { match_id: "p2", score_a: 8, score_b: 11 },
      { match_id: "p3", score_a: 11, score_b: 0 },
    ],
  };
}

test("overallTeamStandings: combines same-named teams across team-elimination divisions; cancelled and other formats excluded", () => {
  const rows = overallTeamStandings(deskData());
  assert.deepEqual(rows.map((r) => [r.name, r.rank, r.played, r.wins, r.losses, r.pointsFor, r.pointsAgainst]), [
    ["ONSE", 1, 3, 2, 1, 30, 16],
    ["NEXTG", 2, 3, 1, 2, 16, 30],
  ]);
  assert.deepEqual(rows[0].divisions.map((d) => [d.divisionName, d.played]), [["Men", 2], ["Women", 1]]);
});

test("seededPlayoffSlots: only slots not fed by an earlier match; override and lock state", () => {
  const data = {
    stages: [{ id: "ko", division_id: "d1", kind: "team_knockout", config: { auto_slots: [{ match_id: "sf1", slot: "A", participant_id: "jeff" }], overrides: [{ match_id: "sf1", slot: "A", reason: "fix" }] } }],
    matches: [
      { id: "sf1", stage_id: "ko", stage_label: "semifinal", round: 2, bracket_position: 0, status: "scheduled", next_match_id: "fi", next_match_slot: "A" },
      { id: "sf2", stage_id: "ko", stage_label: "semifinal", round: 2, bracket_position: 1, status: "scheduled", next_match_id: "fi", next_match_slot: "B" },
      { id: "fi", stage_id: "ko", stage_label: "final", round: 3, bracket_position: 0, status: "scheduled" },
      { id: "sf2-p", stage_id: "ko", parent_match_id: "sf2", status: "in_progress", started_at: "x" },
    ],
    matchParticipants: [
      { match_id: "sf1", slot: "A", participant_id: "grace", team_id: "t2" },
      { match_id: "sf1", slot: "B", participant_id: "aki", team_id: "t1" },
      { match_id: "sf2", slot: "A", participant_id: "carl", team_id: "t1" },
      { match_id: "sf2", slot: "B", participant_id: "ken", team_id: "t2" },
    ],
  };
  const slots = seededPlayoffSlots({ id: "d1" }, data);
  assert.deepEqual(slots.map((x) => [x.match.id, x.slot, x.participantId, x.overridden, x.locked]), [
    ["sf1", "A", "grace", true, false],
    ["sf1", "B", "aki", false, false],
    ["sf2", "A", "carl", false, true],
    ["sf2", "B", "ken", false, true],
  ]);
  assert.equal(slots[0].autoParticipantId, "jeff");
  assert.equal(slots[0].stageTitle, "Semifinals");
  assert.deepEqual(seededPlayoffSlots({ id: "other" }, data), []);
});
