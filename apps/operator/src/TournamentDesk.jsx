import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Input,
  LoadingState,
  PageHeader,
  Select,
  ServeIndicator,
  Skeleton,
  Stat,
  StatusBadge,
  Table,
  useToast,
} from "@tournament/ui";
import { ExternalLink, Radio } from "lucide-react";
import {
  applyDeskRealtime,
  deskLiveChannelName,
} from "@tournament/engine";
import { BracketsPanel } from "./brackets.jsx";
import { PairingQr } from "./pairingQr.jsx";
import { openLiveMatchWindow, useRealtimeChannel } from "./useRealtimeChannel.js";
import { useDesktopUpdateContext } from "./UpdateBanner.jsx";
import AppShell from "./AppShell.jsx";
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
  pairingQrText,
  personLabel,
  playableMatches,
  resultFor,
  scoreLine,
  sideOf,
  umpireFor,
} from "./lib.js";

export default function TournamentDesk({ supabase, session, command, tournamentId, onBack, onSignOut }) {
  const toast = useToast();
  const [tab, setTab] = useState("overview");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [confirm, setConfirm] = useState(null);
  const attemptedPlayoffs = useRef(new Set());

  const load = useCallback(async () => {
    const queries = await Promise.all([
      supabase.from("tournaments").select("*").eq("id", tournamentId).maybeSingle(),
      supabase.from("divisions").select("*").eq("tournament_id", tournamentId),
      supabase.from("persons").select("*").eq("tournament_id", tournamentId).order("display_name"),
      supabase.from("teams").select("*").eq("tournament_id", tournamentId).order("name"),
      supabase.from("team_members").select("*"),
      supabase.from("participants").select("*").eq("tournament_id", tournamentId),
      supabase.from("courts").select("*").eq("tournament_id", tournamentId).order("sort_order"),
      supabase.from("tournament_members").select("*").eq("tournament_id", tournamentId),
      supabase.from("matches").select("*").eq("tournament_id", tournamentId).order("round"),
      supabase.from("match_results").select("*"),
      supabase.from("court_assignments").select("*"),
      supabase.from("umpire_assignments").select("*"),
      supabase.from("court_devices").select("*").eq("tournament_id", tournamentId),
      supabase.from("match_participants").select("*"),
      supabase.from("participant_members").select("*"),
      supabase.from("stages").select("*"),
      supabase.from("profiles").select("id, display_name"),
    ]);
    const err = firstQueryError(queries);
    if (err) {
      setError(err.message);
      return;
    }
    const [
      t, divisions, persons, teams, teamMembers, participants, courts, members,
      matches, results, courtsA, umpiresA, courtDevices, matchParticipants, participantMembers, stages, profiles,
    ] = queries;
    const matchIds = new Set((matches.data || []).map((m) => m.id));
    const teamIds = new Set((teams.data || []).map((x) => x.id));
    const participantIds = new Set((participants.data || []).map((x) => x.id));
    const divisionIds = new Set((divisions.data || []).map((x) => x.id));
    setError("");
    setData({
      tournament: t.data,
      divisions: divisions.data || [],
      persons: persons.data || [],
      teams: teams.data || [],
      teamMembers: (teamMembers.data || []).filter((m) => teamIds.has(m.team_id)),
      participants: participants.data || [],
      participantMembers: (participantMembers.data || []).filter((m) => participantIds.has(m.participant_id)),
      stages: (stages.data || []).filter((s) => divisionIds.has(s.division_id)),
      courts: courts.data || [],
      members: members.data || [],
      matches: matches.data || [],
      results: (results.data || []).filter((r) => matchIds.has(r.match_id)),
      courtAssignments: (courtsA.data || []).filter((r) => matchIds.has(r.match_id)),
      umpireAssignments: (umpiresA.data || []).filter((r) => matchIds.has(r.match_id)),
      courtDevices: courtDevices.data || [],
      matchParticipants: (matchParticipants.data || []).filter((r) => matchIds.has(r.match_id)),
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
      const out = await command(type, payload);
      await load();
      toast(label);
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
      <div className="main">
        <Alert>{error}</Alert>
        <Button style={{ marginTop: 12 }} onClick={load}>Retry</Button>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="main">
        <LoadingState label="Loading tournament" />
        <div style={{ marginTop: 16 }}><Skeleton lines={6} /></div>
      </div>
    );
  }
  if (!data.tournament) {
    return (
      <div className="main">
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

  return (
    <AppShell
      navLabel="Tournament sections"
      nav={DESK_TABS.map(([id, label]) => (
        <button key={id} type="button" data-active={tab === id} onClick={() => setTab(id)}>
          {label}{id === "live" && live.length ? ` ${live.length}` : ""}
        </button>
      ))}
      railFoot={
        <>
          <div>{session.user.email}</div>
          <Button variant="ghost" onClick={onSignOut}>Sign out</Button>
        </>
      }
      overlay={confirm && (
        <ConfirmDialog
          title={confirm.label}
          body="This writes through the command API and cannot be undone from this screen."
          confirmLabel="Confirm"
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
            />
          )}
          {tab === "live" && <LivePanel data={data} live={live} upcoming={upcoming} tournamentId={t.id} />}
          {tab === "brackets" && <BracketsPanel data={data} />}
          {tab === "settings" && <SettingsPanel t={t} busy={busy} run={run} />}
          {tab === "divisions" && <DivisionsPanel data={data} busy={busy} run={run} />}
          {tab === "players" && <PlayersPanel data={data} busy={busy} run={run} />}
          {tab === "teams" && <TeamsPanel data={data} busy={busy} run={run} />}
          {tab === "courts" && <CourtsPanel data={data} busy={busy} run={run} />}
          {tab === "umpires" && <UmpiresPanel data={data} session={session} busy={busy} run={run} />}
          {tab === "matches" && <MatchesPanel data={data} busy={busy} run={run} />}
          {tab === "results" && <ResultsPanel data={data} />}
    </AppShell>
  );
}

function OverviewPanel({ data, t, nextStatus, busy, run, live, upcoming, completed, onOpenLive, onOpenLiveWindow }) {
  const assignedUmpires = new Set(data.umpireAssignments.map((a) => a.user_id)).size;
  const usedCourts = new Set(
    data.courtAssignments
      .filter((a) => data.matches.find((m) => m.id === a.match_id && m.status === "in_progress"))
      .map((a) => a.court_id)
  ).size;
  return (
    <div className="stack">
      <div className="grid4">
        <Stat tone={live.length ? "hero live" : "hero"} value={live.length} label="Live matches" />
        <Stat value={upcoming.length} label="Ready / upcoming" />
        <Stat value={completed.length} label="Completed" />
        <Stat value={data.courts.length - usedCourts} label="Courts free" />
      </div>
      <div className="grid2">
        <Card className="stack">
          <h2>Lifecycle</h2>
          <p className="muted">Advance only to the next legal status. The engine rejects illegal jumps.</p>
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
        </Card>
        <Card className="stack">
          <h2>Needs attention</h2>
          <p>{data.divisions.length} divisions · {data.persons.length} players · {data.teams.length} teams</p>
          <p>{data.members.filter((m) => m.role === "umpire").length} umpires on staff · {assignedUmpires} currently assigned</p>
          {live.length > 0 ? (
            <Button variant="tape" onClick={onOpenLive}><Radio size={15} aria-hidden="true" /> Open live board</Button>
          ) : (
            <p className="muted">No matches in progress.</p>
          )}
        </Card>
      </div>
      {live.length > 0 && (
        <div>
          <h2>Live now</h2>
          <LiveTiles data={data} matches={live} onOpenLiveWindow={onOpenLiveWindow} />
        </div>
      )}
    </div>
  );
}

function LiveTiles({ data, matches, onOpenLiveWindow }) {
  return (
    <div className="live-strip">
      {matches.map((m) => {
        const a = sideOf(m.id, "A", data);
        const b = sideOf(m.id, "B", data);
        const court = courtFor(m, data);
        const ump = umpireFor(m, data);
        const sa = m.score_state?.scoreA ?? 0;
        const sb = m.score_state?.scoreB ?? 0;
        return (
          <div key={m.id} className="live-tile">
            <div className="kicker">{court?.name || "Unassigned court"}</div>
            <div className="live-tile-status">LIVE</div>
            <div className="pts">{sa} – {sb}</div>
            <div className="live-tile-names">{a.name} vs {b.name}</div>
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
          </div>
        );
      })}
    </div>
  );
}

function LivePanel({ data, live, upcoming, tournamentId }) {
  return (
    <div className="stack">
      <h2>Live</h2>
      {live.length === 0 ? (
        <EmptyState title="No live matches">Assigned matches appear here when an umpire starts them.</EmptyState>
      ) : (
        <LiveTiles data={data} matches={live} onOpenLiveWindow={(matchId) => openLiveMatchWindow(tournamentId, matchId)} />
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
  return (
    <Card as="form" className="stack" onSubmit={(e) => { e.preventDefault(); run("Save settings", "update_tournament", { tournament_id: t.id, name }); }}>
      <h2>Tournament settings</h2>
      <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
      <Button type="submit" disabled={!!busy}>Save</Button>
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
          <Select label="Format" value={format} onChange={(e) => setFormat(e.target.value)}>
            <option value="single_elim">Single elimination</option>
            <option value="team_elimination">Team elimination</option>
            <option value="round_robin">Round robin</option>
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
            <Select label="Same-team matchup policy" value={sameTeamPolicy} onChange={(e) => setSameTeamPolicy(e.target.value)}>
              <option value="allow_anywhere">Allow anywhere</option>
              <option value="avoid_quarterfinals">Avoid quarterfinals</option>
              <option value="avoid_semis">Avoid semis</option>
              <option value="avoid_until_final">Avoid until final</option>
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
                <h3>{d.name}</h3>
                <div className="muted">{FORMAT_LABEL[d.format] || d.format}</div>
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
                >
                  <option value="allow_anywhere">Allow anywhere</option>
                  <option value="avoid_quarterfinals">Avoid quarterfinals</option>
                  <option value="avoid_semis">Avoid semis</option>
                  <option value="avoid_until_final">Avoid until final</option>
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

function PlayersPanel({ data, busy, run }) {
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
      <Card as="form" className="stack" onSubmit={(e) => {
        e.preventDefault();
        run("Add player", "add_person", { tournament_id: data.tournament.id, display_name: display });
        setDisplay("");
      }}>
        <h2>Add player</h2>
        <Input label="Player name" value={display} onChange={(e) => setDisplay(e.target.value)} required />
        <Button type="submit" disabled={!!busy}>Add player</Button>
      </Card>
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
      <Input label="Search players" value={query} onChange={(e) => setQuery(e.target.value)} />
      {data.persons.length === 0 ? (
        <EmptyState title="No players">Add a player, then register them into a division.</EmptyState>
      ) : (
        <Table
          columns={[
            { key: "display_name", header: "Player" },
            {
              key: "entries",
              header: "Registered as",
              render: (p) => {
                const n = (data.participantMembers || []).filter((m) => m.person_id === p.id).length;
                return n || "—";
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

function TeamsPanel({ data, busy, run }) {
  const [name, setName] = useState("");
  const [divisionId, setDivisionId] = useState(data.divisions[0]?.id || "");
  const [addPersonByTeam, setAddPersonByTeam] = useState({});
  const [search, setSearch] = useState({});
  const members = data.teamMembers || [];
  return (
    <div className="stack">
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
      {data.teams.length === 0 && (
        <EmptyState title="No teams">Required for team elimination. Create a team, then add members.</EmptyState>
      )}
      {data.teams.map((t) => {
        const roster = members.filter((m) => m.team_id === t.id);
        const q = (search[t.id] || "").toLowerCase();
        const assigned = assignedPersonIdsInDivision(data, t.division_id, {
          exceptTeamId: t.id,
          exceptParticipantTeamId: t.id,
        });
        const onThisTeam = new Set(roster.map((m) => m.person_id));
        const options = data.persons.filter((p) => {
          if (onThisTeam.has(p.id)) return false;
          if (assigned.has(p.id)) return false;
          if (q && !p.display_name.toLowerCase().includes(q)) return false;
          return true;
        });
        const personId = addPersonByTeam[t.id] || options[0]?.id || "";
        return (
          <Card className="stack" key={t.id}>
            <div>
              <h3>{t.name}</h3>
              <div className="muted">{roster.length === 0 ? "Empty roster" : `${roster.length} member${roster.length === 1 ? "" : "s"}`}</div>
            </div>
            {roster.length === 0 ? (
              <EmptyState title="No members yet">Search a player from this tournament and add them.</EmptyState>
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
              if (!personId) return;
              run("Add member", "add_team_member", { team_id: t.id, person_id: personId });
            }}>
              <Input
                label="Search player"
                value={search[t.id] || ""}
                onChange={(e) => setSearch((prev) => ({ ...prev, [t.id]: e.target.value }))}
              />
              <Select
                label="Player"
                value={personId}
                onChange={(e) => setAddPersonByTeam((prev) => ({ ...prev, [t.id]: e.target.value }))}
              >
                {options.length === 0 && <option value="">No matching players</option>}
                {options.map((p) => <option key={p.id} value={p.id}>{p.display_name}</option>)}
              </Select>
              <Button type="submit" disabled={!!busy || !options.length}>Add member</Button>
            </form>
          </Card>
        );
      })}
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
          columns={[
            { key: "name", header: "Court" },
            { key: "status", header: "Status", render: (c) => {
              const live = liveIds.has(c.id);
              const devices = (data.courtDevices || []).filter((d) => d.court_id === c.id);
              const active = devices.find((d) => d.status === "active");
              const revoked = !active && devices.some((d) => d.status === "revoked");
              if (live) return <StatusBadge status="in_progress" />;
              if (active) return <Badge tone="ok">PAIRED</Badge>;
              if (revoked) return <Badge tone="warn">REVOKED</Badge>;
              return <Badge tone="muted">AVAILABLE</Badge>;
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

function UmpiresPanel({ data, session, busy, run }) {
  const [userId, setUserId] = useState("");
  return (
    <div className="stack">
      <Card as="form" className="stack" onSubmit={(e) => {
        e.preventDefault();
        run("Add umpire", "add_member", { tournament_id: data.tournament.id, user_id: userId.trim(), role: "umpire" });
        setUserId("");
      }}>
        <h2>Add umpire</h2>
        <p className="muted">Paste the umpire account UUID from Auth. Your id: {session.user.id}</p>
        <Input label="User UUID" value={userId} onChange={(e) => setUserId(e.target.value)} required />
        <Button type="submit" disabled={!!busy}>Add umpire</Button>
      </Card>
      {data.members.length === 0 ? (
        <EmptyState title="No staff yet" />
      ) : (
        <Table
          columns={[
            { key: "name", header: "Person", render: (m) => memberName(m.user_id, data.profiles) },
            { key: "role", header: "Role" },
          ]}
          rows={data.members}
        />
      )}
    </div>
  );
}

function MatchTable({ data, rows, busy, run }) {
  return (
    <Table
      columns={[
        {
          key: "match",
          header: "Match",
          render: (m) => `${sideOf(m.id, "A", data).name} vs ${sideOf(m.id, "B", data).name}`,
        },
        {
          key: "meta",
          header: "Round",
          render: (m) => `R${m.round}${m.stage_label ? ` · ${m.stage_label.replaceAll("_", " ")}` : ""}`,
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
      ]}
      rows={rows}
      rowProps={(m) => ({ "data-live": m.status === "in_progress" ? "true" : undefined })}
      empty={<EmptyState title="No matches">Generate a bracket from Divisions.</EmptyState>}
    />
  );
}

function MatchesPanel({ data, busy, run }) {
  const rows = playableMatches(data.matches);
  return (
    <div className="stack">
      <p className="muted">Court and umpire assignment writes through the command API.</p>
      <MatchTable data={data} rows={rows} busy={busy} run={run} />
    </div>
  );
}

function ResultsPanel({ data }) {
  const completed = data.matches.filter((m) => m.status === "completed" || m.status === "bye");
  if (!completed.length) return <EmptyState title="No completed matches yet">Results appear here after an umpire completes a match.</EmptyState>;
  return (
    <Table
      columns={[
        { key: "match", header: "Match", render: (m) => `${sideOf(m.id, "A", data).name} vs ${sideOf(m.id, "B", data).name}` },
        { key: "status", header: "Status", render: (m) => <StatusBadge status={m.status} /> },
        { key: "winner", header: "Winner", render: (m) => m.winner ? sideOf(m.id, m.winner, data).name : "—" },
        { key: "score", header: "Score", render: (m) => scoreLine(m, resultFor(m, data.results)) },
      ]}
      rows={completed}
    />
  );
}
