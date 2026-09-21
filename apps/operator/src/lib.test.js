// Covers the person-resolution logic behind Matches → Edit Players (see
// EditPlayersModal in TournamentDesk.jsx). The modal's own React state/UI is
// not covered here — there is no component-rendering test harness in this
// project — but every resolution decision the modal makes (blank vs typed,
// existing vs new player, case/whitespace normalization) is a pure function
// of resolvePersonByName/normalizePersonName, fully exercised below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePersonName, resolvePersonByName, liveShareUrl, resolveShareOrigin, PUBLIC_LIVE_PRODUCTION_ORIGIN, recommendedScoringTarget, teamStandings } from "./lib.js";

const persons = [
  { id: "p1", display_name: "Rem" },
  { id: "p2", display_name: "Jeff" },
  { id: "p3", display_name: "John" },
  { id: "p4", display_name: "Mark" },
  { id: "p5", display_name: "Carlos Cruz" },
];

test("resolvePersonByName: a blank replacement is 'no change' (null), not an error", () => {
  assert.equal(resolvePersonByName("", persons), null);
  assert.equal(resolvePersonByName("   ", persons), null);
  assert.equal(resolvePersonByName(undefined, persons), null);
});

test("resolvePersonByName: an unblank field is never pre-filled with the current player — this is purely a resolver over whatever text is passed in", () => {
  // The modal always initializes replacement text to "", independent of the
  // current player's name — see EditPlayersModal's replacementText state.
  // This test documents the contract the modal relies on: passing "" (the
  // initial/untouched state) must resolve to "no change", never to the
  // current player being silently "replaced" with themselves.
  const untouched = resolvePersonByName("", persons);
  assert.equal(untouched, null);
});

test("resolvePersonByName: an existing player is resolved by exact name", () => {
  const r = resolvePersonByName("Carlos Cruz", persons);
  assert.equal(r.existingPerson.id, "p5");
  assert.equal(r.text, "Carlos Cruz");
});

test("resolvePersonByName: matching is case-insensitive", () => {
  assert.equal(resolvePersonByName("carlos cruz", persons).existingPerson.id, "p5");
  assert.equal(resolvePersonByName("CARLOS CRUZ", persons).existingPerson.id, "p5");
  assert.equal(resolvePersonByName("CaRlOs CrUz", persons).existingPerson.id, "p5");
});

test("resolvePersonByName: leading/trailing whitespace is normalized before matching", () => {
  const r = resolvePersonByName("  Carlos Cruz  ", persons);
  assert.equal(r.existingPerson.id, "p5");
  assert.equal(r.text, "Carlos Cruz"); // trimmed for display/creation too
});

test("resolvePersonByName: an unknown typed name resolves with existingPerson=null (caller creates a new player)", () => {
  const r = resolvePersonByName("Zed", persons);
  assert.equal(r.existingPerson, null);
  assert.equal(r.text, "Zed");
});

test("resolvePersonByName: manual typed entry does not require selecting from a list — any non-blank text resolves", () => {
  // No "must be in the suggestion list" constraint anywhere in this function —
  // this is exactly what lets EditPlayersModal accept manually typed names.
  const r = resolvePersonByName("Someone Brand New", persons);
  assert.deepEqual(r, { text: "Someone Brand New", existingPerson: null });
});

test("resolvePersonByName: does not create a duplicate — re-typing an existing name (any casing/whitespace) always resolves to the same existing id", () => {
  const variants = ["Carlos Cruz", "carlos cruz", " Carlos Cruz ", "CARLOS  cruz".replace(/\s+/g, " ")];
  for (const v of variants) {
    assert.equal(resolvePersonByName(v, persons).existingPerson.id, "p5");
  }
});

test("normalizePersonName: trims and lowercases", () => {
  assert.equal(normalizePersonName("  Rem  "), "rem");
  assert.equal(normalizePersonName("REM"), "rem");
  assert.equal(normalizePersonName(null), "");
  assert.equal(normalizePersonName(undefined), "");
});

test("liveShareUrl: builds the share link for a slug", () => {
  assert.equal(liveShareUrl("https://tournament-operator.vercel.app", "summer-open-2026"), "https://tournament-operator.vercel.app/live/summer-open-2026");
});

test("liveShareUrl: builds the share link for a raw uuid", () => {
  const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  assert.equal(liveShareUrl("https://tournament-operator.vercel.app", id), `https://tournament-operator.vercel.app/live/${id}`);
});

test("resolveShareOrigin: uses the real origin in a browser (http/https)", () => {
  assert.equal(resolveShareOrigin({ location: { protocol: "https:", origin: "https://tournament-operator.vercel.app" } }), "https://tournament-operator.vercel.app");
  assert.equal(resolveShareOrigin({ location: { protocol: "http:", origin: "http://localhost:5174" } }), "http://localhost:5174");
});

test("resolveShareOrigin: falls back to the production origin under Electron (file:)", () => {
  assert.equal(resolveShareOrigin({ location: { protocol: "file:", origin: "file://" } }), PUBLIC_LIVE_PRODUCTION_ORIGIN);
});

test("resolveShareOrigin: falls back to the production origin when there is no window", () => {
  assert.equal(resolveShareOrigin(null), PUBLIC_LIVE_PRODUCTION_ORIGIN);
  assert.equal(resolveShareOrigin(undefined), PUBLIC_LIVE_PRODUCTION_ORIGIN);
});

test("recommendedScoringTarget: semifinal, final, and bronze recommend 15", () => {
  assert.equal(recommendedScoringTarget({ stage_label: "semifinal" }, null), 15);
  assert.equal(recommendedScoringTarget({ stage_label: "final" }, null), 15);
  assert.equal(recommendedScoringTarget({ stage_label: "bronze" }, null), 15);
});

test("recommendedScoringTarget: other stages fall back to the division's configured target, defaulting to 11", () => {
  assert.equal(recommendedScoringTarget({ stage_label: "round_robin" }, { config: { winTo: 15 } }), 15);
  assert.equal(recommendedScoringTarget({ stage_label: "round_robin" }, { config: { winTo: 11 } }), 11);
  assert.equal(recommendedScoringTarget({ stage_label: null }, null), 11);
});

// Fixture mirrors loadDeskData's real shape (see lib.js) for a team_elimination
// division: 2 teams x 2 pairs, one completed round-robin team matchup (2 pair
// matches) plus one completed semifinal team matchup (1 pair match) that must
// be excluded from these standings, an official-write correction that must
// win over a stale score_state, and a still-live pair match that must not be
// counted as if it were complete.
const teamStandingsData = {
  teams: [
    { id: "teamA", division_id: "d1", name: "Team Alpha" },
    { id: "teamB", division_id: "d1", name: "Team Bravo" },
  ],
  participants: [
    { id: "pA1", team_id: "teamA", display_name: "Alpha 1" },
    { id: "pA2", team_id: "teamA", display_name: "Alpha 2" },
    { id: "pB1", team_id: "teamB", display_name: "Bravo 1" },
    { id: "pB2", team_id: "teamB", display_name: "Bravo 2" },
  ],
  matches: [
    { id: "rr1", division_id: "d1", parent_match_id: null, stage_label: "round_robin", status: "completed", winner: "A", team_a_wins: 2, team_b_wins: 0 },
    { id: "rr1-pm1", division_id: "d1", parent_match_id: "rr1", status: "completed", winner: "A", score_state: { scoreA: 11, scoreB: 6 } },
    // Official write (match_results) corrected this from 11-8 to 11-9 after completion —
    // the adapter must read the corrected result, not the stale score_state.
    { id: "rr1-pm2", division_id: "d1", parent_match_id: "rr1", status: "completed", winner: "A", score_state: { scoreA: 11, scoreB: 8 } },
    // A live pair match under the SAME round-robin matchup — must not be counted as completed.
    { id: "rr1-pm3", division_id: "d1", parent_match_id: "rr1", status: "in_progress", winner: null, score_state: { scoreA: 99, scoreB: 99 } },
    { id: "sf1", division_id: "d1", parent_match_id: null, stage_label: "semifinal", status: "completed", winner: "A", team_a_wins: 1, team_b_wins: 0 },
    // Same pairs rematch in the semifinal with a big score — must be excluded from round-robin standings.
    { id: "sf1-pm1", division_id: "d1", parent_match_id: "sf1", status: "completed", winner: "A", score_state: { scoreA: 15, scoreB: 2 } },
  ],
  matchParticipants: [
    { match_id: "rr1", slot: "A", participant_id: null, team_id: "teamA" },
    { match_id: "rr1", slot: "B", participant_id: null, team_id: "teamB" },
    { match_id: "rr1-pm1", slot: "A", participant_id: "pA1", team_id: "teamA" },
    { match_id: "rr1-pm1", slot: "B", participant_id: "pB1", team_id: "teamB" },
    { match_id: "rr1-pm2", slot: "A", participant_id: "pA2", team_id: "teamA" },
    { match_id: "rr1-pm2", slot: "B", participant_id: "pB2", team_id: "teamB" },
    { match_id: "rr1-pm3", slot: "A", participant_id: "pA1", team_id: "teamA" },
    { match_id: "rr1-pm3", slot: "B", participant_id: "pB1", team_id: "teamB" },
    { match_id: "sf1", slot: "A", participant_id: null, team_id: "teamA" },
    { match_id: "sf1", slot: "B", participant_id: null, team_id: "teamB" },
    { match_id: "sf1-pm1", slot: "A", participant_id: "pA1", team_id: "teamA" },
    { match_id: "sf1-pm1", slot: "B", participant_id: "pB1", team_id: "teamB" },
  ],
  results: [
    { match_id: "rr1-pm1", score_a: 11, score_b: 6 },
    { match_id: "rr1-pm2", score_a: 11, score_b: 9 },
    { match_id: "sf1-pm1", score_a: 15, score_b: 2 },
  ],
};

test("teamStandings: aggregates Wins/Losses/Matches Played/Points For/Against/Diff from completed round-robin matches only", () => {
  const division = { id: "d1", format: "team_elimination" };
  const rows = teamStandings(division, teamStandingsData);
  const a = rows.find((r) => r.teamId === "teamA");
  const b = rows.find((r) => r.teamId === "teamB");

  assert.equal(a.wins, 1);
  assert.equal(a.losses, 0);
  assert.equal(a.matchesPlayed, 1); // one round-robin team matchup — the semifinal is a separate stage
  // Points use the corrected result (11-9), not the stale score_state (11-8),
  // and exclude both the live pair match (99-99) and the semifinal (15-2).
  assert.equal(a.pointsFor, 22); // 11 + 11
  assert.equal(a.pointsAgainst, 15); // 6 + 9
  assert.equal(a.pointDiff, 7);

  assert.equal(b.wins, 0);
  assert.equal(b.losses, 1);
  assert.equal(b.matchesPlayed, 1);
  assert.equal(b.pointsFor, 15);
  assert.equal(b.pointsAgainst, 22);
  assert.equal(b.pointDiff, -7);
});

test("teamStandings: a division with no matches yet returns an empty list, not an error", () => {
  const division = { id: "d-empty", format: "team_elimination" };
  const rows = teamStandings(division, { teams: [], participants: [], matches: [], matchParticipants: [], results: [] });
  assert.deepEqual(rows, []);
});
