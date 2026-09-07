import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient, envConfig, sendCommand, pairStation, authRedirectUrl, applyAuthCallback, isRecoveryAuthUrl } from "@tournament/client";
import { applyOptimisticScore, mergeMatchFromResult, reconcileAuthoritativeScore, isCoinTossCommitted } from "@tournament/engine";
import { clearStation, parsePairingInput, readStation, writeStation } from "./stationSession.js";
import PairingScanner from "./PairingScanner.jsx";
import CoinTossPanel from "./CoinTossPanel.jsx";
import {
  Alert,
  Badge,
  Button,
  Card,
  ClickableCard,
  ConfirmDialog,
  EmptyState,
  Input,
  LoadingState,
  Scoreboard,
  StatusBadge,
} from "@tournament/ui";
import { ArrowLeft, LogOut, QrCode, RefreshCw } from "lucide-react";
import { version as APP_VERSION } from "../package.json";

function isStationInactiveError(err) {
  const msg = String(err?.message || err || "");
  return Number(err?.status) === 401 || /not active|revoked|unauthorized/i.test(msg);
}

function participantNameFor(sides, participants, matchId, slot) {
  const side = sides.find((x) => x.match_id === matchId && x.slot === slot);
  const part = participants.find((p) => p.id === side?.participant_id);
  return part?.display_name || (side?.team_id ? `Team ${slot}` : `Side ${slot}`);
}

export default function App() {
  const cfg = useMemo(() => envConfig(), []);
  const supabase = useMemo(() => createBrowserClient(cfg.url, cfg.publishableKey), [cfg]);
  const [session, setSession] = useState(undefined);
  const [station, setStation] = useState(() => (typeof window === "undefined" ? null : readStation()));
  const [error, setError] = useState("");
  const [matchId, setMatchId] = useState(null);
  const [recovering, setRecovering] = useState(() => isRecoveryAuthUrl());

  useEffect(() => {
    applyAuthCallback(supabase);
    if (isRecoveryAuthUrl()) setRecovering(true);
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_OUT") setRecovering(false);
    });
    return () => sub.subscription.unsubscribe();
  }, [supabase]);

  if (session === undefined) {
    return (
      <div className="ump-shell">
        <div className="ump-top"><LoadingState label="Restoring session" /></div>
      </div>
    );
  }
  if (station?.access_token) {
    return matchId ? (
      <MatchDesk
        cfg={cfg}
        supabase={supabase}
        session={{ access_token: station.access_token }}
        station={station}
        matchId={matchId}
        onBack={() => setMatchId(null)}
        onSignOut={() => { clearStation(); setStation(null); setMatchId(null); }}
      />
    ) : (
      <CourtQueue
        cfg={cfg}
        station={station}
        setStation={setStation}
        onOpen={setMatchId}
        onUnpair={() => { clearStation(); setStation(null); }}
      />
    );
  }
  if (!session) return <Auth cfg={cfg} supabase={supabase} error={error} setError={setError} onPaired={setStation} />;
  if (recovering) {
    return (
      <RecoveryScreen
        supabase={supabase}
        onDone={() => setRecovering(false)}
        onSignOut={() => supabase.auth.signOut({ scope: "local" })}
      />
    );
  }

  return matchId ? (
    <MatchDesk
      cfg={cfg}
      supabase={supabase}
      session={session}
      matchId={matchId}
      onBack={() => setMatchId(null)}
      onSignOut={() => supabase.auth.signOut({ scope: "local" })}
    />
  ) : (
    <MyMatches
      supabase={supabase}
      session={session}
      onOpen={setMatchId}
      onSignOut={() => supabase.auth.signOut({ scope: "local" })}
    />
  );
}

function Auth({ cfg, supabase, error, setError, onPaired }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("pair");
  const [info, setInfo] = useState("");
  const [pairText, setPairText] = useState("");
  const [scanning, setScanning] = useState(false);

  async function pairWithRaw(raw) {
    const parsed = parsePairingInput(raw);
    const body = await pairStation({
      pairStationUrl: cfg.pairStationUrl,
      publishableKey: cfg.publishableKey,
      pairingToken: parsed.pairingToken,
      stationPublicId: parsed.stationPublicId,
      deviceLabel: "Tournament Umpire",
    });
    writeStation(body.result);
    onPaired(body.result);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setInfo("");
    try {
      if (mode === "pair") {
        await pairWithRaw(pairText);
        return;
      }
      if (mode === "reset") {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: authRedirectUrl() });
        if (err) throw err;
        setInfo("Reset email sent if the account exists.");
      } else {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap ump-auth" style={{ background: "var(--court-2)" }}>
      <div className="auth-panel">
        <div className="kicker">Tournament</div>
        <h1>Umpire</h1>
        <div className="tape" />
        <p className="muted">
          {mode === "pair"
            ? "Pair this court. Scan the organizer QR or enter the pairing code. New matches on that court do not need another scan."
            : "Assigned matches only. Scores persist through refresh."}
        </p>
        <form className="stack" onSubmit={submit} style={{ marginTop: 16 }}>
          {mode === "pair" ? (
            <>
              <h2 style={{ margin: 0 }}>Pair this court</h2>
              <Button type="button" disabled={busy} onClick={() => { setScanning(true); setError(""); }}>
                <QrCode size={16} aria-hidden="true" /> Scan QR code
              </Button>
              {scanning && (
                <PairingScanner
                  onDetected={async (raw) => {
                    setPairText(raw);
                    setScanning(false);
                    setBusy(true);
                    setError("");
                    try {
                      await pairWithRaw(raw);
                    } catch (err) {
                      setError(err.message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                  onClose={() => setScanning(false)}
                />
              )}
              <p className="muted">or</p>
              <Input label="Enter pairing code" value={pairText} onChange={(e) => setPairText(e.target.value)} placeholder="Paste the organizer pairing JSON" />
            </>
          ) : (
            <>
              <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
              {mode !== "reset" && (
                <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              )}
            </>
          )}
          {error && <Alert>{error}</Alert>}
          {info && <Alert tone="ok">{info}</Alert>}
          <Button type="submit" disabled={busy || (mode === "pair" && !pairText.trim())}>
            {busy ? "Working…" : mode === "pair" ? "Pair" : mode === "reset" ? "Send reset" : "Sign in"}
          </Button>
          <Button variant="secondary" type="button" onClick={() => setMode(mode === "pair" ? "login" : "pair")}>
            {mode === "pair" ? "Use umpire account" : "Pair a court instead"}
          </Button>
          {mode !== "pair" && (
            <Button variant="secondary" type="button" onClick={() => setMode(mode === "reset" ? "login" : "reset")}>
              {mode === "reset" ? "Back to sign in" : "Forgot password"}
            </Button>
          )}
        </form>
      </div>
    </div>
  );
}

function RecoveryScreen({ supabase, onDone, onSignOut }) {
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
    <div className="auth-wrap ump-auth" style={{ background: "var(--court-2)" }}>
      <div className="auth-panel">
        <div className="kicker">Tournament</div>
        <h1>Umpire</h1>
        <div className="tape" />
        <p className="muted">Choose a new password to finish reset.</p>
        <form className="stack" onSubmit={submit} style={{ marginTop: 16 }}>
          <Input label="New password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
          <Input label="Confirm password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8} autoComplete="new-password" />
          {error && <Alert>{error}</Alert>}
          <Button type="submit" disabled={busy}>{busy ? "Working…" : "Save password"}</Button>
          <Button variant="secondary" type="button" onClick={onSignOut}>Cancel</Button>
        </form>
      </div>
    </div>
  );
}

function groupMatches(rows) {
  const live = rows.filter((m) => m.status === "in_progress");
  const ready = rows.filter((m) => ["ready", "assigned"].includes(m.status));
  const upcoming = rows.filter((m) => m.status === "scheduled");
  const done = rows.filter((m) => ["completed", "bye", "cancelled", "abandoned"].includes(m.status));
  const other = rows.filter((m) => ![...live, ...ready, ...upcoming, ...done].some((x) => x.id === m.id));
  return { live, ready, upcoming, done, other };
}

function MyMatches({ supabase, session, onOpen, onSignOut }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ courts: [], sides: [], participants: [] });
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showAllDone, setShowAllDone] = useState(false);

  const load = useCallback(async () => {
    const { data: assigned, error: e1 } = await supabase
      .from("umpire_assignments")
      .select("*")
      .eq("user_id", session.user.id);
    if (e1) { setError(e1.message); setRows(null); return; }
    const ids = (assigned || []).map((a) => a.match_id);
    if (!ids.length) {
      setError("");
      setRows([]);
      setMeta({ courts: [], sides: [], participants: [] });
      return;
    }
    const [matches, courtsA, sides, courts, participants] = await Promise.all([
      supabase.from("matches").select("*").in("id", ids),
      supabase.from("court_assignments").select("*").in("match_id", ids),
      supabase.from("match_participants").select("*").in("match_id", ids),
      supabase.from("courts").select("*"),
      supabase.from("participants").select("*"),
    ]);
    const first = [matches, courtsA, sides].find((x) => x.error);
    if (first?.error) { setError(first.error.message); setRows(null); return; }
    setError("");
    const courtByMatch = Object.fromEntries((courtsA.data || []).map((a) => [a.match_id, a.court_id]));
    const courtName = Object.fromEntries((courts.data || []).map((c) => [c.id, c.name]));
    setRows((matches.data || []).map((m) => ({ ...m, courtName: courtName[courtByMatch[m.id]] || null })));
    setMeta({ sides: sides.data || [], participants: participants.data || [] });
  }, [supabase, session.user.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") load();
    }
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const nameFor = (matchId, slot) => participantNameFor(meta.sides, meta.participants, matchId, slot);

  const filtered = (rows || []).filter((m) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    const a = nameFor(m.id, "A").toLowerCase();
    const b = nameFor(m.id, "B").toLowerCase();
    return (
      (m.courtName || "").toLowerCase().includes(q) ||
      m.status.toLowerCase().includes(q) ||
      (m.stage_label || "").toLowerCase().includes(q) ||
      a.includes(q) ||
      b.includes(q)
    );
  });
  const grouped = rows ? groupMatches(filtered) : null;
  const doneRows = grouped ? (showAllDone ? grouped.done : grouped.done.slice(0, 8)) : [];

  return (
    <div className="ump-shell">
      <header className="ump-top">
        <div>
          <div className="kicker">Umpire</div>
          <h1 style={{ fontSize: "1.4rem" }}>Matches</h1>
          <div className="muted" style={{ color: "var(--muted-court)" }}>{session.user.email}</div>
          <div className="muted app-version" style={{ color: "var(--muted-court)", fontSize: "var(--text-xs)" }}>Version {APP_VERSION}</div>
        </div>
        <div className="row">
          <Button variant="secondary" onClick={load}><RefreshCw size={15} aria-hidden="true" /> Refresh</Button>
          <Button variant="secondary" onClick={onSignOut}><LogOut size={15} aria-hidden="true" /> Sign out</Button>
        </div>
      </header>
      <div className="ump-list">
        {error && (
          <>
            <Alert>{error}</Alert>
            <Button onClick={load}>Retry</Button>
          </>
        )}
        {rows === null && !error && <LoadingState label="Loading assignments" />}
        {rows?.length === 0 && <EmptyState title="No assigned matches">When an organizer assigns you, matches appear here.</EmptyState>}
        {rows?.length > 0 && (
          <Input label="Search matches" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Court, player, status" />
        )}
        {grouped && (
          <>
            <MatchGroup title="Live now" rows={grouped.live} onOpen={onOpen} nameFor={nameFor} />
            <MatchGroup title="Ready to start" rows={grouped.ready} onOpen={onOpen} nameFor={nameFor} />
            <MatchGroup title="Upcoming" rows={grouped.upcoming} onOpen={onOpen} nameFor={nameFor} />
            <MatchGroup title="Completed" rows={doneRows} onOpen={onOpen} nameFor={nameFor} />
            {grouped.done.length > 8 && (
              <Button variant="secondary" onClick={() => setShowAllDone((v) => !v)}>
                {showAllDone ? "Show fewer completed" : `Show all completed (${grouped.done.length})`}
              </Button>
            )}
            {grouped.other.length > 0 && <MatchGroup title="Other" rows={grouped.other} onOpen={onOpen} nameFor={nameFor} />}
          </>
        )}
      </div>
    </div>
  );
}

const STAGE_LABEL = {
  round_robin: "Qualification",
  semifinal: "Semifinal",
  bronze: "Bronze",
  final: "Final",
  knockout: "Playoffs",
};
function stageTitle(label) {
  return STAGE_LABEL[label] || String(label || "").replaceAll("_", " ");
}

function MatchGroup({ title, rows, onOpen, nameFor }) {
  if (!rows.length) return null;
  return (
    <section>
      <div className="section-label">{title}</div>
      {rows.map((m) => (
        <ClickableCard key={m.id} className="ump-card" live={m.status === "in_progress"} onClick={() => onOpen(m.id)}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <strong>{m.courtName || "No court"}</strong>
            {m.status === "in_progress" ? <Badge tone="live">● LIVE</Badge> : <StatusBadge status={m.status} />}
          </div>
          <div className="ump-name">{nameFor(m.id, "A")} vs {nameFor(m.id, "B")}</div>
          <div className="muted" style={{ color: "var(--muted-court)" }}>
            {m.score_state?.scoreA != null ? `${m.score_state.scoreA}–${m.score_state.scoreB}` : "No score yet"}
            {m.stage_label ? ` · ${stageTitle(m.stage_label)}` : ` · Round ${m.round}`}
          </div>
        </ClickableCard>
      ))}
    </section>
  );
}

function CourtQueue({ cfg, station, setStation, onOpen, onUnpair }) {
  const [rows, setRows] = useState(null);
  const [meta, setMeta] = useState({ sides: [], participants: [] });
  const [error, setError] = useState("");
  const [court, setCourt] = useState(station.court || null);
  const stationRef = useRef(station);
  stationRef.current = station;

  const load = useCallback(async () => {
    const st = stationRef.current;
    try {
      const body = await sendCommand({
        commandUrl: cfg.commandUrl,
        accessToken: st.access_token,
        publishableKey: cfg.publishableKey,
        type: "station_sync",
        payload: {},
      });
      const sync = body.result;
      setCourt(sync.court);
      setRows((sync.matches || []).map((m) => ({ ...m, courtName: sync.court?.name || null })));
      setMeta({ sides: sync.sides || [], participants: sync.participants || [] });
      setError("");
      if (sync.court) {
        const next = { ...stationRef.current, court: sync.court };
        writeStation(next);
        const prev = stationRef.current.court;
        if (prev?.id !== sync.court.id || prev?.name !== sync.court.name) {
          setStation(next);
        } else {
          stationRef.current = next;
        }
      }
    } catch (err) {
      if (err.status === 401 && st.refresh_token) {
        try {
          const refreshed = await pairStation({
            pairStationUrl: cfg.pairStationUrl,
            publishableKey: cfg.publishableKey,
            refreshToken: st.refresh_token,
            action: "refresh",
          });
          const next = { ...stationRef.current, ...refreshed.result };
          writeStation(next);
          setStation(next);
          return;
        } catch (refreshErr) {
          setError(isStationInactiveError(refreshErr)
            ? "This court station was revoked. Pair again with a new QR."
            : refreshErr.message);
          setRows(null);
          return;
        }
      }
      setError(isStationInactiveError(err)
        ? "This court station was revoked. Pair again with a new QR."
        : err.message);
      setRows(null);
    }
  }, [cfg.commandUrl, cfg.publishableKey, cfg.pairStationUrl, station.access_token, station.refresh_token, setStation]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") load();
    }
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const nameFor = (id, slot) => participantNameFor(meta.sides, meta.participants, id, slot);
  const grouped = rows ? groupMatches(rows) : null;

  return (
    <div className="ump-shell">
      <header className="ump-top">
        <div>
          <div className="kicker">Connected</div>
          <h1 style={{ fontSize: "1.4rem" }}>{court?.name || "Court"}</h1>
          <div className="muted">Paired. Open the current match to score.</div>
        </div>
        <div className="row">
          <Button variant="secondary" onClick={load}><RefreshCw size={15} aria-hidden="true" /> Refresh</Button>
          <Button variant="secondary" onClick={onUnpair}><LogOut size={15} aria-hidden="true" /> Unpair</Button>
        </div>
      </header>
      <div className="ump-list">
        {error && (
          <>
            <Alert>{error}</Alert>
            {/revoked/i.test(error)
              ? <Button onClick={onUnpair}>Pair again</Button>
              : <Button onClick={load}>Retry</Button>}
          </>
        )}
        {rows === null && !error && <LoadingState label="Loading court" />}
        {rows?.length === 0 && <EmptyState title="No matches on this court">When an organizer assigns a match here, it appears without a new QR scan.</EmptyState>}
        {grouped && (
          <>
            <MatchGroup title="Live now" rows={grouped.live} onOpen={onOpen} nameFor={nameFor} />
            <MatchGroup title="Ready to start" rows={grouped.ready} onOpen={onOpen} nameFor={nameFor} />
            <MatchGroup title="Upcoming" rows={grouped.upcoming} onOpen={onOpen} nameFor={nameFor} />
            <MatchGroup title="Completed" rows={grouped.done.slice(0, 8)} onOpen={onOpen} nameFor={nameFor} />
          </>
        )}
      </div>
    </div>
  );
}

function MatchDesk({ cfg, supabase, session, station, matchId, onBack, onSignOut }) {
  const [match, setMatch] = useState(null);
  const [sides, setSides] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [court, setCourt] = useState(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const matchRef = useRef(null);
  const seqRef = useRef(0);
  const epochRef = useRef(0);
  const pendingRef = useRef(0);
  matchRef.current = match;

  const load = useCallback(async () => {
    if (pendingRef.current > 0) return;
    if (station) {
      try {
        const body = await sendCommand({
          commandUrl: cfg.commandUrl,
          accessToken: session.access_token,
          publishableKey: cfg.publishableKey,
          type: "station_sync",
          payload: {},
        });
        const sync = body.result;
        const m = (sync.matches || []).find((row) => row.id === matchId);
        if (!m) { setLoadError("This match is not on this court."); setMatch(null); return; }
        setMatch(m);
        seqRef.current = Number(m.score_state?.lastSeq || 0);
        setSides((sync.sides || []).filter((row) => row.match_id === matchId));
        setParticipants(sync.participants || []);
        setCourt(sync.court || null);
        setLoadError("");
        setError("");
      } catch (err) {
        setLoadError(isStationInactiveError(err)
          ? "This court station was revoked. Pair again with a new QR."
          : err.message);
      }
      return;
    }
    const [m, s, ca] = await Promise.all([
      supabase.from("matches").select("*").eq("id", matchId).maybeSingle(),
      supabase.from("match_participants").select("*").eq("match_id", matchId),
      supabase.from("court_assignments").select("*").eq("match_id", matchId).maybeSingle(),
    ]);
    if (m.error) { setLoadError(m.error.message); return; }
    if (s.error) { setLoadError(s.error.message); return; }
    if (ca.error) { setLoadError(ca.error.message); return; }
    if (!m.data) { setLoadError("Match not found."); return; }
    const participantIds = [...new Set((s.data || []).map((x) => x.participant_id).filter(Boolean))];
    const [p, c] = await Promise.all([
      participantIds.length
        ? supabase.from("participants").select("*").in("id", participantIds)
        : Promise.resolve({ data: [] }),
      ca.data?.court_id
        ? supabase.from("courts").select("*").eq("id", ca.data.court_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (p.error) { setLoadError(p.error.message); return; }
    if (c?.error) { setLoadError(c.error.message); return; }
    setMatch(m.data);
    seqRef.current = Number(m.data.score_state?.lastSeq || 0);
    setSides(s.data || []);
    setParticipants(p.data || []);
    setCourt(c.data || null);
    setLoadError("");
    setError("");
  }, [supabase, matchId, station, cfg, session]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") load();
    }
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  function applyResult(result) {
    const current = matchRef.current;
    if (!current) return;
    const next = mergeMatchFromResult(current, result);
    const rec = reconcileAuthoritativeScore(current.score_state, next.score_state);
    const merged = { ...next, score_state: rec.state };
    setMatch(merged);
    seqRef.current = Number(merged.score_state?.lastSeq || seqRef.current);
  }

  async function command(type, payload) {
    setBusy(true);
    setError("");
    try {
      const body = await sendCommand({
        commandUrl: cfg.commandUrl,
        accessToken: session.access_token,
        publishableKey: cfg.publishableKey,
        type,
        payload,
      });
      if (body.result) applyResult(body.result);
      else await load();
    } catch (err) {
      setError(err.message);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function sendScore(type, extra = {}) {
    const current = matchRef.current;
    if (!current) return;
    const event_id = crypto.randomUUID();
    const seq = seqRef.current + 1;
    const event = { id: event_id, seq, type, payload: extra };
    const snapshot = current;
    const snapshotSeq = seqRef.current;
    const epoch = epochRef.current;
    try {
      const optimistic = applyOptimisticScore(current, event);
      seqRef.current = seq;
      setMatch(optimistic.match);
      setError("");
    } catch (err) {
      setError(err.message || "Could not apply that score locally");
      return;
    }
    setPending((n) => {
      const next = n + 1;
      pendingRef.current = next;
      return next;
    });
    try {
      const body = await sendCommand({
        commandUrl: cfg.commandUrl,
        accessToken: session.access_token,
        publishableKey: cfg.publishableKey,
        type: "score_event",
        payload: { match_id: current.id, event_id, seq, type, payload: extra },
      });
      if (epochRef.current !== epoch) return;
      if (body.result) applyResult(body.result);
    } catch (err) {
      epochRef.current += 1;
      seqRef.current = snapshotSeq;
      setMatch(snapshot);
      setError(err.message || "Score was not saved. Showing the official score.");
      await load();
    } finally {
      setPending((n) => {
        const next = Math.max(0, n - 1);
        pendingRef.current = next;
        return next;
      });
    }
  }

  if (loadError && !match) {
    return (
      <div className="ump-shell ump-desk">
        <header className="ump-top">
          <Button variant="secondary" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> {station ? "Court" : "My matches"}</Button>
        </header>
        <div className="ump-list">
          <Alert>{loadError}</Alert>
          {station && /revoked/i.test(loadError)
            ? <Button onClick={onSignOut}>Pair again</Button>
            : <Button onClick={load}>Retry</Button>}
        </div>
      </div>
    );
  }
  if (!match) {
    return (
      <div className="ump-shell ump-desk">
        <div className="ump-top"><LoadingState label="Loading match" /></div>
      </div>
    );
  }

  const nameFor = (slot) => {
    const side = sides.find((x) => x.slot === slot);
    const part = participants.find((p) => p.id === side?.participant_id);
    return part?.display_name || (side?.team_id ? `Team ${slot}` : `Side ${slot}`);
  };
  const score = match.score_state || {};
  const lastSeq = Number(score.lastSeq || 0);
  const nameA = nameFor("A");
  const nameB = nameFor("B");
  const winnerName = match.winner === "A" ? nameA : match.winner === "B" ? nameB : null;
  const gamesA = score.gamesWonA ?? score.gamesA ?? (match.winner === "A" ? 1 : 0);
  const gamesB = score.gamesWonB ?? score.gamesB ?? (match.winner === "B" ? 1 : 0);
  const canStart = (match.status === "assigned" || match.status === "ready") && isCoinTossCommitted(match);
  const scoring = match.status === "in_progress";
  const readyToComplete = match.status === "in_progress" && score.status === "completed";
  const completed = match.status === "completed";
  const showToss = (match.status === "assigned" || match.status === "in_progress" || match.status === "ready") && !completed;

  return (
    <div className="ump-shell ump-desk">
      <header className="ump-top">
        <Button variant="secondary" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> {station ? "Court" : "My matches"}</Button>
        <div className="row ump-top-actions">
          <Button variant="secondary" onClick={load} disabled={busy}><RefreshCw size={15} aria-hidden="true" /> Reload</Button>
          <Button variant="ghost" onClick={onSignOut}><LogOut size={15} aria-hidden="true" /> Sign out</Button>
        </div>
      </header>

      <div className="ump-context-bar">
        <span className="ump-context-item">{match.stage_label ? stageTitle(match.stage_label) : `Round ${match.round || 1}`}</span>
        <span className="ump-context-sep" aria-hidden="true">·</span>
        <span className="ump-context-item">{court?.name || "No court"}</span>
      </div>
      <div className="ump-score">
        <div className="ump-court-label">
          {(court?.name || "NO COURT").toUpperCase()}
        </div>
        <Scoreboard
          nameA={nameA}
          nameB={nameB}
          scoreA={score.scoreA ?? 0}
          scoreB={score.scoreB ?? 0}
          center={(
            <>
              <div className="game">Game {score.gameNumber || 1}</div>
              <StatusBadge status={match.status} />
              {pending > 0 ? <div className="ump-sync"><span className="ump-sync-dot" aria-hidden="true" /> Saving…</div> : null}
            </>
          )}
        />
        {score.servingTeam && (
          <p className="ump-serve">
            <strong>{score.servingTeam === "A" ? nameA : nameB}</strong> to serve
            {(Number(score.server) === 1 || Number(score.server) === 2) && (
              <span className="ump-serve-num"> — {Number(score.server) === 1 ? "1st serve" : "2nd serve"}</span>
            )}
          </p>
        )}
      </div>

      <div className="ump-actions">
        {error && <Alert>{error}</Alert>}

        {canStart && (
          <Button disabled={busy} onClick={() => command("start_match", { match_id: match.id })}>
            Start match
          </Button>
        )}

        {showToss && (
          <CoinTossPanel
            match={match}
            nameA={nameA}
            nameB={nameB}
            busy={busy}
            lastSeq={lastSeq}
            onCommit={async (payload) => {
              if (isCoinTossCommitted(matchRef.current)) return { match: matchRef.current };
              setBusy(true);
              setError("");
              try {
                const body = await sendCommand({
                  commandUrl: cfg.commandUrl,
                  accessToken: session.access_token,
                  publishableKey: cfg.publishableKey,
                  type: "coin_toss",
                  payload,
                });
                if (body.result) applyResult(body.result);
                return body.result;
              } catch (err) {
                setError(err.message);
                await load();
                throw err;
              } finally {
                setBusy(false);
              }
            }}
          />
        )}

        {scoring && !readyToComplete && (
          <>
            <div className="pads">
              <Button className="point a" disabled={pending > 0} aria-label={`Point ${nameA}`} onClick={() => sendScore("point", { team: "A" })}>
                Point {nameA}
              </Button>
              <Button className="point b" disabled={pending > 0} aria-label={`Point ${nameB}`} onClick={() => sendScore("point", { team: "B" })}>
                Point {nameB}
              </Button>
            </div>
            <Button variant="secondary" disabled={busy || pending > 0} onClick={() => setConfirmUndo(true)}>
              Undo last point
            </Button>
          </>
        )}

        {readyToComplete && !confirmComplete && (
          <Button disabled={busy} onClick={() => setConfirmComplete(true)}>Complete match</Button>
        )}

        {completed && (
          <Card className="ump-complete">
            <div className="kicker" style={{ color: "var(--gold-accent)" }}>Match complete</div>
            <h2>Winner {winnerName}</h2>
            <p>Final score {gamesA} – {gamesB}</p>
            <p className="muted">{score.scoreA ?? 0}–{score.scoreB ?? 0} in the last game</p>
          </Card>
        )}
      </div>

      {confirmComplete && (
        <ConfirmDialog
          title="Match complete"
          body={`Winner: ${winnerName || "—"}. Final score ${gamesA} – ${gamesB}. This writes the official result.`}
          confirmLabel="Complete match"
          busy={busy}
          onCancel={() => setConfirmComplete(false)}
          onConfirm={() => {
            setConfirmComplete(false);
            command("complete_match", { match_id: match.id });
          }}
        />
      )}

      {confirmUndo && (
        <ConfirmDialog
          title="Undo last point"
          body="This removes the most recently scored point. Continue?"
          confirmLabel="Undo point"
          onCancel={() => setConfirmUndo(false)}
          onConfirm={() => {
            setConfirmUndo(false);
            sendScore("undo");
          }}
        />
      )}
    </div>
  );
}
