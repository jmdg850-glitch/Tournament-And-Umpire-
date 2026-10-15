import { useMemo, useState } from "react";
import { Alert, Badge, Button, Modal, Select, Table } from "@tournament/ui";
import { doubleEntryNameKey } from "./lib.js";

const MODE_OPTIONS = [
  { value: "add_new", label: "Add New (new players + new division entries)" },
  { value: "update_existing", label: "Update Existing (rename matches)" },
  { value: "skip_existing", label: "Skip Existing (ignore duplicates)" },
];

function countForMode(summary, mode) {
  if (mode === "update_existing") return summary.newCount + summary.duplicateCount;
  if (mode === "add_new") return summary.newCount + (summary.registerExistingCount || 0);
  return summary.newCount;
}

export default function PlayerImportModal({ analysis, data, command, tournamentId, onClose, onImported }) {
  const [mode, setMode] = useState("add_new");
  const [phase, setPhase] = useState("preview"); // preview | importing | done
  const [outcome, setOutcome] = useState(null);

  const { rows, summary } = analysis;
  const invalidRows = useMemo(() => rows.filter((r) => !r.isEmptyRow && r.errors.length > 0), [rows]);
  const validRows = useMemo(() => rows.filter((r) => !r.isEmptyRow && r.errors.length === 0), [rows]);
  const willImport = countForMode(summary, mode);

  async function runImport() {
    setPhase("importing");
    const results = { created: 0, updated: 0, registered: 0, needsPairing: 0, skipped: 0, failed: [] };
    const usable = rows.filter((r) => !r.isEmptyRow && r.errors.length === 0);
    // A player listed in several divisions of this file is ONE person: the
    // first row creates them, later rows reuse that record (never a second
    // add_person for the same name).
    const createdInRun = new Map();
    async function newPersonId(name) {
      const key = doubleEntryNameKey(name);
      if (createdInRun.has(key)) return createdInRun.get(key);
      const out = await command("add_person", { tournament_id: tournamentId, display_name: name });
      createdInRun.set(key, out.result.person.id);
      results.created++;
      return out.result.person.id;
    }

    for (const row of usable) {
      try {
        if (row.pairNames) {
          // "Rem / Jeff" style row: resolve/create both halves, then
          // register them together as one doubles participant. Mode applies
          // to the whole pair exactly as it would to a single duplicate row
          // (skip_existing skips the row if either half already exists;
          // add_new reuses existing halves unrenamed only when the pair is
          // entering a division they are not in yet; update_existing renames
          // whichever half changed).
          if (row.isDuplicate && (mode === "skip_existing" || (mode === "add_new" && !row.registerExisting))) {
            results.skipped++;
            continue;
          }
          const personIds = [];
          for (const half of row.pairPersons) {
            if (!half.existingPerson) {
              personIds.push(await newPersonId(half.name));
            } else if (mode === "update_existing" && half.existingPerson.display_name !== half.name) {
              const out = await command("update_person", { person_id: half.existingPerson.id, display_name: half.name });
              personIds.push(out.result.person.id);
              results.updated++;
            } else {
              personIds.push(half.existingPerson.id);
            }
          }
          if (row.division) {
            await command("register_participant", {
              division_id: row.division.id,
              display_name: row.playerName,
              kind: "doubles",
              team_id: row.team?.id || null,
              seed: row.seed || null,
              person_ids: personIds,
            });
            results.registered++;
          }
          continue;
        }

        let personId = null;
        if (!row.isDuplicate) {
          personId = await newPersonId(row.playerName);
        } else if (mode === "skip_existing") {
          results.skipped++;
          continue;
        } else if (mode === "update_existing") {
          if (row.existingPerson.display_name !== row.playerName) {
            const out = await command("update_person", { person_id: row.existingPerson.id, display_name: row.playerName });
            personId = out.result.person.id;
            results.updated++;
          } else {
            personId = row.existingPerson.id;
          }
        } else if (row.registerExisting) {
          // add_new mode: reuse the existing player untouched (no rename) and
          // only register them into a division they are not in yet.
          personId = row.existingPerson.id;
        } else {
          // add_new mode + duplicate with nothing new to register: leave the
          // existing player untouched.
          results.skipped++;
          continue;
        }

        if (row.division && personId) {
          if (row.entryType === "Pair") {
            // A single-name Pair row (no separator) still can't supply a
            // partner on its own — the player and their division/team are
            // recorded, but registration is left for the existing
            // "Register pair" flow so no partner is guessed.
            results.needsPairing++;
          } else {
            await command("register_participant", {
              division_id: row.division.id,
              display_name: row.playerName,
              kind: "singles",
              team_id: row.team?.id || null,
              seed: row.seed || null,
              person_ids: [personId],
            });
            results.registered++;
          }
        }
      } catch (err) {
        results.failed.push({ row: row.rowNumber, name: row.playerName, message: err.message || String(err) });
      }
    }

    setOutcome(results);
    setPhase("done");
    await onImported();
  }

  return (
    <Modal title="Import players" onClose={onClose}>
      {phase === "preview" && (
        <div className="stack">
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <Badge tone="muted">Total rows: {summary.total}</Badge>
            <Badge tone="ok">Valid: {summary.valid}</Badge>
            <Badge tone={summary.invalid ? "warn" : "muted"}>Invalid: {summary.invalid}</Badge>
            <Badge tone="muted">New: {summary.newCount}</Badge>
            <Badge tone="muted">Existing (duplicates): {summary.duplicateCount}</Badge>
            {summary.doubleEntryCount > 0 && <Badge tone="warn">Double entry: {summary.doubleEntryCount}</Badge>}
          </div>

          {/* Bounded + scrollable so a large import (many rows) can't push the
              summary/mode/actions below off-screen — only this preview area
              scrolls, the rest of the modal stays put. */}
          <div className="import-preview-scroll stack">
            {invalidRows.length > 0 && (
              <div>
                <h3>Row errors ({invalidRows.length})</h3>
                <Table
                  responsive
                  columns={[
                    { key: "rowNumber", header: "Row" },
                    { key: "playerName", header: "Player Name", render: (r) => r.playerName || "(blank)" },
                    { key: "errors", header: "Errors", render: (r) => r.errors.join("; ") },
                  ]}
                  rows={invalidRows.map((r) => ({ id: r.rowNumber, ...r }))}
                />
              </div>
            )}

            {validRows.length > 0 && (
              <div>
                <h3>Preview ({validRows.length} valid row{validRows.length === 1 ? "" : "s"})</h3>
                <Table
                  responsive
                  columns={[
                    { key: "rowNumber", header: "Row" },
                    { key: "playerName", header: "Player Name" },
                    { key: "entryType", header: "Entry Type" },
                    { key: "division", header: "Division", render: (r) => r.division?.name || "—" },
                    { key: "team", header: "Team", render: (r) => r.team?.name || "—" },
                    {
                      key: "status",
                      header: "Status",
                      render: (r) => {
                        const status = r.pairNames
                          ? `Pair: ${r.pairNames.join(" / ")} (${r.isDuplicate ? "existing" : "new"})`
                          : r.isDuplicate ? "Existing" : "New";
                        if (!r.doubleEntries?.length) return status;
                        return (
                          <div className="stack" style={{ gap: 4 }}>
                            <span>{status}</span>
                            {r.doubleEntries.map((d) => (
                              <span key={d.name} title={`${d.name}: ${d.divisions.join(", ")}`}>
                                <Badge tone="warn">DOUBLE ENTRY</Badge>{" "}
                                <span className="muted">{r.pairNames ? `${d.name}: ` : ""}{d.divisions.join(", ")}</span>
                              </span>
                            ))}
                          </div>
                        );
                      },
                    },
                  ]}
                  rows={validRows.map((r) => ({ id: r.rowNumber, ...r }))}
                />
              </div>
            )}
          </div>

          {summary.duplicateCount > 0 && (
            <Select label="How should existing players be handled?" value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </Select>
          )}

          <p className="muted">
            {mode === "add_new" && "New players are created. Existing players are never renamed or re-created — they are only registered into divisions they are not in yet."}
            {mode === "update_existing" && "New players are created; existing players are renamed to match the file."}
            {mode === "skip_existing" && "Only brand-new players will be created. Rows matching an existing player are skipped."}
          </p>

          <div className="row">
            <Button disabled={!willImport} onClick={runImport}>Import {willImport} Player{willImport === 1 ? "" : "s"}</Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}

      {phase === "importing" && <p>Importing… please wait.</p>}

      {phase === "done" && outcome && (
        <div className="stack">
          <Alert tone={outcome.failed.length ? "warn" : "ok"}>
            Created {outcome.created}, updated {outcome.updated}, registered {outcome.registered}, skipped {outcome.skipped}
            {outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}.
          </Alert>
          {outcome.needsPairing > 0 && (
            <Alert tone="warn">
              {outcome.needsPairing} pair {outcome.needsPairing === 1 ? "entry needs" : "entries need"} a partner — use "Register pair" below to pair them up manually.
            </Alert>
          )}
          {outcome.failed.length > 0 && (
            <Table
              columns={[
                { key: "row", header: "Row" },
                { key: "name", header: "Player Name" },
                { key: "message", header: "Error" },
              ]}
              rows={outcome.failed.map((f) => ({ id: f.row, ...f }))}
            />
          )}
          <div className="row">
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
