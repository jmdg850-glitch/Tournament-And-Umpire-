// This modal intentionally never imports from "./excelImportExport.js" —
// that module is dynamically imported (code-split) by brackets.jsx, and a
// static import here would pull it back into the main bundle. All display
// fields (divisionName/stageLabel) are precomputed onto each row by
// analyzeBracketRows, and every applied change reuses the existing
// add_person / update_match_participant commands (via the `command` prop),
// never the Excel parser's own logic.
import { useMemo, useState } from "react";
import { Alert, Badge, Button, Modal, Table } from "@tournament/ui";

export default function BracketImportModal({ analysis, command, tournamentId, onClose, onImported }) {
  const [phase, setPhase] = useState("preview"); // preview | importing | done
  const [outcome, setOutcome] = useState(null);

  const { rows, summary, blocked } = analysis;
  const readyRows = useMemo(
    () => rows.filter((r) => !r.isEmptyRow && r.errors.length === 0 && r.changes.some((c) => !c.error)),
    [rows]
  );

  async function runImport() {
    setPhase("importing");
    const results = { personsCreated: 0, slotsUpdated: 0, failed: [] };
    for (const row of readyRows) {
      for (const change of row.changes.filter((c) => !c.error)) {
        try {
          const personIds = [];
          for (const p of change.players) {
            if (p.existingPerson) {
              personIds.push(p.existingPerson.id);
            } else {
              const out = await command("add_person", { tournament_id: tournamentId, display_name: p.name });
              personIds.push(out.result.person.id);
              results.personsCreated++;
            }
          }
          await command("update_match_participant", { match_id: row.match.id, slot: change.slot, person_ids: personIds });
          results.slotsUpdated++;
        } catch (err) {
          results.failed.push({ row: row.rowNumber, match: row.matchId, slot: change.slot, message: err.message || String(err) });
        }
      }
    }
    setOutcome(results);
    setPhase("done");
    await onImported();
  }

  const willApply = readyRows.reduce((n, r) => n + r.changes.filter((c) => !c.error).length, 0);

  return (
    <Modal title="Import bracket" onClose={onClose}>
      {phase === "preview" && (
        <div className="stack">
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <Badge tone="muted">Rows: {summary.totalRows}</Badge>
            <Badge tone="ok">Changes ready: {summary.changesReady}</Badge>
            <Badge tone={summary.blockedCount ? "warn" : "muted"}>Blocked: {summary.blockedCount}</Badge>
            <Badge tone="muted">New players: {summary.newPersonCount}</Badge>
          </div>

          <div className="import-preview-scroll stack">
            {blocked.length > 0 && (
              <div>
                <h3>Cannot apply ({blocked.length})</h3>
                <Table
                  responsive
                  columns={[
                    { key: "row", header: "Row" },
                    { key: "message", header: "Reason" },
                  ]}
                  rows={blocked.map((b, i) => ({ id: `${b.row}-${i}`, ...b }))}
                />
              </div>
            )}

            {readyRows.length > 0 && (
              <div>
                <h3>Bracket changes ({willApply})</h3>
                <Table
                  responsive
                  columns={[
                    { key: "row", header: "Row" },
                    { key: "match", header: "Match", render: (r) => `${r.divisionName || "—"} · ${r.stageLabel || ""}` },
                    {
                      key: "changes",
                      header: "Side change",
                      render: (r) => (
                        <div className="stack" style={{ gap: 4 }}>
                          {r.changes.filter((c) => !c.error).map((c) => (
                            <div key={c.slot}>
                              Side {c.slot}: {c.oldName} → {c.newName}
                            </div>
                          ))}
                        </div>
                      ),
                    },
                    {
                      key: "status",
                      header: "Status",
                      render: (r) => (
                        <div className="stack" style={{ gap: 4 }}>
                          {r.changes.filter((c) => !c.error).map((c) => {
                            const hasNew = c.players.some((p) => !p.existingPerson);
                            return <Badge key={c.slot} tone={hasNew ? "warn" : "ok"}>{hasNew ? "New player" : "Ready"}</Badge>;
                          })}
                        </div>
                      ),
                    },
                  ]}
                  rows={readyRows.map((r) => ({ id: r.rowNumber, ...r }))}
                />
              </div>
            )}

            {readyRows.length === 0 && blocked.length === 0 && (
              <p className="muted">No changes detected — every side already matches this file.</p>
            )}
          </div>

          <p className="muted">
            Applying calls the same "Edit players" action used elsewhere in the app, one side at a time. Matches that have already started or completed are never changed.
          </p>

          <div className="row">
            <Button disabled={!willApply} onClick={runImport}>Apply {willApply} Change{willApply === 1 ? "" : "s"}</Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}

      {phase === "importing" && <p>Applying bracket changes… please wait.</p>}

      {phase === "done" && outcome && (
        <div className="stack">
          <Alert tone={outcome.failed.length ? "warn" : "ok"}>
            Updated {outcome.slotsUpdated} side{outcome.slotsUpdated === 1 ? "" : "s"}, created {outcome.personsCreated} new player{outcome.personsCreated === 1 ? "" : "s"}
            {outcome.failed.length ? `, ${outcome.failed.length} failed` : ""}.
          </Alert>
          {outcome.failed.length > 0 && (
            <Table
              columns={[
                { key: "row", header: "Row" },
                { key: "slot", header: "Side" },
                { key: "message", header: "Error" },
              ]}
              rows={outcome.failed.map((f, i) => ({ id: `${f.row}-${i}`, ...f }))}
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
