// Excel import/export adapters for Players and the Tournament Report.
//
// This module never invents data: it reads from the same `data` object the
// desk panels render from, and reuses the same helpers (sideOf/scoreLine/
// resultFor/stageTitle) and the same domain engine (rankIndividualPairsForSemifinals)
// that the UI already uses, so exported values match what the app displays.
import * as XLSX from "xlsx";
import {
  courtFor,
  finalMatchOf,
  membersOfParticipant,
  personLabel,
  placementsForDivision,
  playableMatches,
  resultFor,
  scoreLine,
  sideOf,
  stageTitle,
  teamEliminationStandings,
  umpireFor,
} from "./lib.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function normalizeName(value) {
  return String(value ?? "").trim();
}

function normKey(value) {
  return normalizeName(value).toLowerCase();
}

function autoSizeColumns(rows, headers) {
  return headers.map((h) => {
    let max = String(h).length;
    for (const r of rows) {
      const v = r[h];
      if (v == null) continue;
      max = Math.max(max, String(v).length);
    }
    return { wch: Math.min(Math.max(max + 2, 8), 48) };
  });
}

function sheetFromRows(rows, headers) {
  const ws = XLSX.utils.json_to_sheet(rows, { header: headers });
  ws["!cols"] = autoSizeColumns(rows, headers);
  if (rows.length) {
    ws["!autofilter"] = {
      ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: headers.length - 1 } }),
    };
  }
  return ws;
}

export function downloadWorkbook(workbook, filename) {
  const arrayBuffer = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([arrayBuffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function safeFileNamePart(name) {
  return String(name || "Tournament").replace(/[\\/:*?"<>|]+/g, " ").trim().replace(/\s+/g, "_") || "Tournament";
}

// ---------------------------------------------------------------------------
// Players — template / export
// ---------------------------------------------------------------------------

export const PLAYER_COLUMNS = ["Player ID", "Player Name", "Entry Type", "Division", "Team", "Seed"];
export const ENTRY_TYPES = ["Individual", "Pair"];

function normalizeEntryType(value) {
  const v = normKey(value);
  if (v === "individual" || v === "single" || v === "singles") return "Individual";
  if (v === "pair" || v === "double" || v === "doubles") return "Pair";
  return null;
}

// A "Pair" row's Player Name may name both partners in one cell — this is
// the same "Name / Name" convention the app already uses everywhere else a
// pair is displayed (TournamentDesk's manual "Register pair" flow builds
// `${a} / ${b}`, and the Tournament Report's Participants sheet joins pair
// members with " / "), so the template's own example row uses it too and
// the importer must be able to read it back.
// Tried in order; the first separator that actually appears in the string
// wins, so a name never gets accidentally split by more than one pattern.
const PAIR_NAME_SEPARATORS = [
  /\s*\/\s*/, // "Rem / Jeff", "Rem/Jeff"
  /\s*&\s*/, // "Rem & Jeff", "Rem&Jeff"
  /\s+and\s+/i, // "Rem and Jeff" — requires real whitespace around "and" so it
  // can't fire inside an ordinary name like "Sandra" or "Anderson".
];

// Returns { names: [a, b] } if `raw` contains exactly one recognized pair
// separator splitting it into two non-empty names, { tooMany: true } if a
// separator was found but it split into something other than two names
// (e.g. a trailing separator, or three names), or null if no pair separator
// appears at all (an ordinary single name, including the existing
// single-name "Pair" row format that still needs manual partner selection).
export function splitPairName(raw) {
  const trimmed = normalizeName(raw);
  for (const pattern of PAIR_NAME_SEPARATORS) {
    if (!pattern.test(trimmed)) continue;
    // Check the raw segment count (not the empty-filtered count) so a
    // trailing/doubled separator ("Rem /", "Rem // Jeff") is correctly
    // rejected as malformed rather than silently treated as a clean pair.
    const parts = trimmed.split(pattern).map(normalizeName);
    if (parts.length === 2 && parts[0] && parts[1]) return { names: parts };
    return { tooMany: true };
  }
  return null;
}

export function buildPlayerTemplateWorkbook() {
  const rows = [
    { "Player ID": "", "Player Name": "Jane Doe", "Entry Type": "Individual", "Division": "", "Team": "", "Seed": "" },
    // Demonstrates the pairing format the importer reads back: both partner
    // names in one cell, separated by " / " (also accepts "/", "&", "and").
    { "Player ID": "", "Player Name": "Juan Dela Cruz / Pedro Santos", "Entry Type": "Pair", "Division": "", "Team": "", "Seed": "" },
  ];
  const ws = sheetFromRows(rows, PLAYER_COLUMNS);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Players");
  return wb;
}

// One row per person, per participant entry they belong to (so Division/Team/Seed
// — which live on the participant, not the person — are never merged ambiguously).
// A person with no registrations still gets exactly one row with those columns blank.
function entryTypeForParticipantKind(kind) {
  if (kind === "singles") return "Individual";
  if (kind === "doubles" || kind === "team_pair") return "Pair";
  return "";
}

export function buildPlayersExportRows(data) {
  const rows = [];
  for (const person of data.persons) {
    const memberships = (data.participantMembers || []).filter((m) => m.person_id === person.id);
    if (!memberships.length) {
      rows.push({ "Player ID": person.id, "Player Name": person.display_name, "Entry Type": "", "Division": "", "Team": "", "Seed": "" });
      continue;
    }
    for (const m of memberships) {
      const participant = data.participants.find((p) => p.id === m.participant_id);
      if (!participant) continue;
      const division = data.divisions.find((d) => d.id === participant.division_id);
      const team = participant.team_id ? data.teams.find((t) => t.id === participant.team_id) : null;
      rows.push({
        "Player ID": person.id,
        "Player Name": person.display_name,
        "Entry Type": entryTypeForParticipantKind(participant.kind),
        "Division": division?.name || "",
        "Team": team?.name || "",
        "Seed": participant.seed ?? "",
      });
    }
  }
  return rows;
}

export function buildPlayersExportWorkbook(data) {
  const rows = buildPlayersExportRows(data);
  const ws = sheetFromRows(rows, PLAYER_COLUMNS);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Players");
  return wb;
}

// ---------------------------------------------------------------------------
// Players — import parsing + validation + duplicate detection
// ---------------------------------------------------------------------------

const KNOWN_HEADERS = new Set(PLAYER_COLUMNS.map(normKey));

export function parsePlayerWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { headerErrors: ["Workbook has no sheets"], rows: [] };
  const ws = wb.Sheets[sheetName];
  const table = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  if (!table.length) return { headerErrors: [], rows: [] };

  const headers = Object.keys(table[0]);
  const headerErrors = [];
  const hasName = headers.some((h) => normKey(h) === "player name");
  if (!hasName) headerErrors.push('Missing required column "Player Name"');
  const unsupported = headers.filter((h) => !KNOWN_HEADERS.has(normKey(h)));
  if (unsupported.length) headerErrors.push(`Unsupported column(s): ${unsupported.join(", ")}`);

  const findCol = (label) => headers.find((h) => normKey(h) === normKey(label));
  const nameCol = findCol("Player Name");
  const idCol = findCol("Player ID");
  const entryTypeCol = findCol("Entry Type");
  const divisionCol = findCol("Division");
  const teamCol = findCol("Team");
  const seedCol = findCol("Seed");

  const rows = table.map((raw, i) => ({
    rowNumber: i + 2, // header is row 1 in the spreadsheet
    playerId: normalizeName(idCol ? raw[idCol] : ""),
    playerName: normalizeName(nameCol ? raw[nameCol] : ""),
    entryTypeRaw: normalizeName(entryTypeCol ? raw[entryTypeCol] : ""),
    division: normalizeName(divisionCol ? raw[divisionCol] : ""),
    team: normalizeName(teamCol ? raw[teamCol] : ""),
    seedRaw: normalizeName(seedCol ? raw[seedCol] : ""),
  }));

  return { headerErrors, rows, hasEntryTypeColumn: Boolean(entryTypeCol) };
}

// Validates + classifies rows against existing tournament data.
// Does not decide what to DO about duplicates — that is chosen by the user
// (Add New / Update Existing / Skip Existing) at import time.
export function analyzePlayerRows(rows, data, { hasEntryTypeColumn = false } = {}) {
  const existingById = new Map(data.persons.map((p) => [p.id, p]));
  const existingByName = new Map(data.persons.map((p) => [normKey(p.display_name), p]));
  const divisionsByName = new Map(data.divisions.map((d) => [normKey(d.name), d]));
  const seenNamesInFile = new Map();
  const seenIdsInFile = new Map();

  const analyzed = rows.map((row) => {
    const errors = [];
    const isEmptyRow = !row.playerId && !row.playerName && !row.entryTypeRaw && !row.division && !row.team && !row.seedRaw;
    if (isEmptyRow) return { ...row, errors, isEmptyRow, existingPerson: null, entryType: null, division: null, team: null, seed: null };

    if (!row.playerName) errors.push("Player Name is required");

    let entryType = null;
    if (!hasEntryTypeColumn) {
      // Older template/export without this column — preserve backward compatibility
      // rather than failing every row.
      entryType = "Individual";
    } else if (!row.entryTypeRaw) {
      errors.push("Entry Type is required (Individual or Pair)");
    } else {
      entryType = normalizeEntryType(row.entryTypeRaw);
      if (!entryType) errors.push(`Entry Type "${row.entryTypeRaw}" is not valid — use Individual or Pair`);
    }

    // A "Pair" row's Player Name may combine both partners in one cell
    // ("Rem / Jeff", "Rem & Jeff", "Rem and Jeff") — see splitPairName.
    // A bare single name (the pre-existing format) is left as pairNames=null
    // and falls through to the unchanged single-person "needs manual partner"
    // path below, so nothing about that existing format changes.
    let pairNames = null;
    let pairPersons = null;
    if (entryType === "Pair" && row.playerName) {
      const split = splitPairName(row.playerName);
      if (split?.tooMany) {
        errors.push(`Could not read two player names from "${row.playerName}" — use the format "Name 1 / Name 2"`);
      } else if (split?.names) {
        const [n1, n2] = split.names;
        if (normKey(n1) === normKey(n2)) {
          errors.push("The same player cannot be selected twice in one pair");
        } else {
          pairNames = [n1, n2];
        }
      }
    }

    let existingPerson = null;
    if (pairNames) {
      // Each half is resolved exactly like an ordinary single-name row would
      // be (case-insensitive match against existing players; unmatched
      // names are simply new players, not errors).
      pairPersons = pairNames.map((name) => ({ name, existingPerson: existingByName.get(normKey(name)) || null }));
    } else {
      if (row.playerId) {
        const dup = seenIdsInFile.get(row.playerId);
        if (dup) errors.push(`Duplicate Player ID within file (also row ${dup})`);
        seenIdsInFile.set(row.playerId, row.rowNumber);
        if (!existingById.has(row.playerId)) errors.push("Player ID does not match any existing player in this tournament");
      }
      existingPerson = row.playerId ? existingById.get(row.playerId) || null : null;
      if (!existingPerson && row.playerName) {
        const byName = existingByName.get(normKey(row.playerName));
        if (byName) existingPerson = byName;
      }
    }

    // Duplicate-within-file detection covers both plain names and each half
    // of a pair, in the same map, so "Rem" as its own row and "Rem" as half
    // of a later pair row are still caught as the same person.
    const namesToTrack = pairNames || (row.playerName ? [row.playerName] : []);
    for (const name of namesToTrack) {
      const nameKey = normKey(name);
      const dupRow = seenNamesInFile.get(nameKey);
      if (dupRow && dupRow !== row.rowNumber) errors.push(`Duplicate player name within file (also row ${dupRow}): "${name}"`);
      if (!dupRow) seenNamesInFile.set(nameKey, row.rowNumber);
    }

    let division = null;
    if (row.division) {
      division = divisionsByName.get(normKey(row.division)) || null;
      if (!division) errors.push(`Division "${row.division}" does not exist`);
    }

    let team = null;
    if (row.team) {
      if (!division) {
        errors.push('Team specified without a valid Division');
      } else {
        team = data.teams.find((t) => t.division_id === division.id && normKey(t.name) === normKey(row.team)) || null;
        if (!team) errors.push(`Team "${row.team}" does not exist in division "${row.division}"`);
      }
    }

    let seed = null;
    if (row.seedRaw) {
      const n = Number(row.seedRaw);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) errors.push("Seed must be a positive whole number");
      else seed = n;
    }

    return {
      ...row,
      errors,
      isEmptyRow: false,
      existingPerson,
      pairNames,
      pairPersons,
      // For a pair, "duplicate" means at least one half already exists —
      // that's still meaningful for the summary counts and for the
      // add/skip/update mode picker, without needing separate per-half UI.
      isDuplicate: pairPersons ? pairPersons.some((p) => p.existingPerson) : Boolean(existingPerson),
      entryType,
      division,
      team,
      seed,
    };
  });

  const usable = analyzed.filter((r) => !r.isEmptyRow);
  const valid = usable.filter((r) => r.errors.length === 0);
  const invalid = usable.filter((r) => r.errors.length > 0);
  const newRows = valid.filter((r) => !r.isDuplicate);
  const duplicateRows = valid.filter((r) => r.isDuplicate);

  return {
    rows: analyzed,
    summary: {
      total: usable.length,
      valid: valid.length,
      invalid: invalid.length,
      newCount: newRows.length,
      duplicateCount: duplicateRows.length,
    },
  };
}

// Builds the exact list of commands to run for a chosen duplicate-handling mode.
// mode: "add_new" | "update_existing" | "skip_existing"
export function planPlayerImportActions(analyzedRows, mode, tournamentId) {
  const actions = [];
  let skipped = 0;
  for (const row of analyzedRows) {
    if (row.isEmptyRow || row.errors.length) continue;
    let personAction = null;
    if (!row.isDuplicate) {
      personAction = { kind: "add_person", payload: { tournament_id: tournamentId, display_name: row.playerName } };
    } else if (mode === "skip_existing") {
      skipped++;
      continue;
    } else if (mode === "update_existing") {
      if (row.existingPerson.display_name !== row.playerName) {
        personAction = {
          kind: "update_person",
          payload: { person_id: row.existingPerson.id, display_name: row.playerName },
        };
      } else {
        personAction = { kind: "noop_existing", existingPersonId: row.existingPerson.id };
      }
    } else {
      // add_new mode: existing player is left untouched, not re-created.
      skipped++;
      continue;
    }
    actions.push({ row, personAction, division: row.division, team: row.team, seed: row.seed });
  }
  return { actions, skipped };
}

// ---------------------------------------------------------------------------
// Bracket — export / import.
//
// Round-trip identity is `matches.id` (the "Match ID" column) — rows are
// matched to matches by this stable id only, never by row position. Only
// Side A / Side B (who occupies each slot) is editable; every other column
// is context. Applying a change reuses the existing update_match_participant
// command (packages/api/src/handleCommand.js) — the same command the
// operator desk's "Edit players" action already calls — so all of its
// existing guarantees apply for free: organizer-only, locked once a match is
// no longer in scheduled/ready/assigned/postponed, rejects duplicate/unknown
// persons, and cannot change a side's player COUNT (a doubles pair can only
// be replaced by another pair, an individual only by another individual).
// This module never writes to match_participants directly.
// ---------------------------------------------------------------------------

export const BRACKET_COLUMNS = [
  "Match ID", "Division", "Stage", "Round", "Position", "Team",
  "Side A", "Side A Seed", "Side B", "Side B Seed",
  "Court", "Umpire", "Status", "Winner", "Score",
];

// Matches editable through update_match_participant — kept in sync with
// MATCH_PARTICIPANT_EDITABLE_STATUSES in packages/api/src/handleCommand.js.
// This is a client-side preview mirror only; the server re-checks match
// status itself and is the actual authority.
export const BRACKET_EDITABLE_STATUSES = new Set(["scheduled", "ready", "assigned", "postponed"]);

// Team-elimination's playable unit is always a child pair-match
// (parent_match_id set); its own stage_label is null, so the real stage
// (round robin / semifinal / bronze / final) lives on the parent shell.
// Single-elim never sets stage_label at all except via bracket_side="bronze".
export function bracketStageLabel(match, data) {
  if (match.parent_match_id) {
    const parent = data.matches.find((m) => m.id === match.parent_match_id);
    if (parent?.stage_label) return stageTitle(parent.stage_label);
    if (parent?.bracket_side === "bronze") return "Bronze";
  }
  if (match.stage_label) return stageTitle(match.stage_label);
  if (match.bracket_side === "bronze") return "Bronze";
  return `Round ${match.round ?? "?"}`;
}

function bracketTeamName(match, data) {
  const mps = (data.matchParticipants || []).filter((p) => p.match_id === match.id);
  const teamId = mps.find((p) => p.team_id)?.team_id;
  return teamId ? (data.teams.find((t) => t.id === teamId)?.name || "") : "";
}

export function buildBracketExportRows(data) {
  const matches = playableMatches(data.matches)
    .slice()
    .sort((a, b) => (a.division_id || "").localeCompare(b.division_id || "") || (a.round ?? 0) - (b.round ?? 0) || (a.bracket_position ?? 0) - (b.bracket_position ?? 0));
  return matches.map((m) => {
    const division = data.divisions.find((d) => d.id === m.division_id);
    const a = sideOf(m.id, "A", data);
    const b = sideOf(m.id, "B", data);
    const result = resultFor(m, data.results);
    const court = courtFor(m, data);
    const ump = umpireFor(m, data);
    return {
      "Match ID": m.id,
      "Division": division?.name || "",
      "Stage": bracketStageLabel(m, data),
      "Round": m.round ?? "",
      "Position": m.bracket_position ?? "",
      "Team": bracketTeamName(m, data),
      "Side A": a.name,
      "Side A Seed": a.participant?.seed ?? "",
      "Side B": b.name,
      "Side B Seed": b.participant?.seed ?? "",
      "Court": court?.name || "",
      "Umpire": ump?.name || "",
      "Status": m.status,
      "Winner": m.winner ? sideOf(m.id, m.winner, data).name : "",
      "Score": scoreLine(m, result),
    };
  });
}

export function buildBracketExportWorkbook(data) {
  const rows = buildBracketExportRows(data);
  const ws = sheetFromRows(rows, BRACKET_COLUMNS);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Bracket");
  return wb;
}

const BRACKET_KNOWN_HEADERS = new Set(BRACKET_COLUMNS.map(normKey));

export function parseBracketWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array" });
  const sheetName = wb.SheetNames.find((n) => normKey(n) === "bracket") || wb.SheetNames[0];
  if (!sheetName) return { headerErrors: ["Workbook has no sheets"], rows: [] };
  const ws = wb.Sheets[sheetName];
  const table = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  if (!table.length) return { headerErrors: [], rows: [] };

  const headers = Object.keys(table[0]);
  const headerErrors = [];
  if (!headers.some((h) => normKey(h) === "match id")) headerErrors.push('Missing required column "Match ID"');
  if (!headers.some((h) => normKey(h) === "side a")) headerErrors.push('Missing required column "Side A"');
  if (!headers.some((h) => normKey(h) === "side b")) headerErrors.push('Missing required column "Side B"');
  const unsupported = headers.filter((h) => !BRACKET_KNOWN_HEADERS.has(normKey(h)));
  if (unsupported.length) headerErrors.push(`Unsupported column(s): ${unsupported.join(", ")}`);

  const findCol = (label) => headers.find((h) => normKey(h) === normKey(label));
  const idCol = findCol("Match ID");
  const sideACol = findCol("Side A");
  const sideBCol = findCol("Side B");

  const rows = table.map((raw, i) => ({
    rowNumber: i + 2, // header is row 1 in the spreadsheet
    matchId: normalizeName(idCol ? raw[idCol] : ""),
    sideA: normalizeName(sideACol ? raw[sideACol] : ""),
    sideB: normalizeName(sideBCol ? raw[sideBCol] : ""),
  }));

  return { headerErrors, rows };
}

// Resolves one slot's new Excel value against the slot's current player
// count (a pair can only be replaced by a pair, an individual only by
// another individual — the same constraint update_match_participant itself
// enforces server-side; this mirrors it for the preview). Reuses
// splitPairName exactly as the Players importer does — no second pair parser.
function resolveBracketSide({ newName, oldParticipant, data }) {
  const expectedCount = oldParticipant ? membersOfParticipant(oldParticipant.id, data.participantMembers).length || 1 : null;
  const split = splitPairName(newName);
  if (split?.tooMany) {
    return { error: `Could not read player names from "${newName}" — use the format "Name 1 / Name 2"` };
  }
  const names = split?.names || (newName ? [newName] : []);
  if (!names.length) return { error: "New player/pair name cannot be blank" };
  if (expectedCount != null && names.length !== expectedCount) {
    return {
      error: expectedCount === 1
        ? `This side is an individual entry — cannot replace it with a pair ("${newName}")`
        : `This side is a pair (${expectedCount} players) — "${newName}" only names one player`,
    };
  }
  const existingByName = new Map(data.persons.map((p) => [normKey(p.display_name), p]));
  const players = names.map((name) => ({ name, existingPerson: existingByName.get(normKey(name)) || null }));
  const uniqueKeys = new Set(names.map(normKey));
  if (uniqueKeys.size !== names.length) return { error: "The same player cannot appear twice on one side" };
  return { players };
}

// Validates a parsed bracket sheet against the live tournament: resolves
// Match ID to a real match (never by row order), determines which sides
// actually changed, and resolves each changed side's new player(s) — without
// mutating anything. Returns one entry per data row with either a list of
// per-slot changes ready to apply, or a row-level error explaining why not.
export function analyzeBracketRows(rows, data) {
  const matchById = new Map(data.matches.map((m) => [m.id, m]));
  const usedPersonKeys = new Map(); // normKey(name) -> "row N, Side X" for cross-row duplicate detection

  const analyzed = rows.map((row) => {
    const isEmptyRow = !row.matchId && !row.sideA && !row.sideB;
    if (isEmptyRow) return { ...row, isEmptyRow, errors: [], changes: [] };

    const errors = [];
    if (!row.matchId) errors.push("Match ID is required");
    const match = row.matchId ? matchById.get(row.matchId) : null;
    if (row.matchId && !match) errors.push(`Unknown Match ID "${row.matchId}" — this row does not match any match in this tournament`);

    const changes = [];
    if (match) {
      for (const [slot, newName] of [["A", row.sideA], ["B", row.sideB]]) {
        if (!newName) continue;
        const current = sideOf(match.id, slot, data);
        if (normKey(current.name) === normKey(newName)) continue; // unchanged
        const entry = { slot, oldName: current.name, newName };
        if (!BRACKET_EDITABLE_STATUSES.has(match.status)) {
          entry.error = match.status === "completed" || match.status === "bye"
            ? "Match is already completed — cannot change players from Excel"
            : `Match is ${match.status} — players can only be changed before the match starts`;
        } else if (!current.participant) {
          entry.error = "This slot has no player assigned yet (waiting on a previous round) — cannot set it directly";
        } else {
          const resolved = resolveBracketSide({ newName, oldParticipant: current.participant, data });
          if (resolved.error) {
            entry.error = resolved.error;
          } else {
            entry.players = resolved.players;
            for (const p of resolved.players) {
              const key = normKey(p.name);
              const dupAt = usedPersonKeys.get(key);
              if (dupAt && dupAt !== `row ${row.rowNumber}`) {
                entry.error = `"${p.name}" is also assigned elsewhere in this import (${dupAt})`;
              } else {
                usedPersonKeys.set(key, `row ${row.rowNumber}`);
              }
            }
          }
        }
        changes.push(entry);
      }
    }

    const divisionName = match ? (data.divisions.find((d) => d.id === match.division_id)?.name || "") : "";
    const stageLabel = match ? bracketStageLabel(match, data) : "";
    return { ...row, isEmptyRow: false, match, errors, changes, divisionName, stageLabel };
  });

  const usable = analyzed.filter((r) => !r.isEmptyRow);
  const withChanges = usable.filter((r) => r.errors.length === 0 && r.changes.length > 0);
  const applicable = withChanges.flatMap((r) => r.changes.filter((c) => !c.error));
  const blocked = usable.flatMap((r) => (r.errors.length ? [{ row: r.rowNumber, message: r.errors.join("; ") }] : r.changes.filter((c) => c.error).map((c) => ({ row: r.rowNumber, message: `${c.oldName} (Side ${c.slot}): ${c.error}` }))));
  const newPersonCount = new Set(
    applicable.flatMap((c) => c.players).filter((p) => !p.existingPerson).map((p) => normKey(p.name))
  ).size;

  return {
    rows: analyzed,
    summary: {
      totalRows: usable.length,
      matchesChanged: withChanges.length,
      changesReady: applicable.length,
      blockedCount: blocked.length,
      newPersonCount,
    },
    blocked,
  };
}

// ---------------------------------------------------------------------------
// Tournament Report — six worksheets, all derived from persisted data.
// ---------------------------------------------------------------------------

function buildSummarySheet(data) {
  const t = data.tournament;
  const completedMatches = data.matches.filter((m) => m.status === "completed" || m.status === "bye");
  const overview = [
    { Field: "Tournament Name", Value: t?.name || "" },
    { Field: "Tournament ID", Value: t?.id || "" },
    { Field: "Sport", Value: t?.sport || "" },
    { Field: "Status", Value: t?.status || "" },
    { Field: "Created At", Value: t?.created_at || "" },
    { Field: "Divisions", Value: data.divisions.length },
    { Field: "Players", Value: data.persons.length },
    { Field: "Teams", Value: data.teams.length },
    { Field: "Participants", Value: data.participants.length },
    { Field: "Matches (total)", Value: data.matches.length },
    { Field: "Matches (completed)", Value: completedMatches.length },
  ];
  const overviewWs = sheetFromRows(overview, ["Field", "Value"]);

  const perDivision = data.divisions.map((d) => {
    const placements = placementsForDivision(d, data);
    const divMatches = data.matches.filter((m) => m.division_id === d.id);
    const divisionComplete = divMatches.length > 0 && divMatches.every((m) => ["completed", "bye", "cancelled"].includes(m.status));
    return {
      Division: d.name,
      Format: d.format,
      Entrants: data.participants.filter((p) => p.division_id === d.id).length,
      Status: divisionComplete ? "Completed" : "In progress",
      Champion: placements.champion,
      "Runner-up": placements.runnerUp,
      "Third Place": placements.third,
    };
  });
  const divisionsWs = sheetFromRows(perDivision, ["Division", "Format", "Entrants", "Status", "Champion", "Runner-up", "Third Place"]);

  return { overviewWs, divisionsWs };
}

// Round reached for a single-elim participant, from persisted round numbers only
// (no ranking is computed — this mirrors bracket depth, a raw fact).
function progressLabelForParticipant(participantId, division, data, finalMatch) {
  if (finalMatch?.status === "completed" && finalMatch.winner) {
    const winnerSide = sideOf(finalMatch.id, finalMatch.winner, data);
    const loserSide = sideOf(finalMatch.id, finalMatch.winner === "A" ? "B" : "A", data);
    if (winnerSide.participant?.id === participantId) return "Champion";
    if (loserSide.participant?.id === participantId) return "Runner-up";
  }
  const played = data.matches.filter((m) => {
    if (m.division_id !== division.id) return false;
    const a = data.matchParticipants.find((p) => p.match_id === m.id && p.slot === "A");
    const b = data.matchParticipants.find((p) => p.match_id === m.id && p.slot === "B");
    return a?.participant_id === participantId || b?.participant_id === participantId;
  });
  const completed = played.filter((m) => m.status === "completed" || m.status === "bye");
  if (!completed.length) return played.length ? "Not yet played" : "No matches scheduled";
  const lastRound = Math.max(...completed.map((m) => m.round || 0));
  const lastMatch = completed.filter((m) => (m.round || 0) === lastRound).pop();
  const lost = lastMatch.winner && sideOf(lastMatch.id, lastMatch.winner === "A" ? "B" : "A", data).participant?.id === participantId;
  return lost ? `Eliminated — Round ${lastRound}` : `Advanced past Round ${lastRound}`;
}

function buildStandingsSheet(data) {
  const rows = [];
  for (const division of data.divisions) {
    if (division.format === "team_elimination") {
      const standings = teamEliminationStandings(division, data);
      for (const s of standings) {
        const participant = data.participants.find((p) => p.id === s.registrationId);
        rows.push({
          Division: division.name,
          Rank: s.rank,
          "Pair / Player": participant?.display_name || s.registrationId,
          Team: s.teamName,
          W: s.wins,
          L: s.losses,
          "+/-": s.pointDiff,
        });
      }
    } else {
      const finalMatch = finalMatchOf(division, data.matches);
      const participants = data.participants.filter((p) => p.division_id === division.id);
      for (const p of participants) {
        rows.push({
          Division: division.name,
          Rank: "",
          "Pair / Player": p.display_name,
          Team: "",
          W: "",
          L: "",
          "+/-": "",
          Progress: progressLabelForParticipant(p.id, division, data, finalMatch),
        });
      }
    }
  }
  return sheetFromRows(rows, ["Division", "Rank", "Pair / Player", "Team", "W", "L", "+/-", "Progress"]);
}

function buildMatchResultsSheet(data) {
  const rows = playableMatches(data.matches)
    .map((m) => {
      const division = data.divisions.find((d) => d.id === m.division_id);
      const a = sideOf(m.id, "A", data);
      const b = sideOf(m.id, "B", data);
      const result = resultFor(m, data.results);
      const court = courtFor(m, data);
      const ump = umpireFor(m, data);
      return {
        Division: division?.name || "",
        Stage: stageTitle(m.stage_label),
        Round: m.round ?? "",
        Court: court?.name || "",
        Umpire: ump?.name || "",
        "Side A": a.name,
        "Side B": b.name,
        Score: scoreLine(m, result),
        Winner: m.winner ? sideOf(m.id, m.winner, data).name : "",
        Status: m.status,
        "Started At": m.started_at || "",
        "Completed At": m.completed_at || "",
      };
    });
  return sheetFromRows(rows, ["Division", "Stage", "Round", "Court", "Umpire", "Side A", "Side B", "Score", "Winner", "Status", "Started At", "Completed At"]);
}

function buildPlayerPerformanceSheet(data) {
  const stats = new Map(data.persons.map((p) => [p.id, {
    "Player Name": p.display_name,
    "Matches Played": 0,
    Wins: 0,
    Losses: 0,
    "Win %": 0,
    "Points For": 0,
    "Points Against": 0,
    "Point Diff": 0,
  }]));

  for (const m of data.matches) {
    if (m.status !== "completed" || !m.winner) continue;
    const result = resultFor(m, data.results);
    const scoreA = result?.score_a ?? 0;
    const scoreB = result?.score_b ?? 0;
    for (const slot of ["A", "B"]) {
      const mp = data.matchParticipants.find((x) => x.match_id === m.id && x.slot === slot);
      if (!mp?.participant_id) continue;
      const members = membersOfParticipant(mp.participant_id, data.participantMembers);
      const won = m.winner === slot;
      const pf = slot === "A" ? scoreA : scoreB;
      const pa = slot === "A" ? scoreB : scoreA;
      for (const mem of members) {
        const row = stats.get(mem.person_id);
        if (!row) continue;
        row["Matches Played"] += 1;
        row[won ? "Wins" : "Losses"] += 1;
        row["Points For"] += pf;
        row["Points Against"] += pa;
      }
    }
  }
  const rows = [...stats.values()]
    .filter((r) => r["Matches Played"] > 0)
    .map((r) => ({
      ...r,
      "Win %": r["Matches Played"] ? Math.round((r.Wins / r["Matches Played"]) * 1000) / 10 : 0,
      "Point Diff": r["Points For"] - r["Points Against"],
    }));
  return sheetFromRows(rows, ["Player Name", "Matches Played", "Wins", "Losses", "Win %", "Points For", "Points Against", "Point Diff"]);
}

function buildGameDetailsSheet(data) {
  const rows = [];
  for (const result of data.results) {
    const games = Array.isArray(result.games) ? result.games : [];
    if (!games.length) continue;
    const match = data.matches.find((m) => m.id === result.match_id);
    if (!match) continue;
    const division = data.divisions.find((d) => d.id === match.division_id);
    const a = sideOf(match.id, "A", data);
    const b = sideOf(match.id, "B", data);
    games.forEach((g, i) => {
      rows.push({
        Division: division?.name || "",
        "Side A": a.name,
        "Side B": b.name,
        Game: i + 1,
        "Score A": g.scoreA ?? "",
        "Score B": g.scoreB ?? "",
        "Game Winner": g.winner === "A" ? a.name : g.winner === "B" ? b.name : "",
      });
    });
  }
  if (!rows.length) return null;
  return sheetFromRows(rows, ["Division", "Side A", "Side B", "Game", "Score A", "Score B", "Game Winner"]);
}

function buildParticipantsSheet(data) {
  const rows = data.participants.map((p) => {
    const division = data.divisions.find((d) => d.id === p.division_id);
    const team = p.team_id ? data.teams.find((t) => t.id === p.team_id) : null;
    const members = membersOfParticipant(p.id, data.participantMembers).map((m) => personLabel(m.person_id, data.persons));
    return {
      Division: division?.name || "",
      Kind: p.kind,
      "Display Name": p.display_name,
      Members: members.join(" / "),
      Team: team?.name || "",
      Seed: p.seed ?? "",
    };
  });
  return sheetFromRows(rows, ["Division", "Kind", "Display Name", "Members", "Team", "Seed"]);
}

export function buildTournamentReportWorkbook(data) {
  const wb = XLSX.utils.book_new();
  const { overviewWs, divisionsWs } = buildSummarySheet(data);
  XLSX.utils.book_append_sheet(wb, overviewWs, "Tournament Summary");
  XLSX.utils.book_append_sheet(wb, divisionsWs, "Division Summary");
  XLSX.utils.book_append_sheet(wb, buildStandingsSheet(data), "Final Standings");
  XLSX.utils.book_append_sheet(wb, buildMatchResultsSheet(data), "Match Results");
  XLSX.utils.book_append_sheet(wb, buildPlayerPerformanceSheet(data), "Player Performance");
  const gameDetails = buildGameDetailsSheet(data);
  if (gameDetails) XLSX.utils.book_append_sheet(wb, gameDetails, "Game Score Details");
  XLSX.utils.book_append_sheet(wb, buildParticipantsSheet(data), "Participants");
  return wb;
}
