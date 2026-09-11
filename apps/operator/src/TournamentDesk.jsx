import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dropdown,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  NavGroup,
  NavItem,
  PageHeader,
  PageShell,
  Select,
  ServeIndicator,
  SetupChecklist,
  Skeleton,
  Stat,
  StandingsTable,
  StatusBadge,
  Table,
  useToast,
} from "@tournament/ui";
import {
  Award,
  ClipboardList,
  ExternalLink,
  Gauge,
  LayoutGrid,
  MapPin,
  Medal,
  Radio,
  Settings as SettingsIcon,
  Shield,
  Trash2,
  Trophy,
  Users,
} from "lucide-react";
import {
  applyDeskRealtime,
  deskLiveChannelName,
} from "@tournament/engine";
import { BracketsPanel } from "./brackets.jsx";
import { PairingQr } from "./pairingQr.jsx";
import PlayerImportModal from "./PlayerImportModal.jsx";
import { openLiveMatchWindow, useRealtimeChannel } from "./useRealtimeChannel.js";
import { useDesktopUpdateContext } from "./UpdateBanner.jsx";
import {
  DESK_TABS,
  FORMAT_LABEL,
  TOURNAMENT_FLOW,
  TOURNAMENT_STATUS_LABEL,
  assignedPersonIdsInDivision,
  courtFor,
  firstQueryError,
  isPairEntry,
  labelStatus,
  memberName,
  membersOfParticipant,
  normalizePersonName,
  resolvePersonByName,
  pairingQrText,
  personLabel,
  placementsForDivision,
  playableMatches,
  resultFor,
  teamEliminationStandings,
  scoreLine,
  sideOf,
  stageTitle,
  umpireFor,
} from "./lib.js";
import { version as APP_VERSION } from "../package.json";

const TAB_ICON = {
  overview: Gauge,
  live: Radio,
  matches: LayoutGrid,
  courts: MapPin,
  players: Users,
  teams: Shield,
  divisions: ClipboardList,
  brackets: Trophy,
  umpires: Award,
  results: Medal,
  settings: SettingsIcon,
};

const NAV_SECTIONS = [
  { label: null, ids: ["overview"] },
  { label: "Setup", ids: ["divisions", "players", "teams", "courts"] },
  { label: "Run", ids: ["live", "matches", "brackets", "umpires"] },
  { label: "Results", ids: ["results"] },
  { label: null, ids: ["settings"] },
];

export default function TournamentDesk({ supabase, session, command, pendingSync, tournamentId, onBack, onSignOut }) {
  const toast = useToast();
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null);
  const attemptedPlayoffs = useRef(new Set());

  const load = useCallback(async () => {
    // Two phases: the tournament-scoped primary tables first (they carry
    // their own tournament_id filter), then the dependent tables — which
    // have no tournament_id column of their own — scoped by the resulting
    // match/team/participant/division IDs via .in(). This used to fetch
    // match_participants/participant_members/match_results/court_assignments/
    // umpire_assignments/team_members/stages completely unfiltered (every row
    // in the whole Supabase project) and filter client-side, which silently
    // truncated at PostgREST's default response cap once the project
    // accumulated enough tournaments — matches would show as "Side A vs Side
    // B" instead of real names with no error at all. Scoping the query itself
    // (the same .in() pattern already used server-side, e.g.
    // packages/api/src/handleCommand.js's loadDivisionAssignment) fixes this
    // for good, not just for the current row count.
    const primary = await Promise.all([
      supabase.from("tournaments").select("*").eq("id", tournamentId).maybeSingle(),
      supabase.from("divisions").select("*").eq("tournament_id", tournamentId),
      supabase.from("persons").select("*").eq("tournament_id", tournamentId).order("display_name"),
      supabase.from("teams").select("*").eq("tournament_id", tournamentId).order("name"),
      supabase.from("participants").select("*").eq("tournament_id", tournamentId),
      supabase.from("courts").select("*").eq("tournament_id", tournamentId).order("sort_order"),
      supabase.from("tournament_members").select("*").eq("tournament_id", tournamentId),
      supabase.from("matches").select("*").eq("tournament_id", tournamentId).order("round"),
      supabase.from("court_devices").select("*").eq("tournament_id", tournamentId),
      supabase.from("profiles").select("id, display_name"),
    ]);
    const primaryErr = firstQueryError(primary);
    if (primaryErr) {
      setError(primaryErr.message);
      return;
    }
    const [t, divisions, persons, teams, participants, courts, members, matches, courtDevices, profiles] = primary;
    const matchIds = (matches.data || []).map((m) => m.id);
    const teamIds = (teams.data || []).map((x) => x.id);
    const participantIds = (participants.data || []).map((x) => x.id);
    const divisionIds = (divisions.data || []).map((x) => x.id);

    const empty = Promise.resolve({ data: [] });
    const dependent = await Promise.all([
      teamIds.length ? supabase.from("team_members").select("*").in("team_id", teamIds) : empty,
      matchIds.length ? supabase.from("match_results").select("*").in("match_id", matchIds) : empty,
      matchIds.length ? supabase.from("court_assignments").select("*").in("match_id", matchIds) : empty,
      matchIds.length ? supabase.from("umpire_assignments").select("*").in("match_id", matchIds) : empty,
      matchIds.length ? supabase.from("match_participants").select("*").in("match_id", matchIds) : empty,
      participantIds.length ? supabase.from("participant_members").select("*").in("participant_id", participantIds) : empty,
      divisionIds.length ? supabase.from("stages").select("*").in("division_id", divisionIds) : empty,
    ]);
    const dependentErr = firstQueryError(dependent);
    if (dependentErr) {
      setError(dependentErr.message);
      return;
    }
    const [teamMembers, results, courtsA, umpiresA, matchParticipants, participantMembers, stages] = dependent;

    setError("");
    setData({
      tournament: t.data,
      divisions: divisions.data || [],
      persons: persons.data || [],
      teams: teams.data || [],
      teamMembers: teamMembers.data || [],
      participants: participants.data || [],
      participantMembers: participantMembers.data || [],
      stages: stages.data || [],
      courts: courts.data || [],
      members: members.data || [],
      matches: matches.data || [],
      results: results.data || [],
      courtAssignments: courtsA.data || [],
      umpireAssignments: umpiresA.data || [],
      courtDevices: courtDevices.data || [],
      matchParticipants: matchParticipants.data || [],
      profiles: profiles.data || [],
    });
  }, [supabase, tournamentId]);

  const patchLiveTables = useCallback(async () => {
    const queries = await Promise.all([
      supabase.from("matches").select("*").eq("tournament_id", tournamentId).order("round"),
      supabase.from("match_results").select("*"),
      supabase.from("court_assignments").select("*"),
    ]);
    const err = firstQueryError(queries);
    if (err) return;
    const [matches, results, courtsA] = queries;
    const matchIds = new Set((matches.data || []).map((m) => m.id));
    setData((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        matches: matches.data || [],
        results: (results.data || []).filter((r) => matchIds.has(r.match_id)),
        courtAssignments: (courtsA.data || []).filter((r) => matchIds.has(r.match_id)),
      };
    });
  }, [supabase, tournamentId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") patchLiveTables();
    }
    window.addEventListener("focus", patchLiveTables);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", patchLiveTables);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [patchLiveTables]);

  useRealtimeChannel({
    supabase,
    name: deskLiveChannelName(tournamentId),
    enabled: Boolean(tournamentId),
    specs: [
      { event: "*", schema: "public", table: "matches", filter: `tournament_id=eq.${tournamentId}` },
      { event: "*", schema: "public", table: "match_results" },
      { event: "*", schema: "public", table: "court_assignments" },
    ],
    onPayload: (payload) => {
      const table = payload.table;
      const eventType = payload.eventType || payload.event;
      setData((prev) => {
        if (!prev) return prev;
        return applyDeskRealtime(prev, table, eventType, payload.new, payload.old);
      });
    },
    onSubscribed: load,
  });

  useEffect(() => {
    if (!data || busy) return;
    for (const d of data.divisions) {
      if (d.format !== "team_elimination") continue;
      if (d.config?.qualifierMode === "manual") continue;
      if (attemptedPlayoffs.current.has(d.id)) continue;
      const knockout = (data.stages || []).some((s) => s.division_id === d.id && s.kind === "team_knockout");
      if (knockout) continue;
      const rrParents = data.matches.filter((m) => m.division_id === d.id && !m.parent_match_id && m.stage_label === "round_robin");
      if (!rrParents.length || rrParents.some((m) => m.status !== "completed")) continue;
      attemptedPlayoffs.current.add(d.id);
      run("Generate playoffs", "generate_team_playoffs", { division_id: d.id });
    }
  }, [data, busy]);

  async function run(label, type, payload, needsConfirm) {
    if (needsConfirm) {
      setConfirm({ label, type, payload, danger: /cancel|remove|archive/i.test(label) });
      return;
    }
    setBusy(label);
    setError("");
    try {
      const out = await command(type, payload, { durable: true });
      if (out?.queued) {
        toast(`${label} — queued, will sync when back online`);
      } else {
        await load();
        toast(label);
      }
      return out;
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy("");
    }
  }

  const liveMatches = (data?.matches || []).filter((m) => m.status === "in_progress").length;
  useDesktopUpdateContext({
    liveMatches,
    busy: Boolean(busy),
    dialogOpen: Boolean(confirm),
  });

  if (error && !data) {
    return (
      <div className="shell-main">
        <Alert>{error}</Alert>
        <Button style={{ marginTop: 12 }} onClick={load}>Retry</Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="shell-main">
        <LoadingState label="Loading tournament" />
        <div style={{ marginTop: 16 }}><Skeleton lines={6} /></div>
      </div>
    );
  }
  if (!data.tournament) {
    return (
      <div className="shell-main">
        <Alert>This tournament is not available. You may not be a member, or it was removed.</Alert>
        <Button style={{ marginTop: 12 }} onClick={onBack}>Back to tournaments</Button>
      </div>
    );
  }

  const t = data.tournament;
  const idx = TOURNAMENT_FLOW.indexOf(t.status);
  const nextStatus = idx >= 0 && idx < TOURNAMENT_FLOW.length - 1 ? TOURNAMENT_FLOW[idx + 1] : null;
  const live = data.matches.filter((m) => m.status === "in_progress");
  const upcoming = playableMatches(data.matches).filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const completed = data.matches.filter((m) => m.status === "completed" || m.status === "bye");

  const tabLabel = Object.fromEntries(DESK_TABS);

  return (
    <PageShell
      navLabel="Tournament sections"
      brand={<><h1>Tournament</h1><div className="kicker">Control</div></>}
      context={
        <>
          <div className="name">{t.name}</div>
          <StatusBadge status={t.status} kind="tournament" />
        </>
      }
      nav={NAV_SECTIONS.map((section) => (
        <NavGroup key={section.label || section.ids[0]} label={section.label}>
          {section.ids.map((id) => {
            const Icon = TAB_ICON[id];
            return (
              <NavItem
                key={id}
                icon={Icon}
                label={tabLabel[id]}
                active={tab === id}
                live={id === "live" && live.length > 0}
                count={id === "live" && live.length ? live.length : null}
                onClick={() => setTab(id)}
              />
            );
          })}
        </NavGroup>
      ))}
      foot={
        <>
          <div>{session.user.email}</div>
          {pendingSync > 0 && <div className="app-pending-sync">{pendingSync} unsynced — will send when back online</div>}
          <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
          <div className="app-version">Version {APP_VERSION}</div>
        </>
      }
      overlay={confirm && (
        <ConfirmDialog
          title={confirm.label}
          body="This takes effect immediately and can't be undone from this screen."
          confirmLabel={confirm.label}
          danger={confirm.danger}
          busy={!!busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            run(c.label, c.type, c.payload);
          }}
        />
      )}
    >
          <PageHeader
            kicker={labelStatus(t.status, TOURNAMENT_STATUS_LABEL)}
            title={t.name}
            actions={[
              <Button key="back" variant="secondary" onClick={onBack}>Tournaments</Button>,
              live.length > 0 ? <Button key="live" variant="tape" onClick={() => setTab("live")}>Live</Button> : null,
              nextStatus ? <Button key="start" disabled={!!busy} onClick={() => run(`Advance to ${labelStatus(nextStatus, TOURNAMENT_STATUS_LABEL)}`, "transition_tournament", { tournament_id: t.id, status: nextStatus }, true)}>Start</Button> : null,
              <Button key="settings" variant="secondary" onClick={() => setTab("settings")}>Settings</Button>,
            ].filter(Boolean)}
          >
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {data.divisions.length} divisions · {data.participants.length} entries · {live.length} live · {completed.length} complete
            </p>
          </PageHeader>
          <div className="tape" />
          {error ? <Alert>{error}</Alert> : null}
          {busy ? <p className="muted" role="status">{busy}…</p> : null}

          {tab === "overview" && (
            <OverviewPanel
              data={data}
              t={t}
              nextStatus={nextStatus}
              busy={busy}
              run={run}
              live={live}
              upcoming={upcoming}
              completed={completed}
              onOpenLive={() => setTab("live")}
              onOpenLiveWindow={(matchId) => openLiveMatchWindow(t.id, matchId)}
              onGoto={setTab}
            />
          )}
          {tab === "live" && <LivePanel data={data} live={live} upcoming={upcoming} tournamentId={t.id} command={command} load={load} />}
          {tab === "brackets" && <BracketsPanel data={data} command={command} load={load} />}
          {tab === "settings" && <SettingsPanel t={t} busy={busy} run={run} />}
          {tab === "divisions" && <DivisionsPanel data={data} busy={busy} run={run} />}
          {tab === "players" && <PlayersPanel data={data} busy={busy} run={run} command={command} load={load} />}
          {tab === "teams" && <TeamsPanel data={data} busy={busy} run={run} />}
          {tab === "courts" && <CourtsPanel data={data} busy={busy} run={run} />}
          {tab === "umpires" && <UmpiresPanel data={data} session={session} busy={busy} run={run} />}
          {tab === "matches" && <MatchesPanel data={data} busy={busy} run={run} command={command} load={load} />}
          {tab === "results" && <ResultsPanel data={data} />}
    </PageShell>
  );
}

function OverviewPanel({ data, t, nextStatus, busy, run, live, upcoming, completed, onOpenLive, onOpenLiveWindow, onGoto }) {
  const assignedUmpires = new Set(data.umpireAssignments.map((a) => a.user_id)).size;
  const usedCourts = new Set(
    data.courtAssignments
      .filter((a) => data.matches.find((m) => m.id === a.match_id && m.status === "in_progress"))
      .map((a) => a.court_id)
  ).size;
  const checklist = [
    { id: "division", label: "Create a division", done: data.divisions.length > 0, goto: "divisions" },
    { id: "players", label: "Add or import players", done: data.persons.length > 0, goto: "players" },
    { id: "register", label: "Register players into a division", done: data.participants.length > 0, goto: "players" },
    { id: "courts", label: "Add courts", done: data.courts.length > 0, goto: "courts" },
    { id: "schedule", label: "Generate a bracket or schedule", done: data.matches.length > 0, goto: "divisions" },
  ];
  const setupDone = checklist.every((i) => i.done);
  const lifecycleActions = (
    <>
      {nextStatus && (
        <Button disabled={!!busy} onClick={() => run(`Advance to ${labelStatus(nextStatus, TOURNAMENT_STATUS_LABEL)}`, "transition_tournament", { tournament_id: t.id, status: nextStatus }, true)}>
          Advance to {labelStatus(nextStatus, TOURNAMENT_STATUS_LABEL)}
        </Button>
      )}
      {t.status !== "cancelled" && t.status !== "archived" && t.status !== "completed" && (
        <Button variant="danger" disabled={!!busy} onClick={() => run("Cancel tournament", "transition_tournament", { tournament_id: t.id, status: "cancelled" }, true)}>
          Cancel tournament
        </Button>
      )}
      {(t.status === "completed" || t.status === "cancelled") && (
        <Button variant="secondary" disabled={!!busy} onClick={() => run("Archive", "transition_tournament", { tournament_id: t.id, status: "archived" }, true)}>
          Archive
        </Button>
      )}
    </>
  );

  // Before setup is finished, the numbers are mostly zeros and not yet useful —
  // lead with the checklist alone instead of burying it under stat tiles and cards.
  if (!setupDone) {
    return (
      <div className="stack">
        <Card className="stack">
          <h2>Get your tournament ready</h2>
          <p className="muted" style={{ marginTop: -6 }}>Work through these in order — each step unlocks the next.</p>
          <SetupChecklist
            items={checklist.map((i) => ({
              ...i,
              action: <Button variant="secondary" onClick={() => onGoto?.(i.goto)}>Go</Button>,
            }))}
          />
        </Card>
        {(nextStatus || t.status !== "draft") && (
          <div className="row">{lifecycleActions}</div>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="grid4">
        <Stat tone={live.length ? "hero live" : "hero"} value={live.length} label="Live matches" />
        <Stat value={upcoming.length} label="Ready / upcoming" />
        <Stat value={completed.length} label="Completed" />
        <Stat value={data.courts.length - usedCourts} label="Courts free" />
      </div>
      <div className="row">{lifecycleActions}</div>
      <p className="muted">
        {data.divisions.length} divisions · {data.persons.length} players · {data.teams.length} teams ·{" "}
        {data.members.filter((m) => m.role === "umpire").length} umpires ({assignedUmpires} assigned)
      </p>
      {live.length > 0 ? (
        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 style={{ margin: 0 }}>Live now</h2>
            <Button variant="tape" onClick={onOpenLive}><Radio size={15} aria-hidden="true" /> Open live board</Button>
          </div>
          <LiveTiles data={data} matches={live} onOpenLiveWindow={onOpenLiveWindow} />
        </div>
      ) : (
        <p className="muted">No matches in progress right now.</p>
      )}
    </div>
  );
}

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

function LiveTiles({ data, matches, onOpenLiveWindow, command, load }) {
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

function LivePanel({ data, live, upcoming, tournamentId, command, load }) {
  return (
    <div className="stack">
      <h2>Live</h2>
      {live.length === 0 ? (
        <EmptyState title="No live matches">Assigned matches appear here when an umpire starts them.</EmptyState>
      ) : (
        <LiveTiles data={data} matches={live} onOpenLiveWindow={(matchId) => openLiveMatchWindow(tournamentId, matchId)} command={command} load={load} />
      )}
      <h2>Upcoming</h2>
      {upcoming.length === 0 ? (
        <EmptyState title="Nothing queued">Generate a bracket and assign courts and umpires.</EmptyState>
      ) : (
        <MatchTable data={data} rows={upcoming} />
      )}
    </div>
  );
}

function SettingsPanel({ t, busy, run }) {
  const [name, setName] = useState(t.name);
  const dirty = name.trim() !== t.name;
  return (
    <Card as="form" className="stack" onSubmit={(e) => { e.preventDefault(); run("Save settings", "update_tournament", { tournament_id: t.id, name }); }}>
      <h2>Tournament details</h2>
      <p className="muted" style={{ marginTop: -6 }}>Update the tournament name used throughout the organizer app and scoreboard.</p>
      <Input label="Tournament name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Button type="submit" disabled={!!busy || !dirty}>Save changes</Button>
    </Card>
  );
}

function DivisionsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [format, setFormat] = useState("single_elim");
  const [qualifierMode, setQualifierMode] = useState("top_x");
  const [qualifierCount, setQualifierCount] = useState("4");
  const [sameTeamPolicy, setSameTeamPolicy] = useState("avoid_semis");
  const [edit, setEdit] = useState({});
  return (
    <div className="stack">
      <div className="panel-toolbar">
        <div>
          <h1 className="panel-toolbar-title">Divisions</h1>
          <p className="muted panel-toolbar-sub">Group players into competitions, then generate each division's bracket.</p>
        </div>
      </div>
      <Card as="form" className="stack" onSubmit={(e) => {
        e.preventDefault();
        const config = { winTo: 11, bestOf: 1, winBy: "two", isDoubles: true, bronzeMatch: true };
        if (format === "team_elimination") {
          config.qualifierMode = qualifierMode;
          config.qualifierCount = Number(qualifierCount) || 4;
          config.sameTeamPolicy = sameTeamPolicy;
        }
        run("Create division", "create_division", {
          tournament_id: data.tournament.id,
          name,
          format,
          config,
        });
        setName("");
      }}>
        <div className="row">
          <Input label="Division name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value)} hint="Single players/pairs knocked out each round, or teams of pairs competing as a group.">
            <option value="single_elim">Single elimination</option>
            <option value="team_elimination">Team elimination</option>
          </Select>
          <Button type="submit" disabled={!!busy}>Add division</Button>
        </div>
        {format === "team_elimination" && (
          <div className="row">
            <Select label="Qualification" value={qualifierMode} onChange={(e) => setQualifierMode(e.target.value)}>
              <option value="top_x">Top X overall</option>
              <option value="top_x_per_team">Top X per team</option>
              <option value="manual">Manual qualification</option>
            </Select>
            <Input label="Qualifier count" value={qualifierCount} onChange={(e) => setQualifierCount(e.target.value)} inputMode="numeric" />
            <Select
              label="Same-team matchup policy"
              value={sameTeamPolicy}
              onChange={(e) => setSameTeamPolicy(e.target.value)}
              hint="Keeps pairs from the same team apart in the bracket for as long as possible, so teammates don't face each other early."
            >
              <option value="allow_anywhere">Allow anywhere — no restriction</option>
              <option value="avoid_quarterfinals">Avoid until the quarterfinals</option>
              <option value="avoid_semis">Avoid until the semifinals</option>
              <option value="avoid_until_final">Avoid until the final</option>
            </Select>
          </div>
        )}
      </Card>
      {data.divisions.length === 0 && (
        <EmptyState title="No divisions yet">Add a division to register players and generate a bracket.</EmptyState>
      )}
      {data.divisions.map((d) => {
        const cfg = edit[d.id] || {
          qualifierMode: d.config?.qualifierMode || "top_x",
          qualifierCount: String(d.config?.qualifierCount ?? 4),
          sameTeamPolicy: d.config?.sameTeamPolicy || "avoid_semis",
        };
        return (
          <Card className="stack" key={d.id}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <h3 style={{ margin: 0 }}>{d.name}</h3>
                  <Badge tone="info">{FORMAT_LABEL[d.format] || d.format}</Badge>
                </div>
              </div>
              <div className="row">
                {d.format === "team_elimination" ? (
                  <>
                    <Button disabled={!!busy} onClick={() => run("Generate qualification", "generate_team_elimination", { division_id: d.id }, true)}>
                      Generate qualification
                    </Button>
                    <Button variant="secondary" disabled={!!busy} onClick={() => run("Generate playoffs", "generate_team_playoffs", { division_id: d.id }, true)}>
                      Generate playoffs
                    </Button>
                  </>
                ) : (
                  <Button disabled={!!busy} onClick={() => run("Generate bracket", "generate_bracket", { division_id: d.id }, true)}>
                    Generate bracket
                  </Button>
                )}
              </div>
            </div>
            {d.format === "team_elimination" && (
              <form className="row" onSubmit={(e) => {
                e.preventDefault();
                run("Update division", "update_division", {
                  division_id: d.id,
                  config: {
                    qualifierMode: cfg.qualifierMode,
                    qualifierCount: Number(cfg.qualifierCount) || 4,
                    sameTeamPolicy: cfg.sameTeamPolicy,
                  },
                });
              }}>
                <Select
                  label="Qualification"
                  value={cfg.qualifierMode}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, qualifierMode: e.target.value } }))}
                >
                  <option value="top_x">Top X overall</option>
                  <option value="top_x_per_team">Top X per team</option>
                  <option value="manual">Manual qualification</option>
                </Select>
                <Input
                  label="Qualifier count"
                  value={cfg.qualifierCount}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, qualifierCount: e.target.value } }))}
                  inputMode="numeric"
                />
                <Select
                  label="Same-team matchup policy"
                  value={cfg.sameTeamPolicy}
                  onChange={(e) => setEdit((prev) => ({ ...prev, [d.id]: { ...cfg, sameTeamPolicy: e.target.value } }))}
                  hint="Keeps pairs from the same team apart in the bracket for as long as possible."
                >
                  <option value="allow_anywhere">Allow anywhere — no restriction</option>
                  <option value="avoid_quarterfinals">Avoid until the quarterfinals</option>
                  <option value="avoid_semis">Avoid until the semifinals</option>
                  <option value="avoid_until_final">Avoid until the final</option>
                </Select>
                <Button type="submit" variant="secondary" disabled={!!busy}>Save options</Button>
              </form>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function PlayersPanel({ data, busy, run, command, load }) {
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

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");
    try {
      const buffer = await file.arrayBuffer();
      const { parsePlayerWorkbook, analyzePlayerRows } = await import("./excelImportExport.js");
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
    const { buildPlayersExportWorkbook, downloadWorkbook, safeFileNamePart } = await import("./excelImportExport.js");
    const wb = buildPlayersExportWorkbook(data);
    downloadWorkbook(wb, `${safeFileNamePart(data.tournament?.name)}_Players.xlsx`);
  }

  async function downloadTemplate() {
    const { buildPlayerTemplateWorkbook, downloadWorkbook } = await import("./excelImportExport.js");
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
      <div className="panel-toolbar">
        <div>
          <h1 className="panel-toolbar-title">Player management</h1>
          <p className="muted panel-toolbar-sub">Add players, import a roster, then register them into a division.</p>
        </div>
        <div className="panel-toolbar-actions">
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
                <input
                  ref={headerPlayerCheckboxRef}
                  type="checkbox"
                  aria-label="Select all removable players"
                  checked={allPlayersChecked}
                  disabled={!removableFiltered.length}
                  onChange={toggleAllPlayers}
                />
              ),
              render: (p) => {
                const registered = entryCountFor(p.id) > 0;
                return (
                  <input
                    type="checkbox"
                    aria-label={`Select ${p.display_name}`}
                    checked={checkedPlayerIds.has(p.id)}
                    disabled={registered}
                    title={registered ? "Already registered into a division — remove that entry first" : undefined}
                    onChange={() => togglePlayer(p.id)}
                  />
                );
              },
            },
            { key: "display_name", header: "Player" },
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
      <h2>Division entries</h2>
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
  );
}

function TeamRosterModal({ team, data, busy, run, onClose }) {
  const [personId, setPersonId] = useState("");
  const [search, setSearch] = useState("");
  const members = data.teamMembers || [];
  const roster = members.filter((m) => m.team_id === team.id);
  const q = search.toLowerCase();
  const assigned = assignedPersonIdsInDivision(data, team.division_id, {
    exceptTeamId: team.id,
    exceptParticipantTeamId: team.id,
  });
  const onThisTeam = new Set(roster.map((m) => m.person_id));
  const options = data.persons.filter((p) => {
    if (onThisTeam.has(p.id)) return false;
    if (assigned.has(p.id)) return false;
    if (q && !p.display_name.toLowerCase().includes(q)) return false;
    return true;
  });
  const selected = personId || options[0]?.id || "";
  return (
    <Modal title={team.name} onClose={onClose}>
      <div className="stack">
        {roster.length === 0 ? (
          <EmptyState title="No members yet">Search a player below and add them to this team.</EmptyState>
        ) : (
          <Table
            columns={[
              { key: "name", header: "Player", render: (m) => data.persons.find((p) => p.id === m.person_id)?.display_name || m.person_id },
              {
                key: "remove",
                header: "",
                render: (m) => (
                  <Button variant="danger" disabled={!!busy} onClick={() => run("Remove member", "remove_team_member", { team_member_id: m.id }, true)}>
                    Remove
                  </Button>
                ),
              },
            ]}
            rows={roster}
          />
        )}
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          if (!selected) return;
          run("Add member", "add_team_member", { team_id: team.id, person_id: selected });
        }}>
          <Input label="Search player" value={search} onChange={(e) => setSearch(e.target.value)} />
          <Select label="Player" hideLabel value={selected} onChange={(e) => setPersonId(e.target.value)}>
            {options.length === 0 && <option value="">No matching players</option>}
            {options.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
          </Select>
          <Button type="submit" disabled={!!busy || !options.length}>Add member</Button>
        </form>
      </div>
    </Modal>
  );
}

function TeamsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [divisionId, setDivisionId] = useState(data.divisions[0]?.id || "");
  const [openTeamId, setOpenTeamId] = useState(null);
  const members = data.teamMembers || [];
  const openTeam = data.teams.find((t) => t.id === openTeamId) || null;

  return (
    <div className="stack">
      <div className="panel-toolbar">
        <div>
          <h1 className="panel-toolbar-title">Teams</h1>
          <p className="muted panel-toolbar-sub">Group registered players into a team roster for team elimination divisions.</p>
        </div>
      </div>
      <Card as="form" className="row" onSubmit={(e) => {
        e.preventDefault();
        run("Create team", "create_team", { tournament_id: data.tournament.id, name, division_id: divisionId || null });
        setName("");
      }}>
        <Input label="Team name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Select label="Division" value={divisionId} onChange={(e) => setDivisionId(e.target.value)}>
          {data.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Button type="submit" disabled={!!busy}>Add team</Button>
      </Card>
      {data.teams.length === 0 ? (
        <EmptyState title="No teams yet">Needed for team elimination — create a team, then add players to its roster.</EmptyState>
      ) : (
        <Table
          responsive
          columns={[
            { key: "name", header: "Team" },
            { key: "division", header: "Division", render: (t) => data.divisions.find((d) => d.id === t.division_id)?.name || "—" },
            {
              key: "members",
              header: "Roster",
              render: (t) => {
                const n = members.filter((m) => m.team_id === t.id).length;
                return n === 0 ? <span className="muted">Empty</span> : `${n} member${n === 1 ? "" : "s"}`;
              },
            },
            {
              key: "manage",
              header: "",
              render: (t) => <Button variant="secondary" onClick={() => setOpenTeamId(t.id)}>Manage roster</Button>,
            },
          ]}
          rows={data.teams}
        />
      )}
      {openTeam && (
        <TeamRosterModal team={openTeam} data={data} busy={busy} run={run} onClose={() => setOpenTeamId(null)} />
      )}
    </div>
  );
}

function CourtsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState(null);
  const liveIds = new Set(
    data.courtAssignments
      .filter((a) => data.matches.find((m) => m.id === a.match_id && m.status === "in_progress"))
      .map((a) => a.court_id)
  );
  async function openPairing(court) {
    const out = await run("Open pairing", "open_court_pairing", { court_id: court.id });
    if (out?.result) setPairing({ court, ...out.result });
  }
  return (
    <div className="stack">
      <Card as="form" className="row" onSubmit={(e) => {
        e.preventDefault();
        run("Create court", "create_court", { tournament_id: data.tournament.id, name });
        setName("");
      }}>
        <Input label="Court name" value={name} onChange={(e) => setName(e.target.value)} required />
        <Button type="submit" disabled={!!busy}>Add court</Button>
      </Card>
      <p className="muted">Print the court QR once. Open a pairing window when you hand a tablet to that court. New matches on the same court do not need a new QR.</p>
      {pairing && (
        <Card className="stack">
          <h2>Pairing window — {pairing.court?.name || "Court"}</h2>
          <p>Expires {new Date(pairing.expires_at).toLocaleTimeString()}. Scan with Tournament Umpire, or copy the pairing code as a fallback. This grant is one-time and short-lived.</p>
          <PairingQr payload={pairing.pairing_payload} />
          <div className="row">
            <Button
              variant="secondary"
              type="button"
              onClick={async () => {
                const text = pairingQrText(pairing.pairing_payload);
                try {
                  await navigator.clipboard.writeText(text);
                } catch {
                  window.prompt("Copy pairing code", text);
                }
              }}
            >
              Copy pairing code
            </Button>
            <Button variant="secondary" type="button" onClick={() => setPairing(null)}>Hide</Button>
          </div>
        </Card>
      )}
      {data.courts.length === 0 ? (
        <EmptyState title="No courts yet">Add courts before assigning matches.</EmptyState>
      ) : (
        <Table
          responsive
          columns={[
            { key: "name", header: "Court" },
            { key: "status", header: "Status", render: (c) => {
              const live = liveIds.has(c.id);
              const devices = (data.courtDevices || []).filter((d) => d.court_id === c.id);
              const active = devices.find((d) => d.status === "active");
              const revoked = !active && devices.some((d) => d.status === "revoked");
              if (live) return <StatusBadge status="in_progress" />;
              if (active) return <Badge tone="ok">Tablet connected</Badge>;
              if (revoked) return <Badge tone="warn">Needs re-pairing</Badge>;
              return <Badge tone="muted">No tablet paired</Badge>;
            } },
            {
              key: "station",
              header: "Station",
              render: (c) => {
                const device = (data.courtDevices || []).find((d) => d.court_id === c.id && d.status === "active");
                return device ? "Paired" : "Unpaired";
              },
            },
            {
              key: "actions",
              header: "",
              render: (c) => {
                const device = (data.courtDevices || []).find((d) => d.court_id === c.id && d.status === "active");
                return (
                  <div className="row">
                    <Button variant="secondary" disabled={!!busy} onClick={() => openPairing(c)}>Pair device</Button>
                    {device && (
                      <Button variant="secondary" disabled={!!busy} onClick={() => run("Revoke device", "revoke_court_device", { court_id: c.id }, true)}>
                        Revoke
                      </Button>
                    )}
                  </div>
                );
              },
            },
          ]}
          rows={data.courts}
        />
      )}
    </div>
  );
}

const UUID_LOOKS_VALID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function UmpiresPanel({ data, session, busy, run }) {
  // Anyone who already shares a tournament with this organizer is visible to them
  // (that's how RLS on `profiles` works today) — so returning organizers can search
  // their existing umpire pool by name with zero backend changes. A brand-new umpire
  // who has never shared a tournament with this organizer won't appear here yet;
  // that cold-start case still needs the manual ID handoff below.
  const existingMemberIds = new Set(data.members.map((m) => m.user_id));
  const searchablePool = (data.profiles || []).filter((p) => p.id !== session.user.id && !existingMemberIds.has(p.id));

  const [mode, setMode] = useState(searchablePool.length ? "search" : "manual");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [userId, setUserId] = useState("");
  const [idError, setIdError] = useState("");
  const [copied, setCopied] = useState(false);

  const matches = searchablePool.filter((p) => !query.trim() || p.display_name.toLowerCase().includes(query.trim().toLowerCase()));

  async function copyMyId() {
    try {
      await navigator.clipboard.writeText(session.user.id);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy your account ID", session.user.id);
    }
  }

  function assign(id) {
    run("Assign umpire", "add_member", { tournament_id: data.tournament.id, user_id: id, role: "umpire" });
  }

  return (
    <div className="stack">
      <Card className="stack">
        <h2>Assign umpire</h2>
        {mode === "search" ? (
          <>
            <p className="muted" style={{ marginTop: -6 }}>Search people you've already worked with in other tournaments.</p>
            <Input label="Search by name" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Start typing a name…" />
            {matches.length === 0 && query.trim() && (
              <p className="muted">No match for "{query.trim()}".</p>
            )}
            {matches.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                {matches.slice(0, 8).map((p) => (
                  <div key={p.id} className="row" style={{ justifyContent: "space-between" }}>
                    <span>{p.display_name}</span>
                    <Button type="button" variant="secondary" disabled={!!busy} onClick={() => assign(p.id)}>Assign</Button>
                  </div>
                ))}
              </div>
            )}
            <Button type="button" variant="ghost" className="compact" onClick={() => setMode("manual")}>Can't find this umpire?</Button>
          </>
        ) : (
          <form className="stack" onSubmit={(e) => {
            e.preventDefault();
            const id = userId.trim();
            if (!UUID_LOOKS_VALID.test(id)) {
              setIdError("That doesn't look like a valid account ID — it should look like 8-4-4-4-12 characters (e.g. a1b2c3d4-....).");
              return;
            }
            setIdError("");
            assign(id);
            setUserId("");
          }}>
            <p className="muted" style={{ marginTop: -6 }}>
              For a new umpire who hasn't worked with you before: ask them to sign in once, then share their account ID with you.
            </p>
            <Input
              label="Advanced: enter umpire ID"
              value={userId}
              onChange={(e) => { setUserId(e.target.value); setIdError(""); }}
              error={idError}
              hint={!idError ? "Looks like: a1b2c3d4-e5f6-7890-ab12-cd34ef567890" : undefined}
              required
            />
            <Button type="submit" disabled={!!busy}>Assign umpire</Button>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="muted" style={{ fontSize: "var(--text-sm)" }}>Your own account ID: {session.user.id}</span>
              <Button type="button" variant="ghost" className="compact" onClick={copyMyId}>{copied ? "Copied" : "Copy"}</Button>
            </div>
            {searchablePool.length > 0 && (
              <Button type="button" variant="ghost" className="compact" onClick={() => setMode("search")}>Search existing people instead</Button>
            )}
          </form>
        )}
      </Card>
      {(() => {
        const staff = data.members.filter((m) => ["umpire", "organizer", "admin"].includes(m.role));
        const withAssignment = staff.map((m) => {
          const asg = data.umpireAssignments.find((a) => a.user_id === m.user_id);
          const match = asg ? data.matches.find((mm) => mm.id === asg.match_id) : null;
          const court = match ? courtFor(match, data) : null;
          return { ...m, match, court, isLive: match?.status === "in_progress" };
        });
        const activeCount = withAssignment.filter((m) => m.isLive).length;
        const assignedCount = withAssignment.filter((m) => m.match && !m.isLive).length;
        const availableCount = withAssignment.length - activeCount - assignedCount;
        return (
          <>
            <div className="grid4">
              <Stat value={withAssignment.length} label="Staff" />
              <Stat tone={activeCount ? "hero live" : "hero"} value={activeCount} label="Currently umpiring" />
              <Stat value={assignedCount} label="Assigned, not live" />
              <Stat tone="quiet" value={availableCount} label="Available" />
            </div>
            <div className="section-label">Staff</div>
            {withAssignment.length === 0 ? (
              <EmptyState title="No staff yet">Assign an umpire above — search your existing pool, or add someone new by their account ID.</EmptyState>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {withAssignment.map((m) => (
                  <Card key={m.id} className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                    <div>
                      <strong>{memberName(m.user_id, data.profiles)}</strong>
                      <div className="muted" style={{ fontSize: "var(--text-sm)" }}>
                        {m.role}
                        {m.match ? ` · ${sideOf(m.match.id, "A", data).name} vs ${sideOf(m.match.id, "B", data).name}${m.court ? ` · ${m.court.name}` : ""}` : " · Not currently assigned"}
                      </div>
                    </div>
                    {m.isLive ? <Badge tone="live">● LIVE</Badge> : m.match ? <Badge tone="warn">Assigned</Badge> : <Badge tone="muted">Available</Badge>}
                  </Card>
                ))}
              </div>
            )}
          </>
        );
      })()}
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
          render: (m) => (
            <div className="stack" style={{ gap: 4 }}>
              {EDITABLE_PLAYERS_STATUSES.has(m.status) ? (
                <Button variant="ghost" className="compact" onClick={() => setEditingPlayersId(m.id)}>
                  Edit players
                </Button>
              ) : (
                <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                  {m.status === "in_progress" ? "Locked — match started" : "Locked — match completed"}
                </span>
              )}
              {["ready", "assigned"].includes(m.status) && (
                <Button variant="ghost" className="compact" onClick={() => setOverrideStartId(m.id)}>
                  Override start
                </Button>
              )}
              {m.status === "postponed" && (
                <Button
                  variant="ghost"
                  className="compact"
                  disabled={!!busy}
                  onClick={() => run("Resume match", "transition_match", { match_id: m.id, status: "ready" })}
                >
                  Resume match
                </Button>
              )}
            </div>
          ),
        }] : []),
      ]}
      rows={rows}
      rowProps={(m) => ({ "data-live": m.status === "in_progress" ? "true" : undefined })}
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

function MatchesPanel({ data, busy, run, command, load }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const rows = playableMatches(data.matches);
  const live = rows.filter((m) => m.status === "in_progress");
  const upcoming = rows.filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const completed = rows.filter((m) => m.status === "completed" || m.status === "bye");
  const other = rows.filter((m) => !live.includes(m) && !upcoming.includes(m) && !completed.includes(m));

  return (
    <div className="stack">
      <div className="grid4">
        <Stat value={rows.length} label="Total matches" />
        <Stat tone={live.length ? "hero live" : "hero"} value={live.length} label="Live" />
        <Stat value={upcoming.length} label="Upcoming" />
        <Stat tone="quiet" value={completed.length} label="Completed" />
      </div>

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

function PodiumCard({ division, placements }) {
  if (!placements.champion) {
    return (
      <Card className="stack">
        <h2>{division.name}</h2>
        <p className="muted" style={{ margin: 0 }}>No final result yet — standings appear here once the final is complete.</p>
      </Card>
    );
  }
  return (
    <Card className="stack">
      <h2>{division.name}</h2>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span><span className="rank-medal" aria-hidden="true">🥇</span> Champion</span>
          <strong>{placements.champion}</strong>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span><span className="rank-medal" aria-hidden="true">🥈</span> Runner-up</span>
          <span>{placements.runnerUp}</span>
        </div>
        {placements.third && (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span><span className="rank-medal" aria-hidden="true">🥉</span> Third place</span>
            <span>{placements.third}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

function ResultsPanel({ data }) {
  const [divisionFilter, setDivisionFilter] = useState("all");
  const completedAll = data.matches.filter((m) => m.status === "completed" || m.status === "bye");
  const completed = divisionFilter === "all" ? completedAll : completedAll.filter((m) => m.division_id === divisionFilter);
  const shownDivisions = divisionFilter === "all" ? data.divisions : data.divisions.filter((d) => d.id === divisionFilter);

  async function exportReport() {
    const { buildTournamentReportWorkbook, downloadWorkbook, safeFileNamePart } = await import("./excelImportExport.js");
    const wb = buildTournamentReportWorkbook(data);
    downloadWorkbook(wb, `${safeFileNamePart(data.tournament?.name)}_Tournament_Report.xlsx`);
  }

  if (!data.divisions.length) {
    return (
      <div className="stack">
        <EmptyState title="No divisions yet">Results appear here once a division has matches and completed play.</EmptyState>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHeader kicker="Standings" title="Results" actions={[
        <Button key="export" type="button" variant="secondary" onClick={exportReport}>Export Tournament Report</Button>,
      ]} />
      {data.divisions.length > 1 && (
        <Select label="Division" hideLabel value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
          <option value="all">All divisions</option>
          {data.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      )}
      <div className="grid2">
        {shownDivisions.map((d) => (
          <PodiumCard key={d.id} division={d} placements={placementsForDivision(d, data)} />
        ))}
      </div>

      {shownDivisions.filter((d) => d.format === "team_elimination").map((d) => {
        const standings = teamEliminationStandings(d, data);
        if (!standings.length) return null;
        return (
          <div key={d.id}>
            <h3>{d.name} — qualification standings</h3>
            <StandingsTable
              rows={standings.map((row) => ({
                id: row.registrationId,
                rank: row.rank,
                name: data.participants.find((p) => p.id === row.registrationId)?.display_name || row.registrationId,
                team: row.teamName,
                wins: row.wins,
                losses: row.losses,
                pointDiff: row.pointDiff,
              }))}
            />
          </div>
        );
      })}

      <div className="section-label" style={{ marginTop: "var(--space-3)" }}>Match results</div>
      {!completed.length ? (
        <EmptyState title="No completed matches yet">Results appear here after an umpire completes a match.</EmptyState>
      ) : (
        <Table
          responsive
          columns={[
            { key: "match", header: "Match", render: (m) => `${sideOf(m.id, "A", data).name} vs ${sideOf(m.id, "B", data).name}` },
            { key: "status", header: "Status", render: (m) => <StatusBadge status={m.status} /> },
            { key: "winner", header: "Winner", render: (m) => m.winner ? sideOf(m.id, m.winner, data).name : "—" },
            { key: "score", header: "Score", render: (m) => scoreLine(m, resultFor(m, data.results)) },
          ]}
          rows={completed}
        />
      )}
    </div>
  );
}
