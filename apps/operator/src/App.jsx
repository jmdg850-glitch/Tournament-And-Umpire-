import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient, envConfig, sendCommand, authRedirectUrl, applyAuthCallback, isRecoveryAuthUrl } from "@tournament/client";
import { parseLiveHash } from "@tournament/engine";
import {
  Alert,
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  LoadingState,
  Modal,
  NavGroup,
  NavItem,
  PageShell,
  Select,
  Skeleton,
  Stat,
  StatusBadge,
  Table,
  ToastProvider,
  useToast,
} from "@tournament/ui";
import { ArrowRight, LayoutDashboard, LogOut, Plus, RefreshCw, Trash2 } from "lucide-react";
import TournamentDesk from "./TournamentDesk.jsx";
import LiveMatchWindow from "./LiveMatchWindow.jsx";
import UpdateBanner, { useDesktopUpdateContext } from "./UpdateBanner.jsx";
import AuthLayout from "./AuthLayout.jsx";
import { firstQueryError, isToday } from "./lib.js";
import { version as APP_VERSION } from "../package.json";

function useConfig() {
  return useMemo(() => envConfig(), []);
}

export default function App() {
  const cfg = useConfig();
  const supabase = useMemo(() => createBrowserClient(cfg.url, cfg.publishableKey), [cfg]);
  const [session, setSession] = useState(undefined);
  const [error, setError] = useState("");
  const [recovering, setRecovering] = useState(() => isRecoveryAuthUrl());
  const [liveRoute, setLiveRoute] = useState(() => parseLiveHash(typeof window === "undefined" ? "" : window.location.hash));

  useEffect(() => {
    function onHash() {
      setLiveRoute(parseLiveHash(window.location.hash));
    }
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    applyAuthCallback(supabase);
    if (isRecoveryAuthUrl()) setRecovering(true);
    window.tournamentDesktop?.onAuthCallback?.((url) => {
      applyAuthCallback(supabase, url);
      if (isRecoveryAuthUrl(url)) setRecovering(true);
    });
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_OUT") setRecovering(false);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  async function command(type, payload) {
    if (!session?.access_token) throw new Error("Not signed in");
    return sendCommand({
      commandUrl: cfg.commandUrl,
      accessToken: session.access_token,
      publishableKey: cfg.publishableKey,
      type,
      payload,
    });
  }

  if (session === undefined) {
    return (
      <div className="auth-wrap">
        <UpdateBanner />
        <LoadingState label="Restoring session" />
      </div>
    );
  }
  if (liveRoute) {
    return (
      <LiveMatchWindow
        supabase={supabase}
        session={session}
        tournamentId={liveRoute.tournamentId}
        matchId={liveRoute.matchId}
      />
    );
  }
  if (!session) {
    return (
      <>
        <UpdateBanner />
        <AuthScreen supabase={supabase} error={error} setError={setError} />
      </>
    );
  }
  if (recovering) {
    return (
      <>
        <UpdateBanner />
        <RecoveryScreen
          supabase={supabase}
          title="Operator desk"
          onDone={() => setRecovering(false)}
          onSignOut={() => supabase.auth.signOut({ scope: "local" })}
        />
      </>
    );
  }

  return (
    <ToastProvider>
      <UpdateBanner />
      <SignedIn
        supabase={supabase}
        session={session}
        command={command}
        onSignOut={() => supabase.auth.signOut({ scope: "local" })}
      />
    </ToastProvider>
  );
}

function AuthScreen({ supabase, error, setError }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState("");

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (mode === "login") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else if (mode === "signup") {
        if (!name.trim()) throw new Error("Display name is required");
        const { error: err } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: name.trim() },
            emailRedirectTo: authRedirectUrl(),
          },
        });
        if (err) throw err;
        setInfo("Account created. If email confirmation is enabled, check your inbox, then sign in.");
      } else {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: authRedirectUrl(),
        });
        if (err) throw err;
        setInfo("Password reset email sent if that account exists.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Operator" subtitle="Run registration, courts, and live matches from one desk.">
      <form className="stack" onSubmit={submit} style={{ marginTop: "var(--space-5)" }}>
        <div className="auth-modes">
          <Button variant={mode === "login" ? "primary" : "secondary"} onClick={() => setMode("login")}>Sign in</Button>
          <Button variant={mode === "signup" ? "primary" : "secondary"} onClick={() => setMode("signup")}>Create account</Button>
          <Button variant={mode === "reset" ? "primary" : "secondary"} onClick={() => setMode("reset")}>Reset password</Button>
        </div>
        {mode === "signup" && (
          <Input label="Display name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />
        )}
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        {mode !== "reset" && (
          <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === "login" ? "current-password" : "new-password"} />
        )}
        {error && <Alert>{error}</Alert>}
        {info && <Alert tone="ok">{info}</Alert>}
        <Button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Sign in" : mode === "signup" ? "Create organizer account" : "Send reset"}
        </Button>
      </form>
    </AuthLayout>
  );
}

function RecoveryScreen({ supabase, title, onDone, onSignOut }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: err } = await supabase.auth.updateUser({ password });
      if (err) throw err;
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={title} subtitle="Choose a new password to finish reset.">
      <form className="stack" onSubmit={submit} style={{ marginTop: "var(--space-5)" }}>
        <Input label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        <Input label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" />
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy}>{busy ? "Working…" : "Save password"}</Button>
        <Button variant="secondary" type="button" onClick={onSignOut}>Cancel</Button>
      </form>
    </AuthLayout>
  );
}

function SignedIn({ supabase, session, command, onSignOut }) {
  const toast = useToast();
  const [tournaments, setTournaments] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [recentMatches, setRecentMatches] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSport, setNewSport] = useState("pickleball");
  const [showCreate, setShowCreate] = useState(false);
  const [checkedIds, setCheckedIds] = useState(new Set());
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const headerCheckboxRef = useRef(null);
  useDesktopUpdateContext({
    liveMatches: metrics?.live || 0,
    busy: creating,
    dialogOpen: false,
    enabled: !selectedId,
  });

  const reloadList = useCallback(async () => {
    const queries = await Promise.all([
      supabase.from("tournaments").select("*").order("created_at", { ascending: false }),
      supabase.from("matches").select("id, status, started_at, completed_at, created_at, tournament_id"),
      supabase.from("courts").select("id, tournament_id"),
      supabase.from("persons").select("id"),
      supabase.from("teams").select("id"),
      supabase.from("umpire_assignments").select("id, user_id, match_id"),
      supabase.from("court_devices").select("id, status"),
    ]);
    const err = firstQueryError(queries.slice(0, 6));
    if (err) {
      setLoadError(err.message);
      setTournaments(null);
      setMetrics(null);
      return;
    }
    const [t, matches, courts, persons, teams, umpires, devices] = queries;
    setLoadError("");
    setTournaments(t.data || []);
    const matchRows = matches.data || [];
    setRecentMatches(matchRows);
    setMetrics({
      tournaments: (t.data || []).length,
      active: (t.data || []).filter((x) => ["registration", "registration_closed", "ready", "in_progress"].includes(x.status)).length,
      today: matchRows.filter((m) => isToday(m.started_at || m.created_at)).length,
      live: matchRows.filter((m) => m.status === "in_progress").length,
      ready: matchRows.filter((m) => m.status === "ready" || m.status === "assigned").length,
      scheduled: matchRows.filter((m) => m.status === "scheduled").length,
      completed: matchRows.filter((m) => m.status === "completed" || m.status === "bye").length,
      courts: (courts.data || []).length,
      paired: devices.error ? 0 : (devices.data || []).filter((d) => d.status === "active").length,
      umpires: new Set((umpires.data || []).map((u) => u.user_id)).size,
      players: (persons.data || []).length,
      teams: (teams.data || []).length,
    });
  }, [supabase]);

  useEffect(() => { reloadList(); }, [reloadList]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") reloadList();
    }
    window.addEventListener("focus", reloadList);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", reloadList);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reloadList]);

  async function createTournament(e) {
    e.preventDefault();
    setCreating(true);
    setLoadError("");
    try {
      const res = await command("create_tournament", { name: newName.trim(), sport: newSport });
      setNewName("");
      setShowCreate(false);
      await reloadList();
      setSelectedId(res.result.tournament.id);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setCreating(false);
    }
  }

  const visibleTournaments = (tournaments || []).filter((t) => t.status !== "cancelled" && t.status !== "archived");
  const allChecked = visibleTournaments.length > 0 && visibleTournaments.every((t) => checkedIds.has(t.id));
  const someChecked = visibleTournaments.some((t) => checkedIds.has(t.id));
  const checkedCount = visibleTournaments.filter((t) => checkedIds.has(t.id)).length;

  useEffect(() => {
    if (headerCheckboxRef.current) headerCheckboxRef.current.indeterminate = someChecked && !allChecked;
  }, [someChecked, allChecked]);

  const recentActivity = recentMatches
    .filter((m) => m.status === "completed" || m.status === "in_progress" || m.status === "bye")
    .map((m) => ({
      id: m.id,
      at: m.completed_at || m.started_at || m.created_at,
      status: m.status,
      tournamentName: (tournaments || []).find((t) => t.id === m.tournament_id)?.name || "Tournament",
    }))
    .filter((a) => a.at)
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 8);

  function toggleAllTournaments() {
    setCheckedIds(allChecked ? new Set() : new Set(visibleTournaments.map((t) => t.id)));
  }
  function toggleTournament(id) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  async function archiveSelectedTournaments() {
    setArchiving(true);
    try {
      const targets = visibleTournaments.filter((t) => checkedIds.has(t.id));
      for (const t of targets) {
        const status = (t.status === "completed" || t.status === "cancelled") ? "archived" : "cancelled";
        await command("transition_tournament", { tournament_id: t.id, status });
      }
      setCheckedIds(new Set());
      await reloadList();
      toast(`Removed ${targets.length} tournament${targets.length === 1 ? "" : "s"} from your dashboard`);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setArchiving(false);
      setConfirmArchive(false);
    }
  }

  if (selectedId) {
    return (
      <TournamentDesk
        supabase={supabase}
        session={session}
        command={command}
        tournamentId={selectedId}
        onBack={() => { setSelectedId(null); reloadList(); }}
        onSignOut={onSignOut}
      />
    );
  }

  return (
    <PageShell
      brand={<><h1>Tournament</h1><div className="kicker">Control</div></>}
      navLabel="Sections"
      nav={
        <NavGroup>
          <NavItem icon={LayoutDashboard} label="Dashboard" active />
        </NavGroup>
      }
      foot={
        <>
          <div>{session.user.email}</div>
          <Button variant="ghost" onClick={onSignOut}><LogOut size={15} aria-hidden="true" /> Sign out</Button>
          <div className="app-version">Version {APP_VERSION}</div>
        </>
      }
      overlay={(
        <>
          {showCreate && (
        <Modal title="Create your tournament" onClose={() => !creating && setShowCreate(false)}>
          <form className="stack" onSubmit={createTournament}>
            <Input
              label="Tournament name"
              hint="What should we call this tournament?"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Open at Riverside"
              required
              autoFocus
            />
            <Select label="Sport" hint="What sport are you running?" value={newSport} onChange={(e) => setNewSport(e.target.value)}>
              <option value="pickleball">Pickleball</option>
              <option value="tennis">Tennis</option>
              <option value="badminton">Badminton</option>
              <option value="squash">Squash</option>
              <option value="table_tennis">Table tennis</option>
              <option value="other">Other</option>
            </Select>
            <p className="muted" style={{ margin: 0 }}>Next you'll add divisions, players, and courts — we'll walk you through each step.</p>
            {loadError && <Alert>{loadError}</Alert>}
            <div className="row">
              <Button type="submit" disabled={creating || !newName.trim()}>{creating ? "Creating…" : "Create tournament"}</Button>
              <Button type="button" variant="secondary" disabled={creating} onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </form>
        </Modal>
          )}
          {confirmArchive && (
            <ConfirmDialog
              title={`Remove ${checkedCount} selected tournament${checkedCount === 1 ? "" : "s"}?`}
              body="This removes them from your active dashboard. Tournament data isn't deleted, but this can't be undone from this screen."
              confirmLabel="Remove from dashboard"
              danger
              busy={archiving}
              onCancel={() => setConfirmArchive(false)}
              onConfirm={archiveSelectedTournaments}
            />
          )}
        </>
      )}
    >
          <div className="hero-banner">
            <div>
              <div className="kicker" style={{ color: "rgba(255,255,255,0.75)" }}>Operations</div>
              <h1>Welcome back</h1>
              <p>Everything happening across your tournaments, live courts, and staff.</p>
            </div>
            <div className="row">
              <Button variant="secondary" className="hero-btn-ghost" onClick={reloadList}><RefreshCw size={15} aria-hidden="true" /> Refresh</Button>
              <Button className="hero-btn-solid" onClick={() => setShowCreate(true)}><Plus size={15} aria-hidden="true" /> New tournament</Button>
            </div>
          </div>
          {loadError && (
            <div className="stack">
              <Alert>{loadError}</Alert>
              <Button onClick={reloadList}>Retry</Button>
            </div>
          )}
          {!loadError && tournaments === null && (
            <div className="stack">
              <LoadingState label="Loading dashboard" />
              <Skeleton lines={5} />
            </div>
          )}
          {!loadError && metrics && (
            <>
              <div className="ops-board">
                <Stat tone={metrics.live ? "hero live" : "hero"} value={metrics.live} label="Live matches" />
                <Stat value={metrics.ready} label="Ready to start" />
                <Stat value={metrics.scheduled} label="Scheduled" />
                <Stat value={metrics.completed} label="Completed" />
              </div>
              <div className="section-label" style={{ marginTop: "var(--space-5)" }}>Tournament overview</div>
              <div className="grid4">
                <Stat value={metrics.active} label="Active tournaments" />
                <Stat value={metrics.paired} label="Paired courts" />
                <Stat value={metrics.courts} label="Courts" />
                <Stat tone="quiet" value={metrics.today} label="Today's matches" />
                <Stat tone="quiet" value={metrics.umpires} label="Umpires" />
                <Stat tone="quiet" value={metrics.players} label="Players" />
                <Stat tone="quiet" value={metrics.teams} label="Teams" />
              </div>
              <div style={{ height: "var(--space-5)" }} />
              <div className="dashboard-columns">
                <div className="stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div className="section-label" style={{ marginBottom: 0 }}>Your tournaments</div>
                    {someChecked && (
                      <Button variant="danger" className="compact" onClick={() => setConfirmArchive(true)}>
                        <Trash2 size={14} aria-hidden="true" /> Delete Selected ({checkedCount})
                      </Button>
                    )}
                  </div>
                  {visibleTournaments.length === 0 ? (
                    <EmptyState
                      title={tournaments.length === 0 ? "No tournaments yet" : "No active tournaments"}
                      action={<Button onClick={() => setShowCreate(true)}><Plus size={15} aria-hidden="true" /> Create your first tournament</Button>}
                    >
                      {tournaments.length === 0
                        ? "Set up a name and sport, then add divisions, players, and courts — we'll guide you through each step."
                        : "Every tournament here has been removed from the dashboard."}
                    </EmptyState>
                  ) : (
                    <Table
                      responsive
                      columns={[
                        {
                          key: "select",
                          header: (
                            <input
                              ref={headerCheckboxRef}
                              type="checkbox"
                              aria-label="Select all tournaments"
                              checked={allChecked}
                              onChange={toggleAllTournaments}
                            />
                          ),
                          render: (row) => (
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.name}`}
                              checked={checkedIds.has(row.id)}
                              onChange={() => toggleTournament(row.id)}
                            />
                          ),
                        },
                        { key: "name", header: "Tournament" },
                        {
                          key: "status",
                          header: "Status",
                          render: (row) => <StatusBadge status={row.status} kind="tournament" />,
                        },
                        { key: "sport", header: "Sport" },
                        {
                          key: "open",
                          header: "",
                          render: (row) => (
                            <Button variant="secondary" onClick={() => setSelectedId(row.id)}>Open <ArrowRight size={15} aria-hidden="true" /></Button>
                          ),
                        },
                      ]}
                      rows={visibleTournaments}
                    />
                  )}
                </div>
                <div className="stack">
                  <div className="section-label" style={{ marginBottom: 0 }}>Recent activity</div>
                  <Card className="activity-feed">
                    {recentActivity.length === 0 ? (
                      <EmptyState title="No activity yet">Activity shows up here once matches start or finish.</EmptyState>
                    ) : (
                      <ul className="activity-list">
                        {recentActivity.map((a) => (
                          <li key={a.id} className="activity-item">
                            <span className={`activity-dot ${a.status === "in_progress" ? "live" : ""}`} aria-hidden="true" />
                            <div>
                              <div>
                                {a.status === "in_progress" ? "Match live" : a.status === "bye" ? "Bye recorded" : "Match completed"} in {a.tournamentName}
                              </div>
                              <div className="muted activity-time">{new Date(a.at).toLocaleString()}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </div>
              </div>
            </>
          )}
    </PageShell>
  );
}
