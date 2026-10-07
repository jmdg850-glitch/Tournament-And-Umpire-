import { useRef, useState } from "react";
import { Alert, Badge, Button, Card, Dropdown, EmptyState, GameTimer, Input, Modal, SectionHeader, Select, ServeIndicator, Stat, StatusBadge, Table, TickNumber, useNow } from "@tournament/ui";
import { ExternalLink } from "lucide-react";
import { validateFinalScore, timerView, formatClock, MIN_GAME_TIME_SEC, MAX_GAME_TIME_SEC } from "@tournament/engine";
import { openLiveMatchWindow, openMatchDisplayWindow } from "../useRealtimeChannel.js";
import { CollapsibleSection, ExpandCollapseAll, useCollapsedSections } from "../CollapsibleSection.jsx";
import {
  courtFor,
  memberName,
  membersOfParticipant,
  normalizePersonName,
  personLabel,
  playableMatches,
  nextSeqAfterOutOfOrder,
  scoringTargetFor,
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
function EditScoreModal({ match, target, nameA, nameB, command, onClose, onSaved }) {
  const state = match.score_state || {};
  const winTo = target || 11;
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
  // Same rule the engine enforces: race to winTo, no deuce (e.g. 11–10 / 15–14 end the match).
  const check = validNumbers ? validateFinalScore(nextA, nextB, winTo) : null;
  const scoreError = check && !check.ok ? check.reason : "";
  const canContinue = validNumbers && !unchanged && !scoreError && !busy;

  async function submit() {
    setBusy(true);
    setError("");
    const send = (seq) => command("score_event", {
      match_id: match.id,
      event_id: crypto.randomUUID(),
      seq,
      type: "correction",
      payload: { scoreA: nextA, scoreB: nextB, reason: reason.trim() || undefined },
    }, { durable: true });
    try {
      try {
        await send((state.lastSeq || 0) + 1);
      } catch (err) {
        // The umpire may have scored since this screen last refreshed.
        const retrySeq = nextSeqAfterOutOfOrder(err);
        if (retrySeq == null) throw err;
        await send(retrySeq);
      }
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
        <p className="muted" style={{ margin: 0 }}>Game {state.gameNumber || 1} · {nameA} vs {nameB} · Race to {winTo}</p>
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
        {scoreError && <Alert>{scoreError}</Alert>}
        {check?.ok && check.complete && !unchanged && (
          <p className="muted" style={{ margin: 0 }}>This score ends the match — first to {winTo} wins.</p>
        )}
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

// Game timer readout. Its own component so only it re-renders on each tick;
// the value is always recomputed from the match's persisted timer (the same
// anchor every device uses), so realtime updates and reloads never restart it.
export function MatchTimerClock({ match, className }) {
  const running = timerView(match, Date.now()).state === "running";
  const now = useNow(running);
  const view = timerView(match, now);
  return <GameTimer view={view} clock={formatClock(view.remainingMs)} className={className} />;
}

// Same rules as the server (set_match_timer): the game time is set before the
// match has ever started (no started_at); once started — live, held, or
// resumed after a Hold — a timer can only be adjusted or reset, so a resumed
// match keeps its remaining time. A started match with NO timer can still be
// given one (the Operator taking over when there is no umpire).
const TIMER_SETUP_STATUSES = new Set(["scheduled", "ready", "assigned", "postponed"]);
function matchHasStarted(match) {
  return match?.status === "in_progress" || (TIMER_SETUP_STATUSES.has(match?.status) && Boolean(match?.started_at));
}
export function canControlGameTimer(match) {
  return match?.status === "in_progress" || TIMER_SETUP_STATUSES.has(match?.status);
}

// Organizer game-timer control, via the set_match_timer command (authorized
// on the server — organizer/admin only). Before start: set/clear the game
// time; the countdown itself only begins when the match is started. Live or
// on hold: add/remove a minute or reset to the full time. Never changes the
// score or the match status.
function GameTimerModal({ match, data, command, onClose, onSaved }) {
  const a = sideOf(match.id, "A", data);
  const b = sideOf(match.id, "B", data);
  const view = timerView(match, Date.now());
  const hasTimer = view.state !== "none";
  const started = matchHasStarted(match);
  const setup = !started && TIMER_SETUP_STATUSES.has(match.status);
  const takeOver = started && !hasTimer && canControlGameTimer(match);
  const live = started && hasTimer;
  const [minutes, setMinutes] = useState(hasTimer ? String(Math.round(view.durationSec / 60)) : "10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const minMin = MIN_GAME_TIME_SEC / 60;
  const maxMin = MAX_GAME_TIME_SEC / 60;

  async function send(payload) {
    setBusy(true);
    setError("");
    try {
      await command("set_match_timer", { match_id: match.id, ...payload });
      await onSaved?.();
      return true;
    } catch (err) {
      setError(err.message || "The timer change was not confirmed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submitSet() {
    const n = Number(minutes);
    if (!/^\d+$/.test(minutes.trim()) || !Number.isInteger(n) || n < minMin || n > maxMin) {
      setError(`Enter whole minutes from ${minMin} to ${maxMin}.`);
      return;
    }
    if (await send({ action: "set", duration_seconds: n * 60 })) onClose();
  }

  return (
    <Modal title="Game timer" onClose={() => !busy && onClose()}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>{a.name} vs {b.name}</p>
        <MatchTimerClock match={match} />
        {(setup || takeOver) && (
          <>
            <Input
              label="Game time (minutes)"
              inputMode="numeric"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
              hint={!takeOver
                ? "The countdown starts when the match is started, not now."
                : match.status === "in_progress"
                  ? "The match is live: the countdown starts now."
                  : "The countdown starts when the match is started again."}
              disabled={busy}
            />
            <div className="row">
              {setup && hasTimer && (
                <Button variant="secondary" disabled={busy} onClick={async () => { if (await send({ action: "clear" })) onClose(); }}>
                  Remove timer
                </Button>
              )}
              <Button disabled={busy} onClick={submitSet}>{busy ? "Saving…" : "Set game time"}</Button>
            </div>
          </>
        )}
        {live && (
          <div className="row" style={{ flexWrap: "wrap" }}>
            <Button variant="secondary" disabled={busy} onClick={() => send({ action: "adjust", delta_seconds: 60 })}>+1 min</Button>
            <Button variant="secondary" disabled={busy} onClick={() => send({ action: "adjust", delta_seconds: -60 })}>−1 min</Button>
            <Button variant="secondary" disabled={busy} onClick={() => send({ action: "reset" })}>Reset to {Math.round(view.durationSec / 60)} min</Button>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        <div className="row">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

export function LiveTiles({ data, matches, onOpenLiveWindow, command, load }) {
  const [editingId, setEditingId] = useState(null);
  const editingMatch = editingId ? matches.find((m) => m.id === editingId) : null;
  const [timerId, setTimerId] = useState(null);
  const timerMatch = timerId ? matches.find((m) => m.id === timerId) : null;
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
            <div className="pts"><TickNumber value={sa} /> – <TickNumber value={sb} /></div>
            <div className="live-tile-names">{a.name} vs {b.name}</div>
            {division && <div className="muted live-tile-division">{division.name}</div>}
            <div className="muted live-tile-meta">
              Game {m.score_state?.gameNumber || 1}
              {ump ? ` · ${ump.name}` : ""}
            </div>
            <ServeIndicator state={m.score_state} className="live-tile-serve" />
            <MatchTimerClock match={m} className="live-tile-timer" />
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
            {command ? (
              <Button
                variant="ghost"
                className="compact"
                style={{ marginTop: 2, width: "100%" }}
                onClick={() => setTimerId(m.id)}
              >
                Game timer
              </Button>
            ) : null}
          </div>
        );
      })}
      {timerMatch && (
        <GameTimerModal
          match={timerMatch}
          data={data}
          command={command}
          onClose={() => setTimerId(null)}
          onSaved={load}
        />
      )}
      {editingMatch && (
        <EditScoreModal
          match={editingMatch}
          target={scoringTargetFor(editingMatch, data.matches)}
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
  // Kept across a failed save so "Try again" doesn't create the same new
  // person twice or re-apply a side that already succeeded.
  const createdPeople = useRef(new Map());
  const savedSides = useRef(new Map());

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
        const sideKey = JSON.stringify(texts);
        if (savedSides.current.get(side.slot) === sideKey) continue; // already applied on an earlier attempt
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
            const key = normalizePersonName(resolved.text);
            let personId = createdPeople.current.get(key);
            if (!personId) {
              const out = await command("add_person", { tournament_id: data.tournament.id, display_name: resolved.text });
              personId = out.result.person.id;
              createdPeople.current.set(key, personId);
            }
            personIds.push(personId);
          }
        }
        await command("update_match_participant", { match_id: match.id, slot: side.slot, person_ids: personIds });
        savedSides.current.set(side.slot, sideKey);
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
  // Decided by stage and enforced by the server — shown, not chosen.
  const winTo = scoringTargetFor(match, data.matches);
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
        <p style={{ margin: 0 }}><strong>Race to {winTo}</strong> <span className="muted">— set by stage; the first team to {winTo} wins (no deuce).</span></p>
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

function MatchTable({ data, rows, busy, run, command, load, hideDivision }) {
  const [editingPlayersId, setEditingPlayersId] = useState(null);
  const editingPlayersMatch = editingPlayersId ? rows.find((m) => m.id === editingPlayersId) : null;
  const [overrideStartId, setOverrideStartId] = useState(null);
  const overrideStartMatch = overrideStartId ? rows.find((m) => m.id === overrideStartId) : null;
  const [timerId, setTimerId] = useState(null);
  const timerMatch = timerId ? rows.find((m) => m.id === timerId) : null;
  return (
    <>
    <Table
      responsive
      columns={[
        ...(hideDivision ? [] : [{
          key: "division",
          header: "Division",
          render: (m) => data.divisions.find((d) => d.id === m.division_id)?.name || "—",
        }]),
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
              value={data.courtAssignments.find((c) => c.match_id === m.id)?.court_id || ""}
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
              value={data.umpireAssignments.find((c) => c.match_id === m.id)?.user_id || ""}
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
            const canTimer = canControlGameTimer(m);
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
                {(canEditPlayers || canOverrideStart || canTimer) && (
                  <Dropdown label="More">
                    {canEditPlayers && (
                      <Button type="button" variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => setEditingPlayersId(m.id)}>
                        Edit players
                      </Button>
                    )}
                    {canTimer && (
                      <Button type="button" variant="ghost" style={{ width: "100%", justifyContent: "flex-start" }} onClick={() => setTimerId(m.id)}>
                        Game timer…
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
    {timerMatch && (
      <GameTimerModal
        match={timerMatch}
        data={data}
        command={command}
        onClose={() => setTimerId(null)}
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

const OTHER_GROUP_ID = "__other__";

// Splits rows into per-division groups in the Divisions tab's order; rows
// whose division isn't known (shouldn't happen, but never drop a match) go
// into a trailing "Other" group. Empty groups are omitted.
function groupByDivision(rows, divisions) {
  const known = new Set(divisions.map((d) => d.id));
  const groups = divisions
    .map((d) => ({ id: d.id, name: d.name, rows: rows.filter((m) => m.division_id === d.id) }))
    .filter((g) => g.rows.length > 0);
  const orphans = rows.filter((m) => !known.has(m.division_id));
  if (orphans.length) groups.push({ id: OTHER_GROUP_ID, name: "Other", rows: orphans });
  return groups;
}

function countLabel(n, label) {
  return n ? `${n} ${label}` : null;
}

// One collapsible section per division, each holding the same MatchTable the
// flat view uses (minus the now-redundant Division column). With a single
// division there's nothing to navigate between, so the flat table is kept.
function DivisionMatchGroups({ data, rows, sections, summaryFor, tableProps }) {
  const groups = groupByDivision(rows, data.divisions);
  if (groups.length <= 1) return <MatchTable data={data} rows={rows} {...tableProps} />;
  return (
    <div className="collapsible-list">
      {groups.map((g) => (
        <CollapsibleSection
          key={g.id}
          title={g.name}
          summary={summaryFor(g)}
          open={sections.isOpen(g.id)}
          onToggle={() => sections.toggle(g.id)}
        >
          <MatchTable data={data} rows={g.rows} hideDivision {...tableProps} />
        </CollapsibleSection>
      ))}
    </div>
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
  const queued = upcoming.concat(other);
  const tournamentId = data.tournament?.id || "";
  const queuedSections = useCollapsedSections(`resetiq:collapsed:matches-upcoming:${tournamentId}`);
  const completedSections = useCollapsedSections(`resetiq:collapsed:matches-completed:${tournamentId}`);
  const queuedIds = groupByDivision(queued, data.divisions).map((g) => g.id);
  const completedIds = groupByDivision(completed, data.divisions).map((g) => g.id);
  const queuedSummary = (g) => [
    countLabel(g.rows.filter((m) => m.status !== "postponed").length, "upcoming"),
    countLabel(g.rows.filter((m) => m.status === "postponed").length, "on hold"),
    countLabel(live.filter((m) => m.division_id === g.id).length, "live"),
  ].filter(Boolean).join(" · ");
  const completedSummary = (g) => `${g.rows.length} completed`;

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
        <div className="row section-label-row">
          <div className="section-label" style={{ margin: 0 }}>Upcoming</div>
          <ExpandCollapseAll ids={queuedIds} sections={queuedSections} />
        </div>
        {queued.length === 0 ? (
          <EmptyState title="Nothing queued">Generate a bracket and assign courts and umpires to schedule matches.</EmptyState>
        ) : (
          <DivisionMatchGroups
            data={data}
            rows={queued}
            sections={queuedSections}
            summaryFor={queuedSummary}
            tableProps={{ busy, run, command, load }}
          />
        )}
      </div>

      {completed.length > 0 && (
        <div>
          <div className="row section-label-row">
            <div className="section-label" style={{ margin: 0 }}>Completed ({completed.length})</div>
            <div className="row" style={{ gap: 6 }}>
              {showCompleted && <ExpandCollapseAll ids={completedIds} sections={completedSections} />}
              <Button variant="ghost" className="compact" onClick={() => setShowCompleted((v) => !v)}>
                {showCompleted ? "Hide" : "Show"}
              </Button>
            </div>
          </div>
          {showCompleted && (
            <div className="reveal">
              <DivisionMatchGroups
                data={data}
                rows={completed}
                sections={completedSections}
                summaryFor={completedSummary}
                tableProps={{ busy, run }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
