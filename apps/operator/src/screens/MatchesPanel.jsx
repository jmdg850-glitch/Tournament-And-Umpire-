import { useState } from "react";
import { Alert, Badge, Button, Card, Dropdown, EmptyState, Input, Modal, SectionHeader, Select, ServeIndicator, Stat, StatusBadge, Table } from "@tournament/ui";
import { ExternalLink } from "lucide-react";
import { openLiveMatchWindow, openMatchDisplayWindow } from "../useRealtimeChannel.js";
import {
  courtFor,
  memberName,
  membersOfParticipant,
  normalizePersonName,
  personLabel,
  playableMatches,
  resolvePersonByName,
  resultFor,
  scoreLine,
  sideOf,
  stageTitle,
  umpireFor,
} from "../lib.js";

// Edit Score / Instant Score Entry — sends a "correction" score_event through
// the same command/engine/audit pipeline as normal point-scoring (see
// packages/engine/src/scoring.js applyScoreEvent's "correction" case and
// packages/api/src/handleCommand.js handleScoreEvent). Only reachable for
// live (in-progress) matches from this entry point.
function EditScoreModal({ match, nameA, nameB, command, onClose, onSaved }) {
  const state = match.score_state || {};
  const [scoreA, setScoreA] = useState(String(state.scoreA ?? 0));
  const [scoreB, setScoreB] = useState(String(state.scoreB ?? 0));
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function digitsOnly(v) { return v.replace(/[^0-9]/g, "").slice(0, 4); }
  function step(setter, value, delta) {
    const n = Math.max(0, (Number.parseInt(value, 10) || 0) + delta);
    setter(String(n));
  }

  const nextA = Number.parseInt(scoreA, 10);
  const nextB = Number.parseInt(scoreB, 10);
  const validNumbers = scoreA !== "" && scoreB !== "" && Number.isInteger(nextA) && Number.isInteger(nextB) && nextA >= 0 && nextB >= 0;
  const unchanged = validNumbers && nextA === (state.scoreA ?? 0) && nextB === (state.scoreB ?? 0);
  const canContinue = validNumbers && !unchanged && !busy;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await command("score_event", {
        match_id: match.id,
        event_id: crypto.randomUUID(),
        seq: (state.lastSeq || 0) + 1,
        type: "correction",
        payload: { scoreA: nextA, scoreB: nextB, reason: reason.trim() || undefined },
      }, { durable: true });
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Could not save the correction");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit score" onClose={() => !busy && onClose()}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>Game {state.gameNumber || 1} · {nameA} vs {nameB}</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="stack" style={{ gap: 4 }}>
            <Input label={nameA} inputMode="numeric" value={scoreA} onChange={(e) => setScoreA(digitsOnly(e.target.value))} />
            <div className="row" style={{ gap: 6 }}>
              <Button type="button" variant="secondary" className="compact" onClick={() => step(setScoreA, scoreA, -1)} disabled={busy}>−1</Button>
              <Button type="button" variant="secondary" className="compact" onClick={() => step(setScoreA, scoreA, 1)} disabled={busy}>+1</Button>
            </div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <Input label={nameB} inputMode="numeric" value={scoreB} onChange={(e) => setScoreB(digitsOnly(e.target.value))} />
            <div className="row" style={{ gap: 6 }}>
              <Button type="button" variant="secondary" className="compact" onClick={() => step(setScoreB, scoreB, -1)} disabled={busy}>−1</Button>
              <Button type="button" variant="secondary" className="compact" onClick={() => step(setScoreB, scoreB, 1)} disabled={busy}>+1</Button>
            </div>
          </div>
        </div>
        <Input label="Reason (optional)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this score being corrected?" />
        {error && <Alert>{error}</Alert>}
        {!confirming ? (
          <div className="row">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="button" disabled={!canContinue} onClick={() => setConfirming(true)}>Save score</Button>
          </div>
        ) : (
          <>
            <p style={{ margin: 0 }}>Change score from {state.scoreA ?? 0}–{state.scoreB ?? 0} to {nextA}–{nextB}?</p>
            <div className="row">
              <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
              <Button type="button" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Apply correction"}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

export function LiveTiles({ data, matches, onOpenLiveWindow, command, load }) {
  const [editingId, setEditingId] = useState(null);
  const editingMatch = editingId ? matches.find((m) => m.id === editingId) : null;
  return (
    <div className="live-strip">
      {matches.map((m) => {
        const a = sideOf(m.id, "A", data);
        const b = sideOf(m.id, "B", data);
        const court = courtFor(m, data);
        const ump = umpireFor(m, data);
        const division = data.divisions.find((d) => d.id === m.division_id);
        const sa = m.score_state?.scoreA ?? 0;
        const sb = m.score_state?.scoreB ?? 0;
        return (
          <div key={m.id} className="live-tile">
            <div className="kicker">{court?.name || "Unassigned court"}</div>
            <div className="live-tile-status">LIVE</div>
            <div className="pts">{sa} – {sb}</div>
            <div className="live-tile-names">{a.name} vs {b.name}</div>
            {division && <div className="muted live-tile-division">{division.name}</div>}
            <div className="muted live-tile-meta">
              Game {m.score_state?.gameNumber || 1}
              {ump ? ` · ${ump.name}` : ""}
            </div>
            <ServeIndicator state={m.score_state} className="live-tile-serve" />
            {onOpenLiveWindow ? (
              <Button
                variant="tape"
                style={{ marginTop: 10, width: "100%" }}
                onClick={() => onOpenLiveWindow(m.id)}
              >
                Open Live <ExternalLink size={15} aria-hidden="true" />
              </Button>
            ) : null}
            {command ? (
              <Button
                variant="ghost"
                className="compact"
                style={{ marginTop: 6, width: "100%" }}
                onClick={() => setEditingId(m.id)}
              >
                Edit score
              </Button>
            ) : null}
          </div>
        );
      })}
      {editingMatch && (
        <EditScoreModal
          match={editingMatch}
          nameA={sideOf(editingMatch.id, "A", data).name}
          nameB={sideOf(editingMatch.id, "B", data).name}
          command={command}
          onClose={() => setEditingId(null)}
          onSaved={load}
        />
      )}
    </div>
  );
}

const EDITABLE_PLAYERS_STATUSES = new Set(["scheduled", "ready", "assigned", "postponed"]);

// Edit Players / Change Partner — repoints one side's player pairing for a
// not-yet-started match via update_match_participant (see
// packages/api/src/handleCommand.js). This never edits the master `persons`
// record and never mutates the existing participant/pairing in place — the
// server creates a fresh pairing (preserving the old one's kind/team_id/seed,
// so the replacement lands in the same team/participant context automatically)
// and repoints only this match's assignment, so any other match that already
// used the old pairing (e.g. an earlier completed round) is left untouched.
//
// State is deliberately split in two: `side.players[i].name` is the CURRENT
// assignment (display-only, never written into an input's value), while
// `replacementText[slot][i]` is a separate, independently-blank string per
// row — typing in one never touches the other. A blank replacement means
// "no change" for that player; only rows with typed text are sent.
function EditPlayersModal({ match, data, command, onClose, onSaved }) {
  const sides = ["A", "B"].map((slot) => {
    const side = sideOf(match.id, slot, data);
    const members = side.participant ? membersOfParticipant(side.participant.id, data.participantMembers) : [];
    return {
      slot,
      participant: side.participant,
      players: members.map((m) => ({ personId: m.person_id, name: personLabel(m.person_id, data.persons) })),
    };
  });

  const [replacementText, setReplacementText] = useState(() =>
    Object.fromEntries(sides.map((s) => [s.slot, s.players.map(() => "")]))
  );
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function setText(slot, index, value) {
    setReplacementText((prev) => {
      const next = [...prev[slot]];
      next[index] = value;
      return { ...prev, [slot]: next };
    });
    setError("");
  }

  function suggestionsFor(text) {
    const q = normalizePersonName(text);
    if (!q) return [];
    return data.persons.filter((p) => normalizePersonName(p.display_name).includes(q)).slice(0, 5);
  }

  // One entry per row that actually has typed text — the only rows that will
  // change. Everything else keeps its current player untouched.
  const changedRows = [];
  for (const side of sides) {
    side.players.forEach((player, i) => {
      const resolved = resolvePersonByName(replacementText[side.slot][i], data.persons);
      if (resolved) changedRows.push({ slot: side.slot, index: i, currentName: player.name, resolved });
    });
  }

  // Light, client-side guard: don't let this one edit resolve two different
  // rows to the identical target (existing person or same new name) — a real
  // cross-side/duplicate-in-division check is already enforced server-side by
  // update_match_participant itself, and its message is surfaced on failure.
  const targetKeys = changedRows.map((r) => normalizePersonName(r.resolved.existingPerson?.display_name || r.resolved.text));
  const hasInternalDuplicate = new Set(targetKeys).size !== targetKeys.length;
  const canContinue = changedRows.length > 0 && !hasInternalDuplicate && !busy;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      for (const side of sides) {
        const texts = replacementText[side.slot];
        if (!texts.some((t) => t.trim())) continue; // nothing typed on this side — skip entirely
        const personIds = [];
        for (let i = 0; i < side.players.length; i++) {
          const resolved = resolvePersonByName(texts[i], data.persons);
          if (!resolved) {
            personIds.push(side.players[i].personId); // blank — keep the current player in this slot
            continue;
          }
          if (resolved.existingPerson) {
            personIds.push(resolved.existingPerson.id);
          } else {
            const out = await command("add_person", { tournament_id: data.tournament.id, display_name: resolved.text });
            personIds.push(out.result.person.id);
          }
        }
        await command("update_match_participant", { match_id: match.id, slot: side.slot, person_ids: personIds });
      }
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Could not save the player change");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit players" onClose={() => !busy && onClose()}>
      <div className="stack">
        {sides.map((side) => (
          <div key={side.slot} className="stack" style={{ gap: 10 }}>
            <h3 style={{ margin: 0 }}>Side {side.slot}</h3>
            {!side.participant ? (
              <p className="muted" style={{ margin: 0 }}>Not assigned yet.</p>
            ) : (
              side.players.map((player, i) => {
                const text = replacementText[side.slot][i];
                const resolved = resolvePersonByName(text, data.persons);
                const suggestions = suggestionsFor(text).filter((p) => normalizePersonName(p.display_name) !== normalizePersonName(text));
                return (
                  <div key={player.personId} className="stack" style={{ gap: 4 }}>
                    <div>
                      <div className="muted" style={{ fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Current player</div>
                      <div>{player.name}</div>
                    </div>
                    <Input
                      label="Replace player"
                      value={text}
                      disabled={busy}
                      placeholder="Enter player name…"
                      onChange={(e) => setText(side.slot, i, e.target.value)}
                    />
                    {resolved && (
                      resolved.existingPerson
                        ? <div className="muted" style={{ fontSize: "var(--text-sm)" }}>✓ Matches existing player {resolved.existingPerson.display_name}</div>
                        : <div className="muted" style={{ fontSize: "var(--text-sm)" }}>+ Add "{resolved.text}" as new player</div>
                    )}
                    {suggestions.length > 0 && (
                      <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {suggestions.map((p) => (
                          <Button
                            key={p.id}
                            type="button"
                            variant="ghost"
                            className="compact"
                            disabled={busy}
                            onClick={() => setText(side.slot, i, p.display_name)}
                          >
                            {p.display_name}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        ))}
        {hasInternalDuplicate && <Alert>The same replacement player is entered more than once.</Alert>}
        {error && <Alert>{error}</Alert>}
        {!confirming ? (
          <div className="row">
            <Button type="button" variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
            <Button type="button" disabled={!canContinue} onClick={() => setConfirming(true)}>Save changes</Button>
          </div>
        ) : (
          <>
            <p style={{ margin: 0 }}>Change player assignment?</p>
            {changedRows.map((r) => (
              <p key={`${r.slot}-${r.index}`} className="muted" style={{ margin: 0 }}>
                Side {r.slot}: {r.currentName} → {r.resolved.existingPerson?.display_name || r.resolved.text}
              </p>
            ))}
            <div className="row">
              <Button type="button" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>Back</Button>
              <Button type="button" disabled={busy} onClick={submit}>{busy ? "Saving…" : "Confirm change"}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

const OVERRIDE_START_REASONS = [
  "Umpire device unavailable",
  "Manual tournament desk intervention",
  "Umpire connection failure",
];

// Operator-only emergency control — starts a match the normal umpire-starts-
// their-own-match flow can't reach right now. Reuses the existing start_match
// command exactly as the umpire app does (packages/api/src/handleCommand.js
// already treats an organizer starting a match they aren't assigned to as an
// override and requires/records the reason there); this modal just makes that
// explicit and requires a reason before sending it.
function OverrideStartModal({ match, data, command, onClose, onSaved }) {
  const a = sideOf(match.id, "A", data);
  const b = sideOf(match.id, "B", data);
  const [reasonChoice, setReasonChoice] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const reason = (reasonChoice === "Other" ? customReason : reasonChoice).trim();

  async function submit() {
    if (!reason) {
      setError("A reason is required.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await command("start_match", { match_id: match.id, override: true, reason }, { durable: true });
      await onSaved?.();
      onClose();
    } catch (err) {
      setError(err.message || "Could not start this match");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Override start match?" onClose={() => !busy && onClose()}>
      <div className="stack">
        <Alert>This bypasses the normal umpire start flow. Use only when the umpire cannot start the match.</Alert>
        <p className="muted" style={{ margin: 0 }}>{a.name} vs {b.name}</p>
        <Select label="Reason" value={reasonChoice} onChange={(e) => setReasonChoice(e.target.value)} disabled={busy}>
          <option value="">Select a reason…</option>
          {OVERRIDE_START_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
          <option value="Other">Other</option>
        </Select>
        {reasonChoice === "Other" && (
          <Input label="Describe the reason" value={customReason} onChange={(e) => setCustomReason(e.target.value)} disabled={busy} />
        )}
        {error && <Alert>{error}</Alert>}
        <div className="row">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="danger" disabled={busy || !reason} onClick={submit}>{busy ? "Starting…" : "Override start"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function MatchTable({ data, rows, busy, run, command, load }) {
  const [editingPlayersId, setEditingPlayersId] = useState(null);
  const editingPlayersMatch = editingPlayersId ? rows.find((m) => m.id === editingPlayersId) : null;
  const [overrideStartId, setOverrideStartId] = useState(null);
  const overrideStartMatch = overrideStartId ? rows.find((m) => m.id === overrideStartId) : null;
  return (
    <>
    <Table
      responsive
      columns={[
        {
          key: "division",
          header: "Division",
          render: (m) => data.divisions.find((d) => d.id === m.division_id)?.name || "—",
        },
        {
          key: "match",
          header: "Match",
          render: (m) => `${sideOf(m.id, "A", data).name} vs ${sideOf(m.id, "B", data).name}`,
        },
        {
          key: "meta",
          header: "Round",
          render: (m) => `R${m.round}${m.stage_label ? ` · ${stageTitle(m.stage_label)}` : ""}`,
        },
        { key: "status", header: "Status", render: (m) => <StatusBadge status={m.status} /> },
        { key: "score", header: "Score", render: (m) => scoreLine(m, resultFor(m, data.results)) },
        {
          key: "court",
          header: "Court",
          render: (m) => run ? (
            <Select
              label="Assign court"
              hideLabel
              defaultValue={data.courtAssignments.find((c) => c.match_id === m.id)?.court_id || ""}
              disabled={!!busy}
              onChange={(e) => e.target.value && run("Assign court", "assign_court", { match_id: m.id, court_id: e.target.value })}
            >
              <option value="">Assign court</option>
              {data.courts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          ) : (courtFor(m, data)?.name || "—"),
        },
        {
          key: "umpire",
          header: "Umpire",
          render: (m) => run ? (
            <Select
              label="Assign umpire"
              hideLabel
              defaultValue={data.umpireAssignments.find((c) => c.match_id === m.id)?.user_id || ""}
              disabled={!!busy}
              onChange={(e) => e.target.value && run("Assign umpire", "assign_umpire", { match_id: m.id, user_id: e.target.value })}
            >
              <option value="">Assign umpire</option>
              {data.members.filter((x) => ["umpire", "organizer", "admin"].includes(x.role)).map((u) => (
                <option key={u.user_id} value={u.user_id}>{memberName(u.user_id, data.profiles)} ({u.role})</option>
              ))}
            </Select>
          ) : (umpireFor(m, data)?.name || "—"),
        },
        ...(command ? [{
          key: "actions",
          header: "",
          render: (m) => {
            const canEditPlayers = EDITABLE_PLAYERS_STATUSES.has(m.status);
            const canOverrideStart = ["ready", "assigned"].includes(m.status);
            const isHeld = m.status === "postponed";
            return (
              <div className="row" style={{ gap: 6, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                {isHeld && (
                  <Button
                    variant="tape"
                    className="compact"
                    disabled={!!busy}
                    onClick={() => run("Resume match", "transition_match", { match_id: m.id, status: "ready" })}
                  >
                    Resume match
                  </Button>
                )}
                {(canEditPlayers || canOverrideStart) && (
                  <Dropdown label="More">
                    {canEditPlayers && (
                      <Button type="button" variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => setEditingPlayersId(m.id)}>
                        Edit players
                      </Button>
                    )}
                    {canOverrideStart && (
                      <Button type="button" variant="danger" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => setOverrideStartId(m.id)}>
                        Override start…
                      </Button>
                    )}
                  </Dropdown>
                )}
                {!canEditPlayers && !isHeld && (
                  <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                    {m.status === "in_progress" ? "Locked — match started"
                      : m.status === "completed" || m.status === "bye" ? "Locked — match completed"
                      : "No actions available"}
                  </span>
                )}
              </div>
            );
          },
        }] : []),
      ]}
      rows={rows}
      rowProps={(m) => ({
        "data-live": m.status === "in_progress" ? "true" : undefined,
        "data-held": m.status === "postponed" ? "true" : undefined,
      })}
      empty={<EmptyState title="No matches">Generate a bracket from Divisions.</EmptyState>}
    />
    {editingPlayersMatch && (
      <EditPlayersModal
        match={editingPlayersMatch}
        data={data}
        command={command}
        onClose={() => setEditingPlayersId(null)}
        onSaved={load}
      />
    )}
    {overrideStartMatch && (
      <OverrideStartModal
        match={overrideStartMatch}
        data={data}
        command={command}
        onClose={() => setOverrideStartId(null)}
        onSaved={load}
      />
    )}
    </>
  );
}

// A read-only, TV/second-monitor match display per division — every division
// can have its own window open at once, each independently scoped by its
// division id (see MatchDisplayWindow.jsx and useRealtimeChannel.js's
// openMatchDisplayWindow). Opening one never navigates this Operator tab away.
function DivisionMatchWindows({ data }) {
  return (
    <Card className="stack">
      <SectionHeader title="Match displays" description="Open a read-only match display for a division on a second monitor or TV." />
      <div className="grid2">
        {data.divisions.map((d) => {
          const liveCount = data.matches.filter((m) => m.division_id === d.id && m.status === "in_progress").length;
          return (
            <div key={d.id} className="row" style={{ justifyContent: "space-between" }}>
              <div className="row" style={{ gap: 8, alignItems: "center" }}>
                <span>{d.name}</span>
                {liveCount > 0 && <Badge tone="live">{liveCount} live</Badge>}
              </div>
              <Button
                variant="secondary"
                aria-label={`Open match window for ${d.name}`}
                onClick={() => openMatchDisplayWindow(data.tournament.id, d.id)}
              >
                Open Match Window <ExternalLink size={15} aria-hidden="true" />
              </Button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function MatchesPanel({ data, busy, run, command, load }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const rows = playableMatches(data.matches);
  const live = rows.filter((m) => m.status === "in_progress");
  const upcoming = rows.filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const completed = rows.filter((m) => m.status === "completed" || m.status === "bye");
  const held = rows.filter((m) => m.status === "postponed");
  const other = rows.filter((m) => !live.includes(m) && !upcoming.includes(m) && !completed.includes(m));

  return (
    <div className="stack">
      <SectionHeader title="Matches" description="Track every match from upcoming through live to completed, and step in when something needs attention." />
      <div className="grid4">
        <Stat value={rows.length} label="Total matches" />
        <Stat tone={live.length ? "hero live" : "hero"} value={live.length} label="Live" />
        <Stat value={upcoming.length} label="Upcoming" />
        <Stat value={held.length} label="Held" />
        <Stat tone="quiet" value={completed.length} label="Completed" />
      </div>

      {data.divisions.length > 0 && (
        <DivisionMatchWindows data={data} />
      )}

      {live.length > 0 && (
        <div>
          <div className="section-label" style={{ color: "var(--live)" }}>● Live now</div>
          <LiveTiles data={data} matches={live} onOpenLiveWindow={(matchId) => openLiveMatchWindow(data.tournament.id, matchId)} command={command} load={load} />
        </div>
      )}

      <div>
        <div className="section-label">Upcoming</div>
        {upcoming.length + other.length === 0 ? (
          <EmptyState title="Nothing queued">Generate a bracket and assign courts and umpires to schedule matches.</EmptyState>
        ) : (
          <MatchTable data={data} rows={upcoming.concat(other)} busy={busy} run={run} command={command} load={load} />
        )}
      </div>

      {completed.length > 0 && (
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div className="section-label" style={{ margin: 0 }}>Completed ({completed.length})</div>
            <Button variant="ghost" className="compact" onClick={() => setShowCompleted((v) => !v)}>
              {showCompleted ? "Hide" : "Show"}
            </Button>
          </div>
          {showCompleted && <MatchTable data={data} rows={completed} busy={busy} run={run} />}
        </div>
      )}
    </div>
  );
}
