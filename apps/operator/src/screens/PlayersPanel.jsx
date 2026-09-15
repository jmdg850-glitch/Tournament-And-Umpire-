import { useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Dropdown, EmptyState, Input, SectionHeader, Select, Table, Tabs, useToast } from "@tournament/ui";
import { Trash2 } from "lucide-react";
import PlayerImportModal from "../PlayerImportModal.jsx";
import { assignedPersonIdsInDivision, isPairEntry, membersOfParticipant, personLabel } from "../lib.js";

export function PlayersPanel({ data, busy, run, command, load }) {
  const [section, setSection] = useState("roster");
  const [display, setDisplay] = useState("");
  const [entryMode, setEntryMode] = useState("pair");
  const [player1, setPlayer1] = useState("");
  const [player2, setPlayer2] = useState("");
  const [individualId, setIndividualId] = useState("");
  const [divisionId, setDivisionId] = useState(data.divisions[0]?.id || "");
  const [teamId, setTeamId] = useState("");
  const [seed, setSeed] = useState("");
  const [query, setQuery] = useState("");
  const assigned = assignedPersonIdsInDivision(data, divisionId, { exceptTeamId: teamId || null });
  const available = data.persons.filter((p) => !assigned.has(p.id));
  const p1Options = available.filter((p) => p.id !== player2);
  const p2Options = available.filter((p) => p.id !== player1);
  const filtered = data.persons.filter((p) => p.display_name.toLowerCase().includes(query.toLowerCase()));
  const teamsForDivision = data.teams.filter((t) => !divisionId || t.division_id === divisionId);
  const fileInputRef = useRef(null);
  const [importAnalysis, setImportAnalysis] = useState(null);
  const [importError, setImportError] = useState("");
  const toast = useToast();
  const [checkedPlayerIds, setCheckedPlayerIds] = useState(new Set());
  const [confirmDeletePlayers, setConfirmDeletePlayers] = useState(false);
  const [deletingPlayers, setDeletingPlayers] = useState(false);
  const headerPlayerCheckboxRef = useRef(null);
  const [editingPersonId, setEditingPersonId] = useState(null);
  const [editName, setEditName] = useState("");

  const entryCountFor = (personId) => (data.participantMembers || []).filter((m) => m.person_id === personId).length;
  const removableFiltered = filtered.filter((p) => entryCountFor(p.id) === 0);
  const allPlayersChecked = removableFiltered.length > 0 && removableFiltered.every((p) => checkedPlayerIds.has(p.id));
  const somePlayersChecked = filtered.some((p) => checkedPlayerIds.has(p.id));
  const checkedPlayerCount = filtered.filter((p) => checkedPlayerIds.has(p.id)).length;

  useEffect(() => {
    if (headerPlayerCheckboxRef.current) {
      headerPlayerCheckboxRef.current.indeterminate = somePlayersChecked && !allPlayersChecked;
    }
  }, [somePlayersChecked, allPlayersChecked]);

  function toggleAllPlayers() {
    setCheckedPlayerIds(allPlayersChecked ? new Set() : new Set(removableFiltered.map((p) => p.id)));
  }
  function togglePlayer(id) {
    setCheckedPlayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  async function deleteSelectedPlayers() {
    setDeletingPlayers(true);
    try {
      const targets = filtered.filter((p) => checkedPlayerIds.has(p.id));
      let removed = 0;
      let skipped = 0;
      for (const p of targets) {
        try {
          await command("remove_person", { person_id: p.id }, { durable: true });
          removed++;
        } catch {
          skipped++;
        }
      }
      setCheckedPlayerIds(new Set());
      await load();
      toast(skipped ? `Removed ${removed}, skipped ${skipped} already registered` : `Removed ${removed} player${removed === 1 ? "" : "s"}`);
    } finally {
      setDeletingPlayers(false);
      setConfirmDeletePlayers(false);
    }
  }

  function startRename(p) {
    setEditingPersonId(p.id);
    setEditName(p.display_name);
  }

  function saveRename(e, p) {
    e.preventDefault();
    const name = editName.trim();
    setEditingPersonId(null);
    if (name && name !== p.display_name) {
      run("Rename player", "update_person", { person_id: p.id, display_name: name });
    }
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");
    try {
      const buffer = await file.arrayBuffer();
      const { parsePlayerWorkbook, analyzePlayerRows } = await import("../excelImportExport.js");
      const { headerErrors, rows, hasEntryTypeColumn } = parsePlayerWorkbook(buffer);
      if (headerErrors.length) {
        setImportError(headerErrors.join("; "));
        return;
      }
      if (!rows.length) {
        setImportError("The file has no data rows.");
        return;
      }
      setImportAnalysis(analyzePlayerRows(rows, data, { hasEntryTypeColumn }));
    } catch (err) {
      setImportError(`Could not read this file: ${err.message || err}`);
    }
  }

  async function exportPlayers() {
    const { buildPlayersExportWorkbook, downloadWorkbook, safeFileNamePart } = await import("../excelImportExport.js");
    const wb = buildPlayersExportWorkbook(data);
    downloadWorkbook(wb, `${safeFileNamePart(data.tournament?.name)}_Players.xlsx`);
  }

  async function downloadTemplate() {
    const { buildPlayerTemplateWorkbook, downloadWorkbook } = await import("../excelImportExport.js");
    downloadWorkbook(buildPlayerTemplateWorkbook(), "Player_Import_Template.xlsx");
  }

  function registerPair() {
    const a = data.persons.find((p) => p.id === player1);
    const b = data.persons.find((p) => p.id === player2);
    if (!a || !b) return;
    run("Register pair", "register_participant", {
      division_id: divisionId,
      display_name: `${a.display_name} / ${b.display_name}`,
      kind: "doubles",
      team_id: teamId || null,
      seed: seed ? Number(seed) : null,
      person_ids: [player1, player2],
    });
  }

  function registerIndividual() {
    const person = data.persons.find((p) => p.id === individualId);
    if (!person) return;
    run("Register", "register_participant", {
      division_id: divisionId,
      display_name: person.display_name,
      kind: "singles",
      team_id: teamId || null,
      seed: seed ? Number(seed) : null,
      person_ids: [individualId],
    });
  }

  return (
    <div className="stack">
      <SectionHeader
        title="Player management"
        description="Add players, import a roster, then register them into a division."
      />
      <Tabs
        tabs={[["roster", "Roster"], ["registration", "Registration"]]}
        value={section}
        onChange={setSection}
      />

      {section === "roster" && (
        <div className="stack">
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: "none" }}
              onChange={handleImportFile}
            />
            <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>Import Excel</Button>
            <Dropdown label="Export">
              <Button type="button" variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={downloadTemplate}>Download Template</Button>
              <Button type="button" variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }} disabled={!data.persons.length} onClick={exportPlayers}>Export Players</Button>
            </Dropdown>
          </div>
          <Card className="stack">
            <h2>Add player</h2>
            {importError && <Alert>{importError}</Alert>}
            <form className="row" onSubmit={(e) => {
              e.preventDefault();
              run("Add player", "add_person", { tournament_id: data.tournament.id, display_name: display });
              setDisplay("");
            }}>
              <Input label="Player name" hideLabel value={display} onChange={(e) => setDisplay(e.target.value)} placeholder="Player name" required />
              <Button type="submit" disabled={!!busy}>Add player</Button>
            </form>
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Adding many players at once? Use Import Excel above — you'll preview before anything is saved.</span>
          </Card>
          {importAnalysis && (
            <PlayerImportModal
              analysis={importAnalysis}
              data={data}
              command={command}
              tournamentId={data.tournament.id}
              onClose={() => setImportAnalysis(null)}
              onImported={async () => {
                await load();
                toast("Import complete");
              }}
            />
          )}
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
            <Input label="Search players" hideLabel value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search players" />
            <span className="muted" style={{ fontSize: "var(--text-sm)" }}>
              {filtered.length} player{filtered.length === 1 ? "" : "s"} · {data.participants.length} registered {data.participants.length === 1 ? "entry" : "entries"}
            </span>
            {somePlayersChecked && (
              <Button variant="danger" className="compact" disabled={deletingPlayers} onClick={() => setConfirmDeletePlayers(true)}>
                <Trash2 size={14} aria-hidden="true" /> Delete Selected ({checkedPlayerCount})
              </Button>
            )}
          </div>
          {confirmDeletePlayers && (
            <ConfirmDialog
              title={`Delete ${checkedPlayerCount} selected player${checkedPlayerCount === 1 ? "" : "s"}?`}
              body="This action cannot be undone. Players already registered into a division are protected and won't be deleted."
              confirmLabel="Delete selected"
              danger
              busy={deletingPlayers}
              onCancel={() => setConfirmDeletePlayers(false)}
              onConfirm={deleteSelectedPlayers}
            />
          )}
          {data.persons.length === 0 ? (
            <EmptyState title="No players">Add a player, then register them into a division.</EmptyState>
          ) : (
            <Table
              responsive
              columns={[
                {
                  key: "select",
                  header: (
                    <Checkbox
                      ref={headerPlayerCheckboxRef}
                      aria-label="Select all removable players"
                      checked={allPlayersChecked}
                      disabled={!removableFiltered.length}
                      onChange={toggleAllPlayers}
                    />
                  ),
                  render: (p) => {
                    const registered = entryCountFor(p.id) > 0;
                    return (
                      <Checkbox
                        aria-label={`Select ${p.display_name}`}
                        checked={checkedPlayerIds.has(p.id)}
                        disabled={registered}
                        title={registered ? "Already registered into a division — remove that entry first" : undefined}
                        onChange={() => togglePlayer(p.id)}
                      />
                    );
                  },
                },
                {
                  key: "display_name",
                  header: "Player",
                  render: (p) => {
                    if (editingPersonId === p.id) {
                      return (
                        <form className="row" style={{ gap: 6, flexWrap: "nowrap" }} onSubmit={(e) => saveRename(e, p)}>
                          <Input label="Player name" hideLabel value={editName} onChange={(e) => setEditName(e.target.value)} autoFocus required />
                          <Button type="submit" className="compact" disabled={!!busy}>Save</Button>
                          <Button type="button" variant="secondary" className="compact" onClick={() => setEditingPersonId(null)}>Cancel</Button>
                        </form>
                      );
                    }
                    return (
                      <div className="row" style={{ gap: 6, alignItems: "center", flexWrap: "nowrap" }}>
                        <span>{p.display_name}</span>
                        <Button type="button" variant="ghost" className="compact" onClick={() => startRename(p)}>Edit</Button>
                      </div>
                    );
                  },
                },
                {
                  key: "entry",
                  header: "Entry",
                  render: (p) => {
                    const member = (data.participantMembers || []).find((m) => m.person_id === p.id);
                    const participant = member ? data.participants.find((pt) => pt.id === member.participant_id) : null;
                    if (!participant) return <span className="muted">—</span>;
                    return isPairEntry(participant, data.participantMembers) ? "Pair" : "Individual";
                  },
                },
                {
                  key: "division_team",
                  header: "Division / Team",
                  render: (p) => {
                    const member = (data.participantMembers || []).find((m) => m.person_id === p.id);
                    const participant = member ? data.participants.find((pt) => pt.id === member.participant_id) : null;
                    if (!participant) return <span className="muted">Not registered</span>;
                    const division = data.divisions.find((d) => d.id === participant.division_id)?.name || "—";
                    const team = data.teams.find((t) => t.id === participant.team_id)?.name;
                    return team ? `${division} · ${team}` : division;
                  },
                },
                {
                  key: "status",
                  header: "Status",
                  render: (p) => {
                    const registered = entryCountFor(p.id) > 0;
                    return <Badge tone={registered ? "ok" : "muted"}>{registered ? "Registered" : "Unregistered"}</Badge>;
                  },
                },
              ]}
              rows={filtered}
              empty={<EmptyState title="No matching players" />}
            />
          )}
        </div>
      )}

      {section === "registration" && (
        <div className="stack">
          <Card as="form" className="stack" onSubmit={(e) => {
            e.preventDefault();
            if (entryMode === "pair") registerPair();
            else registerIndividual();
          }}>
            <h2>Register into division</h2>
            <Select label="Entry type" value={entryMode} onChange={(e) => setEntryMode(e.target.value)}>
              <option value="pair">Pair / team entry</option>
              <option value="individual">Individual player</option>
            </Select>
            <Select label="Division" value={divisionId} onChange={(e) => setDivisionId(e.target.value)}>
              {data.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
            {entryMode === "pair" ? (
              <>
                <Select label="Player 1" value={player1} onChange={(e) => setPlayer1(e.target.value)}>
                  <option value="">Select / add player</option>
                  {p1Options.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </Select>
                <Select label="Player 2" value={player2} onChange={(e) => setPlayer2(e.target.value)}>
                  <option value="">Select / add player</option>
                  {p2Options.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
                </Select>
              </>
            ) : (
              <Select label="Player" value={individualId} onChange={(e) => setIndividualId(e.target.value)}>
                <option value="">Select / add player</option>
                {available.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </Select>
            )}
            <Select label="Team (optional grouping)" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">None</option>
              {teamsForDivision.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
            <Input label="Seed" value={seed} onChange={(e) => setSeed(e.target.value)} inputMode="numeric" />
            <Button
              type="submit"
              disabled={!!busy || !data.divisions.length || (entryMode === "pair" ? !player1 || !player2 : !individualId)}
            >
              {entryMode === "pair" ? "Register pair" : "Register individual"}
            </Button>
            <p className="muted">Players already assigned to a pair or another team in this division are hidden here and rejected by the server.</p>
          </Card>
          <div className="section-label">Division entries</div>
          {data.participants.length === 0 ? (
            <EmptyState title="No entries yet">Register a player or a pair into a division.</EmptyState>
          ) : (
            <Table
              responsive
              columns={[
                {
                  key: "kind",
                  header: "Type",
                  render: (p) => isPairEntry(p, data.participantMembers) ? "Pair / team entry" : "Individual player",
                },
                {
                  key: "display_name",
                  header: "Name",
                  render: (p) => {
                    const members = membersOfParticipant(p.id, data.participantMembers);
                    if (members.length >= 2) {
                      return (
                        <div>
                          <div>{p.display_name}</div>
                          <div className="muted">
                            {members.map((m) => personLabel(m.person_id, data.persons)).join(" · ")}
                          </div>
                        </div>
                      );
                    }
                    return p.display_name;
                  },
                },
                { key: "seed", header: "Seed", render: (p) => p.seed ?? "—" },
                { key: "division", header: "Division", render: (p) => data.divisions.find((d) => d.id === p.division_id)?.name },
                { key: "team", header: "Team", render: (p) => data.teams.find((t) => t.id === p.team_id)?.name || "—" },
                {
                  key: "remove",
                  header: "",
                  render: (p) => (
                    <Button variant="danger" disabled={!!busy} onClick={() => run("Remove entry", "remove_participant", { participant_id: p.id }, true)}>
                      Remove
                    </Button>
                  ),
                },
              ]}
              rows={data.participants}
            />
          )}
        </div>
      )}
    </div>
  );
}
