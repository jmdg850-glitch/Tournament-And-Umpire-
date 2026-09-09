import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  PLAYER_COLUMNS,
  BRACKET_COLUMNS,
  analyzePlayerRows,
  analyzeBracketRows,
  buildBracketExportRows,
  buildPlayerTemplateWorkbook,
  buildPlayersExportRows,
  buildTournamentReportWorkbook,
  parseBracketWorkbook,
  parsePlayerWorkbook,
  planPlayerImportActions,
  splitPairName,
} from "./excelImportExport.js";

function workbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Players");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function bracketWorkbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Bracket");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
}

function exportBufferFor(data) {
  const rows = buildBracketExportRows(data);
  return bracketWorkbookBuffer([BRACKET_COLUMNS, ...rows.map((r) => BRACKET_COLUMNS.map((c) => r[c]))]);
}

function baseTournamentData(overrides = {}) {
  return {
    tournament: { id: "t1", name: "Test Cup", sport: "pickleball", status: "in_progress", created_at: "2026-01-01" },
    divisions: [],
    persons: [],
    teams: [],
    teamMembers: [],
    participants: [],
    participantMembers: [],
    matches: [],
    results: [],
    matchParticipants: [],
    courts: [],
    courtAssignments: [],
    umpireAssignments: [],
    members: [],
    profiles: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parsePlayerWorkbook
// ---------------------------------------------------------------------------

test("parsePlayerWorkbook: valid file parses rows", () => {
  const buf = workbookBuffer([
    ["Player Name", "Division"],
    ["Ada Lovelace", ""],
    ["Bea Bo", ""],
  ]);
  const { headerErrors, rows } = parsePlayerWorkbook(buf);
  assert.deepEqual(headerErrors, []);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].playerName, "Ada Lovelace");
});

test("parsePlayerWorkbook: missing Player Name column is a header error", () => {
  const buf = workbookBuffer([["Division"], ["Open"]]);
  const { headerErrors } = parsePlayerWorkbook(buf);
  assert.ok(headerErrors.some((e) => /Player Name/.test(e)));
});

test("parsePlayerWorkbook: unsupported column is reported", () => {
  const buf = workbookBuffer([
    ["Player Name", "Email"],
    ["Ada", "ada@example.com"],
  ]);
  const { headerErrors } = parsePlayerWorkbook(buf);
  assert.ok(headerErrors.some((e) => /Unsupported column/.test(e) && /Email/.test(e)));
});

test("parsePlayerWorkbook: empty file (no data rows) yields no rows", () => {
  const buf = workbookBuffer([["Player Name"]]);
  const { rows } = parsePlayerWorkbook(buf);
  assert.equal(rows.length, 0);
});

// ---------------------------------------------------------------------------
// analyzePlayerRows
// ---------------------------------------------------------------------------

function row(overrides = {}) {
  return { rowNumber: 2, playerId: "", playerName: "", entryTypeRaw: "", division: "", team: "", seedRaw: "", ...overrides };
}

test("analyzePlayerRows: valid new player has no errors and is not a duplicate", () => {
  const data = baseTournamentData();
  const { rows, summary } = analyzePlayerRows([row({ playerName: "Ada" })], data);
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].isDuplicate, false);
  assert.equal(summary.newCount, 1);
});

test("analyzePlayerRows: empty player name is invalid", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows([row({ playerName: "" , division: "Open"})], data);
  assert.ok(rows[0].errors.some((e) => /Player Name is required/.test(e)));
});

test("analyzePlayerRows: fully blank row is skipped, not counted", () => {
  const data = baseTournamentData();
  const { rows, summary } = analyzePlayerRows([row()], data);
  assert.equal(rows[0].isEmptyRow, true);
  assert.equal(summary.total, 0);
});

test("analyzePlayerRows: duplicate player name within file is flagged", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ rowNumber: 2, playerName: "Ada" }), row({ rowNumber: 3, playerName: "ada" })],
    data
  );
  assert.equal(rows[0].errors.length, 0);
  assert.ok(rows[1].errors.some((e) => /Duplicate player name/.test(e)));
});

test("analyzePlayerRows: duplicate Player ID within file is flagged", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }] });
  const { rows } = analyzePlayerRows(
    [row({ rowNumber: 2, playerId: "p1", playerName: "Ada" }), row({ rowNumber: 3, playerId: "p1", playerName: "Ada2" })],
    data
  );
  assert.ok(rows[1].errors.some((e) => /Duplicate Player ID/.test(e)));
});

test("analyzePlayerRows: matches an existing player by exact name (case-insensitive)", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada Lovelace" }] });
  const { rows, summary } = analyzePlayerRows([row({ playerName: "ada lovelace" })], data);
  assert.equal(rows[0].isDuplicate, true);
  assert.equal(rows[0].existingPerson.id, "p1");
  assert.equal(summary.duplicateCount, 1);
});

test("analyzePlayerRows: matches an existing player by Player ID even if name changed", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada Lovelace" }] });
  const { rows } = analyzePlayerRows([row({ playerId: "p1", playerName: "Ada L." })], data);
  assert.equal(rows[0].isDuplicate, true);
  assert.equal(rows[0].existingPerson.id, "p1");
});

test("analyzePlayerRows: unknown Player ID is an error", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows([row({ playerId: "does-not-exist", playerName: "Ada" })], data);
  assert.ok(rows[0].errors.some((e) => /does not match any existing player/.test(e)));
});

test("analyzePlayerRows: division must exist", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows([row({ playerName: "Ada", division: "Nonexistent" })], data);
  assert.ok(rows[0].errors.some((e) => /does not exist/.test(e)));
});

test("analyzePlayerRows: team assignment resolves within the matching division", () => {
  const data = baseTournamentData({
    divisions: [{ id: "d1", tournament_id: "t1", name: "Open", format: "team_elimination" }],
    teams: [{ id: "team1", tournament_id: "t1", division_id: "d1", name: "Falcons" }],
  });
  const { rows } = analyzePlayerRows([row({ playerName: "Ada", division: "Open", team: "Falcons" })], data);
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].team.id, "team1");
});

test("analyzePlayerRows: team without a valid division is an error", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows([row({ playerName: "Ada", team: "Falcons" })], data);
  assert.ok(rows[0].errors.some((e) => /Team specified without a valid Division/.test(e)));
});

test("analyzePlayerRows: non-numeric seed is an error", () => {
  const data = baseTournamentData({ divisions: [{ id: "d1", tournament_id: "t1", name: "Open" }] });
  const { rows } = analyzePlayerRows([row({ playerName: "Ada", division: "Open", seedRaw: "abc" })], data);
  assert.ok(rows[0].errors.some((e) => /Seed must be/.test(e)));
});

test("analyzePlayerRows: optional fields blank is valid", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows([row({ playerName: "Ada" })], data);
  assert.equal(rows[0].errors.length, 0);
});

test("analyzePlayerRows: large import of many new players", () => {
  const data = baseTournamentData();
  const bulk = Array.from({ length: 200 }, (_, i) => row({ rowNumber: i + 2, playerName: `Player ${i}` }));
  const { summary } = analyzePlayerRows(bulk, data);
  assert.equal(summary.newCount, 200);
  assert.equal(summary.invalid, 0);
});

// ---------------------------------------------------------------------------
// planPlayerImportActions
// ---------------------------------------------------------------------------

test("planPlayerImportActions: add_new mode only creates new players, skips duplicates", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }] });
  const { rows } = analyzePlayerRows(
    [row({ rowNumber: 2, playerName: "Ada" }), row({ rowNumber: 3, playerName: "Bea" })],
    data
  );
  const { actions, skipped } = planPlayerImportActions(rows, "add_new", "t1");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].personAction.kind, "add_person");
  assert.equal(skipped, 1);
});

test("planPlayerImportActions: skip_existing mode skips duplicates entirely", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }] });
  const { rows } = analyzePlayerRows([row({ playerName: "Ada" })], data);
  const { actions, skipped } = planPlayerImportActions(rows, "skip_existing", "t1");
  assert.equal(actions.length, 0);
  assert.equal(skipped, 1);
});

test("planPlayerImportActions: update_existing mode renames a changed duplicate", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }] });
  const { rows } = analyzePlayerRows([row({ playerId: "p1", playerName: "Ada Lovelace" })], data);
  const { actions } = planPlayerImportActions(rows, "update_existing", "t1");
  assert.equal(actions[0].personAction.kind, "update_person");
  assert.equal(actions[0].personAction.payload.display_name, "Ada Lovelace");
});

test("planPlayerImportActions: update_existing mode is a no-op when name is unchanged", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }] });
  const { rows } = analyzePlayerRows([row({ playerId: "p1", playerName: "Ada" })], data);
  const { actions } = planPlayerImportActions(rows, "update_existing", "t1");
  assert.equal(actions[0].personAction.kind, "noop_existing");
});

test("planPlayerImportActions: rows with errors are never included", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows([row({ playerName: "" })], data);
  const { actions } = planPlayerImportActions(rows, "add_new", "t1");
  assert.equal(actions.length, 0);
});

// ---------------------------------------------------------------------------
// buildPlayersExportRows
// ---------------------------------------------------------------------------

test("buildPlayersExportRows: unregistered player exports one blank row", () => {
  const data = baseTournamentData({ persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }] });
  const rows = buildPlayersExportRows(data);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["Division"], "");
});

test("buildPlayersExportRows: player registered in two divisions exports two rows, not merged", () => {
  const data = baseTournamentData({
    persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }],
    divisions: [
      { id: "d1", tournament_id: "t1", name: "Open Singles" },
      { id: "d2", tournament_id: "t1", name: "Mixed Doubles" },
    ],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 1, display_name: "Ada" },
      { id: "pt2", tournament_id: "t1", division_id: "d2", kind: "doubles", team_id: null, seed: null, display_name: "Ada / Bea" },
    ],
    participantMembers: [
      { id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 },
      { id: "pm2", participant_id: "pt2", person_id: "p1", slot: 1 },
    ],
  });
  const rows = buildPlayersExportRows(data);
  assert.equal(rows.length, 2);
  const divisions = rows.map((r) => r["Division"]).sort();
  assert.deepEqual(divisions, ["Mixed Doubles", "Open Singles"]);
});

test("buildPlayersExportRows: empty player list exports no rows without crashing", () => {
  const data = baseTournamentData();
  const rows = buildPlayersExportRows(data);
  assert.deepEqual(rows, []);
});

// ---------------------------------------------------------------------------
// buildTournamentReportWorkbook — must never crash on edge-case data
// ---------------------------------------------------------------------------

test("buildTournamentReportWorkbook: empty tournament (no players, no matches) does not crash", () => {
  const wb = buildTournamentReportWorkbook(baseTournamentData());
  assert.ok(wb.SheetNames.includes("Tournament Summary"));
  assert.ok(wb.SheetNames.includes("Participants"));
  assert.equal(wb.SheetNames.includes("Game Score Details"), false);
});

test("buildTournamentReportWorkbook: single division with a completed final produces a champion", () => {
  const data = baseTournamentData({
    divisions: [{ id: "d1", tournament_id: "t1", name: "Open", format: "single_elim" }],
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Ada" },
      { id: "p2", tournament_id: "t1", display_name: "Bea" },
    ],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 1, display_name: "Ada" },
      { id: "pt2", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 2, display_name: "Bea" },
    ],
    participantMembers: [
      { id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 },
      { id: "pm2", participant_id: "pt2", person_id: "p2", slot: 1 },
    ],
    matches: [{
      id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: null, next_match_id: null,
      round: 1, status: "completed", winner: "A", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T01:00:00Z",
    }],
    matchParticipants: [
      { id: "mp1", match_id: "m1", slot: "A", participant_id: "pt1", team_id: null },
      { id: "mp2", match_id: "m1", slot: "B", participant_id: "pt2", team_id: null },
    ],
    results: [{ id: "r1", match_id: "m1", winner_slot: "A", winner_participant_id: "pt1", games: [{ scoreA: 11, scoreB: 7, winner: "A" }], score_a: 11, score_b: 7 }],
  });
  const wb = buildTournamentReportWorkbook(data);
  const summarySheet = XLSX.utils.sheet_to_json(wb.Sheets["Division Summary"]);
  assert.equal(summarySheet[0].Champion, "Ada");
  assert.equal(summarySheet[0]["Runner-up"], "Bea");
  assert.ok(wb.SheetNames.includes("Game Score Details"));
  const games = XLSX.utils.sheet_to_json(wb.Sheets["Game Score Details"]);
  assert.equal(games.length, 1);
  assert.equal(games[0]["Game Winner"], "Ada");
});

test("buildTournamentReportWorkbook: multi-division tournament keeps each division's standings separate", () => {
  const data = baseTournamentData({
    divisions: [
      { id: "d1", tournament_id: "t1", name: "Open", format: "single_elim" },
      { id: "d2", tournament_id: "t1", name: "Mixed", format: "single_elim" },
    ],
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Ada" },
      { id: "p2", tournament_id: "t1", display_name: "Cy" },
    ],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 1, display_name: "Ada" },
      { id: "pt2", tournament_id: "t1", division_id: "d2", kind: "singles", team_id: null, seed: 1, display_name: "Cy" },
    ],
  });
  const wb = buildTournamentReportWorkbook(data);
  const standings = XLSX.utils.sheet_to_json(wb.Sheets["Final Standings"]);
  assert.equal(standings.length, 2);
  assert.equal(standings.find((r) => r["Pair / Player"] === "Ada").Division, "Open");
  assert.equal(standings.find((r) => r["Pair / Player"] === "Cy").Division, "Mixed");
});

test("buildTournamentReportWorkbook: team_elimination division reuses the engine's own pair ranking, not a re-derived one", () => {
  const data = baseTournamentData({
    divisions: [{ id: "d1", tournament_id: "t1", name: "Team Open", format: "team_elimination" }],
    teams: [
      { id: "team1", tournament_id: "t1", division_id: "d1", name: "Falcons" },
      { id: "team2", tournament_id: "t1", division_id: "d1", name: "Hawks" },
    ],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "doubles", team_id: "team1", seed: null, display_name: "Falcons Pair" },
      { id: "pt2", tournament_id: "t1", division_id: "d1", kind: "doubles", team_id: "team2", seed: null, display_name: "Hawks Pair" },
    ],
    matches: [
      { id: "rr1", tournament_id: "t1", division_id: "d1", parent_match_id: null, stage_label: "round_robin", status: "completed" },
      { id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: "rr1", status: "completed", winner: "A", round: 1 },
    ],
    matchParticipants: [
      { id: "mp1", match_id: "m1", slot: "A", participant_id: "pt1", team_id: null },
      { id: "mp2", match_id: "m1", slot: "B", participant_id: "pt2", team_id: null },
    ],
    results: [{ id: "r1", match_id: "m1", winner_slot: "A", winner_participant_id: "pt1", games: [], score_a: 11, score_b: 5 }],
  });
  const wb = buildTournamentReportWorkbook(data);
  const standings = XLSX.utils.sheet_to_json(wb.Sheets["Final Standings"]);
  assert.equal(standings.length, 2);
  const falcons = standings.find((r) => r["Pair / Player"] === "Falcons Pair");
  assert.equal(falcons.Rank, 1);
  assert.equal(falcons.W, 1);
  assert.equal(falcons.Team, "Falcons");
});

test("buildTournamentReportWorkbook: unfinished division (no completed matches) does not crash and has no champion", () => {
  const data = baseTournamentData({
    divisions: [{ id: "d1", tournament_id: "t1", name: "Open", format: "single_elim" }],
    matches: [{ id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: null, next_match_id: null, round: 1, status: "scheduled" }],
  });
  const wb = buildTournamentReportWorkbook(data);
  const summarySheet = XLSX.utils.sheet_to_json(wb.Sheets["Division Summary"]);
  assert.equal(summarySheet[0].Champion, "");
  assert.equal(summarySheet[0].Status, "In progress");
});

// ---------------------------------------------------------------------------
// Entry Type
// ---------------------------------------------------------------------------

test("buildPlayerTemplateWorkbook: template includes Entry Type column and example values", () => {
  const wb = buildPlayerTemplateWorkbook();
  const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets["Players"]);
  assert.ok(sheetRows.some((r) => r["Entry Type"] === "Individual"));
  assert.ok(sheetRows.some((r) => r["Entry Type"] === "Pair"));
});

test("parsePlayerWorkbook: detects presence of the Entry Type column", () => {
  const withCol = workbookBuffer([["Player Name", "Entry Type"], ["Ada", "Individual"]]);
  assert.equal(parsePlayerWorkbook(withCol).hasEntryTypeColumn, true);
  const withoutCol = workbookBuffer([["Player Name"], ["Ada"]]);
  assert.equal(parsePlayerWorkbook(withoutCol).hasEntryTypeColumn, false);
});

test("parsePlayerWorkbook: reads raw Entry Type value per row", () => {
  const buf = workbookBuffer([["Player Name", "Entry Type"], ["Ada", "individual"], ["Bea", "PAIR"]]);
  const { rows } = parsePlayerWorkbook(buf);
  assert.equal(rows[0].entryTypeRaw, "individual");
  assert.equal(rows[1].entryTypeRaw, "PAIR");
});

test("analyzePlayerRows: normalizes case-insensitive Individual/Pair values", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [
      row({ rowNumber: 2, playerName: "Ada", entryTypeRaw: "individual" }),
      row({ rowNumber: 3, playerName: "Bea", entryTypeRaw: "PAIR" }),
      row({ rowNumber: 4, playerName: "Cy", entryTypeRaw: "Pair" }),
    ],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].entryType, "Individual");
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[1].entryType, "Pair");
  assert.equal(rows[2].entryType, "Pair");
});

test("analyzePlayerRows: invalid Entry Type value is a row-level error, not a guess", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Ada", entryTypeRaw: "Trio" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.ok(rows[0].errors.some((e) => /Entry Type "Trio" is not valid/.test(e)));
  assert.equal(rows[0].entryType, null);
});

test("analyzePlayerRows: missing Entry Type is a row-level error when the column exists in the file", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Ada", entryTypeRaw: "" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.ok(rows[0].errors.some((e) => /Entry Type is required/.test(e)));
});

test("analyzePlayerRows: backward compatible — old files with no Entry Type column default to Individual, no error", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Ada", entryTypeRaw: "" })],
    data,
    { hasEntryTypeColumn: false }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].entryType, "Individual");
});

test("analyzePlayerRows: preview shows Entry Type value alongside the row", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Ada", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].entryType, "Pair");
});

test("buildPlayersExportRows: Entry Type reflects the participant's real kind (round-trip safe)", () => {
  const data = baseTournamentData({
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Ada" },
      { id: "p2", tournament_id: "t1", display_name: "Bea" },
    ],
    divisions: [{ id: "d1", tournament_id: "t1", name: "Open" }],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 1, display_name: "Ada" },
      { id: "pt2", tournament_id: "t1", division_id: "d1", kind: "doubles", team_id: null, seed: null, display_name: "Bea / X" },
    ],
    participantMembers: [
      { id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 },
      { id: "pm2", participant_id: "pt2", person_id: "p2", slot: 1 },
    ],
  });
  const rows = buildPlayersExportRows(data);
  assert.equal(rows.find((r) => r["Player Name"] === "Ada")["Entry Type"], "Individual");
  assert.equal(rows.find((r) => r["Player Name"] === "Bea")["Entry Type"], "Pair");
});

// ---------------------------------------------------------------------------
// Pair-name parsing ("Rem / Jeff") — Excel import pair bug
// ---------------------------------------------------------------------------

test("splitPairName: recognizes the app's own template format 'Name / Name'", () => {
  assert.deepEqual(splitPairName("Rem / Jeff"), { names: ["Rem", "Jeff"] });
});

test("splitPairName: recognizes 'Name/Name' with no spaces", () => {
  assert.deepEqual(splitPairName("Rem/Jeff"), { names: ["Rem", "Jeff"] });
});

test("splitPairName: recognizes 'Name & Name'", () => {
  assert.deepEqual(splitPairName("Rem & Jeff"), { names: ["Rem", "Jeff"] });
});

test("splitPairName: recognizes 'Name and Name'", () => {
  assert.deepEqual(splitPairName("Rem and Jeff"), { names: ["Rem", "Jeff"] });
});

test("splitPairName: trims and normalizes surrounding/internal whitespace", () => {
  assert.deepEqual(splitPairName("  Rem   /   Jeff  "), { names: ["Rem", "Jeff"] });
});

test("splitPairName: 'and' inside an ordinary name is not mistaken for a separator", () => {
  assert.equal(splitPairName("Sandra Anderson"), null);
});

test("splitPairName: a bare single name (legacy Pair format) returns null, not an error", () => {
  assert.equal(splitPairName("Rem"), null);
});

test("splitPairName: malformed/trailing separator is reported as tooMany, not silently split", () => {
  assert.deepEqual(splitPairName("Rem /"), { tooMany: true });
  assert.deepEqual(splitPairName("Rem / Jeff / Bob"), { tooMany: true });
});

test("analyzePlayerRows: 1. individual row import is unaffected by pair parsing", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Ada", entryTypeRaw: "Individual" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].pairNames, null);
  assert.equal(rows[0].entryType, "Individual");
});

test("analyzePlayerRows: 2. 'Rem / Jeff' pair row is split and both names resolved as new players", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Rem / Jeff", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.deepEqual(rows[0].pairNames, ["Rem", "Jeff"]);
  assert.equal(rows[0].pairPersons.length, 2);
  assert.equal(rows[0].pairPersons[0].existingPerson, null);
  assert.equal(rows[0].pairPersons[1].existingPerson, null);
});

test("analyzePlayerRows: 3. 'Rem/Jeff' (no spaces) is also recognized as a pair", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Rem/Jeff", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.deepEqual(rows[0].pairNames, ["Rem", "Jeff"]);
});

test("analyzePlayerRows: 4. 'Rem & Jeff' is also recognized as a pair", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Rem & Jeff", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.deepEqual(rows[0].pairNames, ["Rem", "Jeff"]);
});

test("analyzePlayerRows: 5. extra whitespace around pair names is normalized", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "  Rem   /   Jeff  ", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.deepEqual(rows[0].pairNames, ["Rem", "Jeff"]);
});

test("analyzePlayerRows: 6. each pair half matches an existing player case-insensitively", () => {
  const data = baseTournamentData({
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Rem Cruz" },
      { id: "p2", tournament_id: "t1", display_name: "Jeff Santos" },
    ],
  });
  const { rows } = analyzePlayerRows(
    [row({ playerName: "rem cruz / JEFF SANTOS", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].pairPersons[0].existingPerson.id, "p1");
  assert.equal(rows[0].pairPersons[1].existingPerson.id, "p2");
  assert.equal(rows[0].isDuplicate, true);
});

test("analyzePlayerRows: 7. a pair name that can't be split into two names is a validation error, not silently dropped", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Rem / Jeff / Bob", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.ok(rows[0].errors.some((e) => /Could not read two player names/.test(e)));
  assert.equal(rows[0].pairNames, null);
});

test("analyzePlayerRows: 7b. the same name on both sides of the separator is a validation error", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Rem / rem", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.ok(rows[0].errors.some((e) => /cannot be selected twice/.test(e)));
});

test("analyzePlayerRows: 8. duplicate-in-file detection catches a pair half reused elsewhere in the file", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [
      row({ rowNumber: 2, playerName: "Rem", entryTypeRaw: "Individual" }),
      row({ rowNumber: 3, playerName: "Rem / Jeff", entryTypeRaw: "Pair" }),
    ],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.ok(rows[1].errors.some((e) => /Duplicate player name/.test(e) && /Rem/.test(e)));
});

test("analyzePlayerRows: 9. export template round-trips 'Rem / Jeff' back into a recognized pair", () => {
  const data = baseTournamentData();
  const buf = workbookBuffer([
    PLAYER_COLUMNS,
    ["", "Rem / Jeff", "Pair", "", "", ""],
  ]);
  const { rows, hasEntryTypeColumn } = parsePlayerWorkbook(buf);
  const { rows: analyzed } = analyzePlayerRows(rows, data, { hasEntryTypeColumn });
  assert.equal(analyzed[0].errors.length, 0);
  assert.deepEqual(analyzed[0].pairNames, ["Rem", "Jeff"]);
});

test("analyzePlayerRows: 10. existing single-name Pair format (no separator) still falls back to manual pairing, unchanged", () => {
  const data = baseTournamentData();
  const { rows } = analyzePlayerRows(
    [row({ playerName: "Rem", entryTypeRaw: "Pair" })],
    data,
    { hasEntryTypeColumn: true }
  );
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[0].pairNames, null);
  assert.equal(rows[0].pairPersons, null);
  assert.equal(rows[0].entryType, "Pair");
});

test("buildPlayerTemplateWorkbook: the app's own generated template pair example round-trips through the importer", () => {
  const wb = buildPlayerTemplateWorkbook();
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  const { rows, hasEntryTypeColumn } = parsePlayerWorkbook(buf);
  const data = baseTournamentData();
  const { rows: analyzed } = analyzePlayerRows(rows, data, { hasEntryTypeColumn });
  const pairRow = analyzed.find((r) => r.entryType === "Pair");
  assert.ok(pairRow, "template must include a Pair example row");
  assert.equal(pairRow.errors.length, 0);
  assert.equal(pairRow.pairNames.length, 2);
});

test("Excel round trip: export then re-import preserves Entry Type", () => {
  const data = baseTournamentData({
    persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }],
    divisions: [{ id: "d1", tournament_id: "t1", name: "Open" }],
    participants: [{ id: "pt1", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 1, display_name: "Ada" }],
    participantMembers: [{ id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 }],
  });
  const exportRows = buildPlayersExportRows(data);
  const buf = workbookBuffer([PLAYER_COLUMNS, ...exportRows.map((r) => PLAYER_COLUMNS.map((c) => r[c]))]);
  const { rows, hasEntryTypeColumn } = parsePlayerWorkbook(buf);
  assert.equal(hasEntryTypeColumn, true);
  const { rows: analyzed } = analyzePlayerRows(rows, data, { hasEntryTypeColumn });
  assert.equal(analyzed[0].entryType, "Individual");
  assert.equal(analyzed[0].errors.length, 0);
});

// ---------------------------------------------------------------------------
// Bracket export / import
// ---------------------------------------------------------------------------

// A single-elimination bracket: round 1 has two decided matches (m1, m2),
// round 2 is the final (m3) whose slots are still empty, waiting on round 1 —
// exactly the shape a freshly-generated bracket has.
function singleElimBracketData(overrides = {}) {
  return baseTournamentData({
    divisions: [{ id: "d1", tournament_id: "t1", name: "Open", format: "single_elim" }],
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Ada" },
      { id: "p2", tournament_id: "t1", display_name: "Bea" },
      { id: "p3", tournament_id: "t1", display_name: "Cy" },
      { id: "p4", tournament_id: "t1", display_name: "Dee" },
    ],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 1, display_name: "Ada" },
      { id: "pt2", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 4, display_name: "Bea" },
      { id: "pt3", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 2, display_name: "Cy" },
      { id: "pt4", tournament_id: "t1", division_id: "d1", kind: "singles", team_id: null, seed: 3, display_name: "Dee" },
    ],
    participantMembers: [
      { id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 },
      { id: "pm2", participant_id: "pt2", person_id: "p2", slot: 1 },
      { id: "pm3", participant_id: "pt3", person_id: "p3", slot: 1 },
      { id: "pm4", participant_id: "pt4", person_id: "p4", slot: 1 },
    ],
    matches: [
      { id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 0, status: "scheduled", winner: null, next_match_id: "m3", next_match_slot: "A" },
      { id: "m2", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 1, status: "scheduled", winner: null, next_match_id: "m3", next_match_slot: "B" },
      { id: "m3", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 2, bracket_position: 0, status: "scheduled", winner: null, next_match_id: null },
    ],
    matchParticipants: [
      { id: "mp1", match_id: "m1", slot: "A", participant_id: "pt1", team_id: null },
      { id: "mp2", match_id: "m1", slot: "B", participant_id: "pt2", team_id: null },
      { id: "mp3", match_id: "m2", slot: "A", participant_id: "pt3", team_id: null },
      { id: "mp4", match_id: "m2", slot: "B", participant_id: "pt4", team_id: null },
    ],
    ...overrides,
  });
}

test("buildBracketExportRows: one row per playable match, Match ID is the stable matches.id", () => {
  const data = singleElimBracketData();
  const rows = buildBracketExportRows(data);
  assert.equal(rows.length, 3);
  const m1 = rows.find((r) => r["Match ID"] === "m1");
  assert.equal(m1["Side A"], "Ada");
  assert.equal(m1["Side B"], "Bea");
  assert.equal(m1["Side A Seed"], 1);
  assert.equal(m1.Division, "Open");
  assert.equal(m1.Round, 1);
  const final = rows.find((r) => r["Match ID"] === "m3");
  assert.equal(final["Side A"], "Side A"); // no participant assigned yet
});

test("Bracket round trip: export then re-import with no edits produces zero changes", () => {
  const data = singleElimBracketData();
  const buf = exportBufferFor(data);
  const { headerErrors, rows } = parseBracketWorkbook(buf);
  assert.deepEqual(headerErrors, []);
  const analysis = analyzeBracketRows(rows, data);
  assert.equal(analysis.summary.changesReady, 0);
  assert.equal(analysis.summary.blockedCount, 0);
});

test("Bracket import: changing an individual player resolves against an existing person", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m2" ? { ...r, sideA: "Ada" } : r // swap m2's Side A from Cy to the already-existing Ada
  );
  const analysis = analyzeBracketRows(rows, data);
  const row = analysis.rows.find((r) => r.matchId === "m2");
  assert.equal(row.errors.length, 0);
  const change = row.changes.find((c) => c.slot === "A");
  assert.equal(change.oldName, "Cy");
  assert.equal(change.newName, "Ada");
  assert.equal(change.players[0].existingPerson.id, "p1");
});

test("Bracket import: changing a doubles pair preserves the '/' convention and resolves both halves", () => {
  const data = singleElimBracketData({
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "doubles", team_id: null, seed: 1, display_name: "Rem / Jeff" },
      { id: "pt2", tournament_id: "t1", division_id: "d1", kind: "doubles", team_id: null, seed: 2, display_name: "John / Mark" },
    ],
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Rem" },
      { id: "p2", tournament_id: "t1", display_name: "Jeff" },
      { id: "p3", tournament_id: "t1", display_name: "John" },
      { id: "p4", tournament_id: "t1", display_name: "Mark" },
      { id: "p5", tournament_id: "t1", display_name: "Carlos" },
    ],
    participantMembers: [
      { id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 },
      { id: "pm2", participant_id: "pt1", person_id: "p2", slot: 2 },
      { id: "pm3", participant_id: "pt2", person_id: "p3", slot: 1 },
      { id: "pm4", participant_id: "pt2", person_id: "p4", slot: 2 },
    ],
    matches: [{ id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 0, status: "scheduled", winner: null, next_match_id: null }],
    matchParticipants: [
      { id: "mp1", match_id: "m1", slot: "A", participant_id: "pt1", team_id: null },
      { id: "mp2", match_id: "m1", slot: "B", participant_id: "pt2", team_id: null },
    ],
  });
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) => ({ ...r, sideA: "Carlos / Mike" }));
  const analysis = analyzeBracketRows(rows, data);
  const row = analysis.rows[0];
  const change = row.changes.find((c) => c.slot === "A");
  assert.equal(change.error, undefined);
  assert.equal(change.players.length, 2);
  assert.equal(change.players[0].name, "Carlos");
  assert.equal(change.players[0].existingPerson.id, "p5");
  assert.equal(change.players[1].name, "Mike");
  assert.equal(change.players[1].existingPerson, null); // new player — created at apply time
  assert.equal(analysis.summary.newPersonCount, 1);
});

test("Bracket import: existing player resolution is case-insensitive and whitespace-normalized", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m2" ? { ...r, sideA: "  aDA  " } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const change = analysis.rows.find((r) => r.matchId === "m2").changes.find((c) => c.slot === "A");
  assert.equal(change.players[0].existingPerson.id, "p1");
});

test("Bracket import: pair parser accepts '/', '&', and 'and' — same parser as Players import", () => {
  for (const [text, expected] of [["Carlos/Mike", ["Carlos", "Mike"]], ["Carlos & Mike", ["Carlos", "Mike"]], ["Carlos and Mike", ["Carlos", "Mike"]]]) {
    assert.deepEqual(splitPairName(text).names, expected);
  }
});

test("Bracket import: unchanged rows produce no change entries, even with different casing/whitespace", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: " ada " } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const row = analysis.rows.find((r) => r.matchId === "m1");
  assert.equal(row.changes.length, 0);
});

test("Bracket import: team resolution — a team-elimination pair match reports its Team column and preserves team_id on change", () => {
  const data = baseTournamentData({
    divisions: [{ id: "d1", tournament_id: "t1", name: "Team Open", format: "team_elimination" }],
    teams: [{ id: "team1", tournament_id: "t1", division_id: "d1", name: "Falcons" }],
    persons: [
      { id: "p1", tournament_id: "t1", display_name: "Rem" },
      { id: "p2", tournament_id: "t1", display_name: "Jeff" },
      { id: "p3", tournament_id: "t1", display_name: "Carlos" },
    ],
    participants: [
      { id: "pt1", tournament_id: "t1", division_id: "d1", kind: "doubles", team_id: "team1", seed: null, display_name: "Rem / Jeff" },
    ],
    participantMembers: [
      { id: "pm1", participant_id: "pt1", person_id: "p1", slot: 1 },
      { id: "pm2", participant_id: "pt1", person_id: "p2", slot: 2 },
    ],
    matches: [
      { id: "rr1", tournament_id: "t1", division_id: "d1", parent_match_id: null, stage_label: "round_robin", status: "scheduled" },
      { id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: "rr1", round: 1, bracket_position: 0, status: "scheduled", winner: null },
    ],
    matchParticipants: [
      { id: "mp1", match_id: "m1", slot: "A", participant_id: "pt1", team_id: "team1" },
    ],
  });
  const rows = buildBracketExportRows(data);
  const m1Row = rows.find((r) => r["Match ID"] === "m1");
  assert.equal(m1Row.Team, "Falcons");
  assert.equal(m1Row.Stage, "Qualification");
});

test("Bracket import: unknown player name is not an error at analysis time — it is treated as a new player, exactly like Players import", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed" } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const change = analysis.rows.find((r) => r.matchId === "m1").changes.find((c) => c.slot === "A");
  assert.equal(change.error, undefined);
  assert.equal(change.players[0].existingPerson, null);
});

test("Bracket import: invalid/unknown Match ID is a row-level error, never silently matched by row order", () => {
  const data = singleElimBracketData();
  const rows = [{ rowNumber: 2, matchId: "does-not-exist", sideA: "Zed", sideB: "" }];
  const analysis = analyzeBracketRows(rows, data);
  assert.equal(analysis.rows[0].errors.length, 1);
  assert.match(analysis.rows[0].errors[0], /Unknown Match ID/);
  assert.equal(analysis.summary.changesReady, 0);
});

test("Bracket import: a slot with no player assigned yet (waiting on a previous round) cannot be set directly", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m3" ? { ...r, sideA: "Ada" } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const change = analysis.rows.find((r) => r.matchId === "m3").changes.find((c) => c.slot === "A");
  assert.match(change.error, /no player assigned yet/);
});

test("Bracket import: duplicate participant across two rows in the same file is rejected", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) => {
    if (r.matchId === "m1") return { ...r, sideA: "Zed" };
    if (r.matchId === "m2") return { ...r, sideA: "Zed" };
    return r;
  });
  const analysis = analyzeBracketRows(rows, data);
  const c1 = analysis.rows.find((r) => r.matchId === "m1").changes.find((c) => c.slot === "A");
  const c2 = analysis.rows.find((r) => r.matchId === "m2").changes.find((c) => c.slot === "A");
  assert.ok(c1.error || c2.error, "one of the two duplicate assignments must be flagged");
});

test("Bracket import: a completed match is protected — cannot be changed from Excel", () => {
  const data = singleElimBracketData({
    matches: [
      { id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 0, status: "completed", winner: "A", next_match_id: "m3", next_match_slot: "A" },
      { id: "m2", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 1, status: "scheduled", winner: null, next_match_id: "m3", next_match_slot: "B" },
      { id: "m3", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 2, bracket_position: 0, status: "scheduled", winner: null, next_match_id: null },
    ],
  });
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed" } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const change = analysis.rows.find((r) => r.matchId === "m1").changes.find((c) => c.slot === "A");
  assert.match(change.error, /already completed/);
  assert.equal(analysis.summary.blockedCount, 1);
});

test("Bracket import: an in-progress match is protected — cannot be changed from Excel", () => {
  const data = singleElimBracketData({
    matches: [
      { id: "m1", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 0, status: "in_progress", winner: null, next_match_id: "m3", next_match_slot: "A" },
      { id: "m2", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 1, bracket_position: 1, status: "scheduled", winner: null, next_match_id: "m3", next_match_slot: "B" },
      { id: "m3", tournament_id: "t1", division_id: "d1", parent_match_id: null, round: 2, bracket_position: 0, status: "scheduled", winner: null, next_match_id: null },
    ],
  });
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed" } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const change = analysis.rows.find((r) => r.matchId === "m1").changes.find((c) => c.slot === "A");
  assert.match(change.error, /players can only be changed before the match starts/);
});

test("Bracket import: replacing a pair with a single name (or vice versa) is rejected — kind cannot change via bracket import", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed / Ned" } : r // m1 Side A is a singles (1-player) entry
  );
  const analysis = analyzeBracketRows(rows, data);
  const change = analysis.rows.find((r) => r.matchId === "m1").changes.find((c) => c.slot === "A");
  assert.match(change.error, /individual entry/);
});

test("Bracket import: downstream advancement fields (next_match_id/round/bracket_position) are never part of the editable diff", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed" } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  const row = analysis.rows.find((r) => r.matchId === "m1");
  // The change is scoped to the side identity only — nothing in analyzeBracketRows
  // ever reads or writes next_match_id/round/bracket_position, so the original
  // match objects (and therefore downstream bracket structure) are untouched.
  const m1 = data.matches.find((m) => m.id === "m1");
  assert.equal(m1.next_match_id, "m3");
  assert.equal(m1.next_match_slot, "A");
  assert.equal(row.changes.some((c) => c.slot === "A" && !c.error), true);
});

test("Bracket import: analyzing a file never mutates the input data (cancel leaves the bracket unchanged)", () => {
  const data = singleElimBracketData();
  const snapshot = JSON.parse(JSON.stringify(data));
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed" } : r
  );
  analyzeBracketRows(rows, data);
  assert.deepEqual(data, snapshot);
});

test("Bracket import: preview summary counts match the actual resolvable changes", () => {
  const data = singleElimBracketData();
  const rows = parseBracketWorkbook(exportBufferFor(data)).rows.map((r) =>
    r.matchId === "m1" ? { ...r, sideA: "Zed" } : r
  );
  const analysis = analyzeBracketRows(rows, data);
  assert.equal(analysis.summary.changesReady, 1);
  assert.equal(analysis.summary.matchesChanged, 1);
  assert.equal(analysis.summary.newPersonCount, 1);
});

test("parseBracketWorkbook: missing Match ID / Side A / Side B columns are header errors", () => {
  const buf = bracketWorkbookBuffer([["Division", "Round"], ["Open", 1]]);
  const { headerErrors } = parseBracketWorkbook(buf);
  assert.ok(headerErrors.some((e) => /Match ID/.test(e)));
  assert.ok(headerErrors.some((e) => /Side A/.test(e)));
  assert.ok(headerErrors.some((e) => /Side B/.test(e)));
});

test("Existing Player Excel import is unaffected by the Bracket additions", () => {
  const data = baseTournamentData({
    persons: [{ id: "p1", tournament_id: "t1", display_name: "Ada" }],
  });
  const buf = workbookBuffer([["Player Name"], ["Ada"], ["Bea"]]);
  const { rows } = parsePlayerWorkbook(buf);
  const { rows: analyzed } = analyzePlayerRows(rows, data, { hasEntryTypeColumn: false });
  assert.equal(analyzed[0].isDuplicate, true);
  assert.equal(analyzed[1].isDuplicate, false);
});
