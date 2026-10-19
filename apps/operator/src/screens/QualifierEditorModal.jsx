import { useState } from "react";
import { Alert, Badge, Button, Input, Modal, Select } from "@tournament/ui";
import { seededPlayoffSlots, teamEliminationStandings } from "../lib.js";

// Edit qualifiers (team elimination): the organizer corrects which pair holds
// a seeded playoff slot — e.g. a wrongly generated semifinal qualifier — with
// another pair of the SAME team (replace_playoff_qualifier). This never edits
// the qualification results: the automatic qualifier stays recorded on the
// server (knockout stage config.auto_slots) next to every override (who, when,
// why). Refused once the matchup or its pair match has started. Player names
// are corrected in Players → Rename, which updates every view.
export default function QualifierEditorModal({ division, data, command, onClose, onSaved }) {
  const slots = seededPlayoffSlots(division, data);
  const standings = teamEliminationStandings(division, data);
  const [editing, setEditing] = useState(null); // `${matchId}:${slot}`
  const [choice, setChoice] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const entry = (pid) => (data.participants || []).find((p) => p.id === pid);
  const nameOf = (pid) => entry(pid)?.display_name || "—";
  const teamName = (tid) => (data.teams || []).find((t) => t.id === tid)?.name || "—";
  const rankOf = (pid) => standings.find((r) => r.registrationId === pid);
  const rankInTeam = (pid) => {
    const row = rankOf(pid);
    if (!row) return null;
    return standings.filter((r) => r.teamId === row.teamId).findIndex((r) => r.registrationId === pid) + 1;
  };
  const why = (pid) => {
    const row = rankOf(pid);
    if (!row) return "No qualification record";
    const diff = row.pointDiff > 0 ? `+${row.pointDiff}` : String(row.pointDiff);
    return `#${rankInTeam(pid)} in team · ${row.wins}W-${row.losses}L · ${diff}`;
  };
  const knockoutStage = (data.stages || []).find((s) => s.division_id === division.id && s.kind === "team_knockout");
  const qualifierCount = knockoutStage?.config?.qualifierCount ?? division.config?.qualifierCount ?? 2;
  const placed = new Set(slots.map((x) => x.participantId).filter(Boolean));
  const eligibleFor = (x) => (data.participants || [])
    .filter((p) => p.division_id === division.id && p.team_id && p.team_id === x.teamId && !placed.has(p.id))
    .sort((p, q) => (rankOf(p.id)?.rank ?? Infinity) - (rankOf(q.id)?.rank ?? Infinity));

  function start(x) {
    setEditing(`${x.match.id}:${x.slot}`);
    setChoice("");
    setReason("");
    setError("");
  }

  async function save(x) {
    setBusy(true);
    setError("");
    try {
      await command("replace_playoff_qualifier", {
        match_id: x.match.id,
        slot: x.slot,
        participant_id: choice,
        expected_participant_id: x.participantId,
        reason: reason.trim(),
      });
      await onSaved?.();
      setEditing(null);
    } catch (err) {
      setError(err.message || "The qualifier was not changed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Edit qualifiers — ${division.name}`} onClose={() => !busy && onClose()}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Playoff slots filled from qualification. Replacing a pair only changes who plays in that slot; the qualification results
          and the automatic qualifier stay on record. A slot can't be changed once its match has started.
        </p>
        {slots.map((x, i) => {
          const key = `${x.match.id}:${x.slot}`;
          const open = editing === key;
          const options = open ? eligibleFor(x) : [];
          const label = `${x.stageTitle} ${slotNumber(slots, x)} · side ${x.slot}`.replace("  ", " ");
          return (
            <div key={key} className="stack" style={{ gap: 6, paddingTop: i ? 10 : 0, borderTop: i ? "1px solid var(--line, #ddd)" : "none" }}>
              <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                <strong>{label}</strong>
                <div className="row" style={{ gap: 6 }}>
                  {x.overridden && <Badge tone="warn">Manual override</Badge>}
                  {x.locked && <Badge>Started — locked</Badge>}
                </div>
              </div>
              <div>
                {nameOf(x.participantId)} <span className="muted">· {teamName(x.teamId)} · {why(x.participantId)}</span>
              </div>
              {x.participantId && rankInTeam(x.participantId) > qualifierCount && (
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Under the current qualification ranking this pair is outside its team's top {qualifierCount}. Slots never change automatically — replace it here if needed.
                </div>
              )}
              {x.overridden && (
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  Automatic qualifier: {nameOf(x.autoParticipantId)} ({why(x.autoParticipantId)})
                  {x.overrides.length ? ` · last change: ${x.overrides.at(-1).reason}` : ""}
                </div>
              )}
              {!open && !x.locked && x.participantId && (
                <div>
                  <Button type="button" variant="secondary" className="compact" disabled={busy} onClick={() => start(x)}>Replace…</Button>
                </div>
              )}
              {open && (
                <div className="stack" style={{ gap: 6 }}>
                  {options.length === 0 ? (
                    <Alert tone="warn">No other pair of {teamName(x.teamId)} is available (every other pair of this team already holds a playoff slot).</Alert>
                  ) : (
                    <Select label={`Replacement pair from ${teamName(x.teamId)}`} value={choice} disabled={busy} onChange={(e) => setChoice(e.target.value)}>
                      <option value="">Choose a pair</option>
                      {options.map((p) => <option key={p.id} value={p.id}>{p.display_name} — {why(p.id)}</option>)}
                    </Select>
                  )}
                  <Input label="Reason (required)" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} placeholder="e.g. wrong pair seeded, score sheet error" />
                  {error && <Alert>{error}</Alert>}
                  <div className="row">
                    <Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button>
                    <Button type="button" disabled={busy || !choice || !reason.trim()} onClick={() => save(x)}>{busy ? "Saving…" : "Save"}</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        <div className="row">
          <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

// "Semifinals 1", "Semifinals 2", … — the matchup's position within its stage.
function slotNumber(slots, x) {
  const matchIds = [...new Set(slots.filter((y) => y.stageTitle === x.stageTitle).map((y) => y.match.id))];
  return matchIds.length > 1 ? matchIds.indexOf(x.match.id) + 1 : "";
}
