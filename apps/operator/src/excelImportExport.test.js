import { test } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  PLAYER_COLUMNS,
  analyzePlayerRows,
  buildPlayerTemplateWorkbook,
  buildPlayersExportRows,
  buildTournamentReportWorkbook,
  parsePlayerWorkbook,
  planPlayerImportActions,
} from "./excelImportExport.js";

function workbookBuffer(rows) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Players");
  return XLSX.write(wb, { bookType: "xlsx", type: "array" });
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
