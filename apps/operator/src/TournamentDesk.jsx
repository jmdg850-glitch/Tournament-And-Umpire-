import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  LoadingState,
  NavGroup,
  NavItem,
  PageHeader,
  PageShell,
  SetupChecklist,
  Skeleton,
  Stat,
  StatusBadge,
  useToast,
} from "@tournament/ui";
import {
  Award,
  ClipboardList,
  Gauge,
  LayoutGrid,
  MapPin,
  Medal,
  Radio,
  Settings as SettingsIcon,
  Shield,
  Trophy,
  Users,
} from "lucide-react";
import {
  applyDeskRealtime,
  deskLiveChannelName,
} from "@tournament/engine";
import AppBrand from "./AppBrand.jsx";
import { buildDeskHash, parseDeskHash } from "./deskHash.js";
import { BracketsPanel } from "./brackets.jsx";
import { DivisionsPanel } from "./screens/DivisionsPanel.jsx";
import { PlayersPanel } from "./screens/PlayersPanel.jsx";
import { TeamsPanel } from "./screens/TeamsPanel.jsx";
import { CourtsPanel } from "./screens/CourtsPanel.jsx";
import { UmpiresPanel } from "./screens/UmpiresPanel.jsx";
import { LiveTiles, MatchesPanel } from "./screens/MatchesPanel.jsx";
import { ResultsPanel } from "./screens/ResultsPanel.jsx";
import { SettingsPanel } from "./screens/SettingsPanel.jsx";
import { openLiveMatchWindow, useRealtimeChannel } from "./useRealtimeChannel.js";
import { useDesktopUpdateContext } from "./UpdateBanner.jsx";
import {
  DESK_TABS,
  TOURNAMENT_FLOW,
  TOURNAMENT_STATUS_LABEL,
  firstQueryError,
  labelStatus,
  playableMatches,
} from "./lib.js";
import { version as APP_VERSION } from "../package.json";

const TAB_ICON = {
  overview: Gauge,
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
  { label: "Run", ids: ["matches", "brackets", "umpires"] },
  { label: "Results", ids: ["results"] },
  { label: null, ids: ["settings"] },
];

const VALID_TABS = new Set(NAV_SECTIONS.flatMap((section) => section.ids));

export default function TournamentDesk({ supabase, session, command, pendingSync, tournamentId, onBack, onSignOut }) {
  const toast = useToast();
  const [tab, setTab] = useState(() => {
    const parsed = parseDeskHash(typeof window === "undefined" ? "" : window.location.hash);
    return parsed?.tab && VALID_TABS.has(parsed.tab) ? parsed.tab : "overview";
  });
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null);
  const attemptedPlayoffs = useRef(new Set());

  // Keeps the URL addressable/bookmarkable/reloadable for each screen — see
  // deskHash.js for why this is a hand-rolled hash scheme rather than a router.
  useEffect(() => {
    window.location.hash = buildDeskHash(tournamentId, tab);
  }, [tournamentId, tab]);
  useEffect(() => {
    function onHashChange() {
      const parsed = parseDeskHash(window.location.hash);
      if (parsed && VALID_TABS.has(parsed.tab) && parsed.tab !== tab) {
        setTab(parsed.tab);
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [tab]);

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
  const playable = playableMatches(data.matches);
  const live = playable.filter((m) => m.status === "in_progress");
  const upcoming = playable.filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const completed = playable.filter((m) => m.status === "completed" || m.status === "bye");
  const held = playable.filter((m) => m.status === "postponed");

  const tabLabel = Object.fromEntries(DESK_TABS);

  return (
    <PageShell
      navLabel="Tournament sections"
      brand={<AppBrand />}
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
                live={id === "matches" && live.length > 0}
                count={id === "matches" && live.length ? live.length : null}
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
              live.length > 0 ? <Button key="live" variant="tape" onClick={() => setTab("matches")}>Live</Button> : null,
              nextStatus ? <Button key="start" disabled={!!busy} onClick={() => run(`Advance to ${labelStatus(nextStatus, TOURNAMENT_STATUS_LABEL)}`, "transition_tournament", { tournament_id: t.id, status: nextStatus }, true)}>Start</Button> : null,
              <Button key="settings" variant="secondary" onClick={() => setTab("settings")}>Settings</Button>,
            ].filter(Boolean)}
          >
            <p className="muted" style={{ margin: "8px 0 0" }}>
              {data.divisions.length} divisions · {data.participants.length} entries · {live.length} live · {held.length} on hold · {completed.length} complete
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
              onOpenLive={() => setTab("matches")}
              onOpenLiveWindow={(matchId) => openLiveMatchWindow(t.id, matchId)}
              onGoto={setTab}
            />
          )}
          {tab === "brackets" && <BracketsPanel data={data} command={command} load={load} />}
          {tab === "settings" && <SettingsPanel t={t} busy={busy} run={run} />}
          {tab === "divisions" && <DivisionsPanel data={data} busy={busy} run={run} />}
          {tab === "players" && <PlayersPanel data={data} busy={busy} run={run} command={command} load={load} />}
          {tab === "teams" && <TeamsPanel data={data} busy={busy} run={run} />}
          {tab === "courts" && <CourtsPanel data={data} busy={busy} run={run} onOpenLiveWindow={(matchId) => openLiveMatchWindow(t.id, matchId)} />}
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
