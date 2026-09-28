import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserClient, envConfig, sendCommand, defaultStore, isNetworkError, classifySendError, pairStation, authRedirectUrl, applyAuthCallback, isRecoveryAuthUrl, createSyncEngine, createMatchLane, createUserAuthProvider, reconstructMatchView, laneOf, ownerKey, classifyQueryFailure, applyLoadOutcome, stateFromCache, createDashboardCache, probeIdentity, rememberVerified, forgetVerified, sessionGate, startIdentity } from "@tournament/client";
import { applyOptimisticScore, mergeMatchFromResult, isCoinTossCommitted, stageScoringTarget, validateFinalScore, timerView, formatClock, MIN_GAME_TIME_SEC, MAX_GAME_TIME_SEC } from "@tournament/engine";
import { clearStation, parsePairingInput, readStation, writeStation, stationDeviceId, stationTokenExpiresSoon } from "./stationSession.js";
import { canUmpireSetGameTime, markLocalCompletion, timerDisplayMatch } from "./timerDisplay.js";
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
  GameTimer,
  Input,
  LoadingState,
  Modal,
  Scoreboard,
  SplashScreen,
  StatusBadge,
  useNow,
} from "@tournament/ui";
import { ArrowLeft, LogOut, PauseCircle, QrCode, RefreshCw } from "lucide-react";
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

// ---------------------------------------------------------------------------
// Offline scoring plumbing (see packages/client matchLane.js / syncEngine.js).
//
// Every match action the umpire can take offline is written to the durable
// outbox BEFORE it is shown or sent; one app-level sync engine replays the
// outbox (one worker per device via a cross-window lock), and each match's
// screen is rebuilt from "confirmed server state + unsynced local actions".
// ---------------------------------------------------------------------------
const OUTBOX_DB = "tournament-umpire-outbox";
const SYNC_LOCK = "tournament-umpire-outbox-sync";
const COMMAND_TIMEOUT_MS = 15000;
const DONE_STATUSES = ["completed", "bye", "cancelled", "abandoned"];
const NO_OFFLINE_STORAGE_MESSAGE = "This device can't store scores offline (browser storage is unavailable). Keep the internet connection on while scoring.";

function offlineError(message = "You're offline.") {
  return new Error(message); // no .status → isNetworkError()
}

function needsAuthError(message) {
  const err = new Error(message || "Sign in again to continue.");
  err.status = 401; // a real answer, not "offline"
  err.code = "NEEDS_AUTH";
  return err;
}

// Online-only command with auth refresh: used for loads and for the actions
// that deliberately stay online-only (start match, hold). One command_id for
// the logical request, reused on the post-refresh retry.
async function liveCommand({ cfg, getAuth, type, payload }) {
  const commandId = crypto.randomUUID();
  let auth = await getAuth({ force: false });
  if (auth?.offline) throw offlineError();
  if (!auth?.token) throw needsAuthError(auth?.message);
  const attempt = (token) => sendCommand({
    commandUrl: cfg.commandUrl,
    accessToken: token,
    publishableKey: cfg.publishableKey,
    type,
    payload,
    commandId,
    timeoutMs: COMMAND_TIMEOUT_MS,
  });
  try {
    return await attempt(auth.token);
  } catch (err) {
    if (Number(err?.status) !== 401) throw err;
    auth = await getAuth({ force: true });
    if (auth?.token) return attempt(auth.token);
    if (auth?.offline) throw offlineError();
    const out = needsAuthError(auth?.message || err.message);
    out.cause = err;
    throw out;
  }
}

function scoreSummary(st) {
  if (!st || typeof st !== "object") return null;
  return {
    scoreA: st.scoreA ?? 0,
    scoreB: st.scoreB ?? 0,
    gameNumber: st.gameNumber ?? 1,
    gamesWonA: st.gamesWonA ?? 0,
    gamesWonB: st.gamesWonB ?? 0,
    status: st.status ?? null,
    winner: st.winner ?? null,
    bestOf: st.bestOf ?? 1,
  };
}

// Applies one queued entry to a match for the LOCAL view. Throws if the entry
// can't be applied (the view then marks it blocked rather than guessing).
function applyEntryToMatch(match, entry) {
  const p = entry.payload || {};
  if (entry.type === "score_event") {
    const r = applyOptimisticScore(match, { id: p.event_id, seq: p.seq, type: p.type, payload: p.payload || {} });
    if (!r.applied && !r.duplicate) {
      throw new Error(p.type === "correction" ? "That score is not valid for this match." : "That action can't be applied to the current score.");
    }
    return markLocalCompletion(match, r.match, entry);
  }
  if (entry.type === "coin_toss") {
    let next = { ...match, coin_toss: p, serving_team: p.serving_team };
    const st = match?.score_state;
    if (st && typeof st.lastSeq === "number") {
      const r = applyOptimisticScore(match, {
        id: p.event_id,
        seq: p.seq,
        type: "coin_toss",
        payload: { result: p.result, winner: p.winner, servingTeam: p.serving_team, courtSide: p.court_side },
      });
      next = { ...next, score_state: r.state };
    }
    return next;
  }
  return match; // complete_match: the server decides; nothing to show locally
}

// Minimum context needed to reopen a match with no network: the match row,
// its two sides, the names on those sides, and the court name. Nothing else.
function matchContextRecord({ owner, match, sides, participants, court }) {
  const ids = new Set((sides || []).map((s) => s.participant_id).filter(Boolean));
  return {
    matchId: match.id,
    owner,
    match,
    sides: (sides || []).map((s) => ({ match_id: s.match_id, slot: s.slot, participant_id: s.participant_id ?? null, team_id: s.team_id ?? null })),
    participants: (participants || []).filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, display_name: p.display_name })),
    court: court ? { id: court.id, name: court.name } : null,
    savedAt: Date.now(),
    openedAt: Date.now(),
  };
}

async function ackRecord(store, owner, entry, result) {
  const matchId = entry.payload?.match_id;
  if (!matchId || !result || typeof result !== "object") return null;
  const existing = await store.getMatch(matchId);
  if (!existing || existing.owner !== owner) return null;
  const rowId = result.match?.id ?? result.match_id;
  if (rowId && rowId !== matchId) return null;
  return { matchId, owner, match: mergeMatchFromResult(existing.match, result), savedAt: Date.now() };
}

// Keeps only what offline resume needs: this owner's recent contexts, plus
// any context (any owner) that still has unsynced work behind it.
async function pruneMatchContexts(store, owner) {
  const [entries, contexts] = await Promise.all([store.list(), store.listMatches()]);
  const withWork = new Set(entries.filter((e) => e.status !== "discarded").map(laneOf));
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  const mine = contexts
    .filter((c) => c.owner === owner)
    .sort((a, b) => (b.openedAt || b.savedAt || 0) - (a.openedAt || a.savedAt || 0));
  for (const [i, c] of mine.entries()) {
    if (withWork.has(c.matchId)) continue;
    if (i >= 20 || (DONE_STATUSES.includes(c.match?.status) && (c.savedAt || 0) < cutoff)) await store.deleteMatch(c.matchId);
  }
  for (const c of contexts) {
    if (c.owner !== owner && !withWork.has(c.matchId)) await store.deleteMatch(c.matchId);
  }
}

function useUmpireSync({ cfg, supabase, store, owner, setStation }) {
  const [engine, setEngine] = useState(null);
  const [status, setStatus] = useState(null);
  const setStationRef = useRef(setStation);
  setStationRef.current = setStation;

  const getAuth = useCallback(async ({ force = false } = {}) => {
    if (!owner) return { needsAuth: true, message: "Sign in to sync saved scores." };
    if (owner.startsWith("station:")) {
      const st = readStation();
      if (!st?.access_token || ownerKey("station", stationDeviceId(st)) !== owner) {
        return { needsAuth: true, message: "This court is no longer paired on this device. Scores saved here are kept but can't be sent from a different pairing." };
      }
      if (!force && !stationTokenExpiresSoon(st.access_token)) return { token: st.access_token };
      if (!st.refresh_token) return { needsAuth: true, message: "This court station must be paired again to sync. Scores saved on this device are kept." };
      try {
        const body = await pairStation({
          pairStationUrl: cfg.pairStationUrl,
          publishableKey: cfg.publishableKey,
          refreshToken: st.refresh_token,
          action: "refresh",
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
        // The court may have been unpaired (or re-paired) while the refresh
        // was in flight: never write a token back over that.
        const current = readStation();
        if (!current || stationDeviceId(current) !== stationDeviceId(st)) {
          return { needsAuth: true, message: "This court is no longer paired on this device. Scores saved here are kept but can't be sent from a different pairing." };
        }
        const next = { ...current, ...body.result };
        writeStation(next);
        setStationRef.current?.(next);
        return { token: next.access_token };
      } catch (err) {
        const kind = classifySendError(err);
        if (kind === "network" || kind === "retry") {
          // Refresh endpoint unreachable: a token that hasn't actually expired
          // yet is still usable; otherwise we're effectively offline.
          return !force && !stationTokenExpiresSoon(st.access_token, 0) ? { token: st.access_token } : { offline: true };
        }
        return { needsAuth: true, message: "This court station was revoked. Scores saved on this device are kept — ask the organizer to re-pair this court." };
      }
    }
    return createUserAuthProvider(supabase, owner.slice("user:".length), {
      expiredMessage: "Your sign-in has expired. Sign in again (internet required) to sync the scores saved on this device — they are kept until then.",
      otherUserMessage: "A different account is signed in. Scores saved by the previous account are kept and are not sent from this account.",
    })({ force });
  }, [owner, supabase, cfg]);

  useEffect(() => {
    if (!owner) {
      setEngine(null);
      setStatus(null);
      return undefined;
    }
    const next = createSyncEngine({
      store,
      lockName: SYNC_LOCK,
      owner,
      getAuth,
      timeoutMs: COMMAND_TIMEOUT_MS,
      onAck: (entry, result) => ackRecord(store, owner, entry, result),
    });
    setEngine(next);
    const unsubscribe = next.subscribe((s) => setStatus({ ...s }));
    next.pruneArchived().catch(() => {});
    pruneMatchContexts(store, owner).catch(() => {});
    next.kick();
    const onOnline = () => next.kick({ resetBackoff: true });
    const onVisible = () => { if (document.visibilityState === "visible") next.kick(); };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      next.stop();
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store, owner, getAuth]);

  return { engine, status, getAuth, store, owner };
}

function unsyncedCount(status) {
  return (status?.pending || 0) + (status?.conflicts || 0);
}

export default function App() {
  const cfg = useMemo(() => envConfig(), []);
  const supabase = useMemo(() => createBrowserClient(cfg.url, cfg.publishableKey), [cfg]);
  const store = useMemo(() => defaultStore(OUTBOX_DB), []);
  const [session, setSession] = useState(undefined);
  // Offline identity (packages/client offlineIdentity.js, same rules as the
  // Operator): a signed-in umpire whose token expired while the server is
  // unreachable keeps access to THEIR OWN saved matches and pending scores.
  // No token is created; nothing is sent until a real refresh succeeds.
  const [offlineIdentity, setOfflineIdentity] = useState(null);
  const [station, setStation] = useState(() => (typeof window === "undefined" ? null : readStation()));
  const [error, setError] = useState("");
  const [matchId, setMatchId] = useState(null);
  const [recovering, setRecovering] = useState(() => isRecoveryAuthUrl());
  const [leaveRequest, setLeaveRequest] = useState(null);

  useEffect(() => {
    applyAuthCallback(supabase);
    if (isRecoveryAuthUrl()) setRecovering(true);
    let cancelled = false;
    // startIdentity reports the saved offline identity after a short grace
    // period instead of waiting ~25 s for supabase-js to give up retrying.
    let liveSession = false;
    const stopIdentity = startIdentity(supabase, ({ session: s, offlineIdentity: id, settled }) => {
      if (cancelled || (!settled && liveSession)) return;
      setSession(s ?? null);
      setOfflineIdentity(id ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      // INITIAL_SESSION (null) fires before the probe above finishes; only a
      // real session or an explicit sign-out may change identity from here.
      if (next) {
        liveSession = true;
        setSession(next);
        setOfflineIdentity(null);
      } else if (event === "SIGNED_OUT") {
        setSession(null);
        setOfflineIdentity(null);
      }
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
      if (event === "SIGNED_OUT") setRecovering(false);
    });
    return () => {
      cancelled = true;
      stopIdentity();
      sub.subscription.unsubscribe();
    };
  }, [supabase]);

  // Every server-verified session refreshes this device's offline window.
  useEffect(() => {
    if (session?.user?.id) rememberVerified(session.user.id);
  }, [session]);

  // While offline-unverified, keep trying to verify: on reconnect and every
  // 30 s. A server refusal ends offline mode (sign-in screen).
  useEffect(() => {
    if (!offlineIdentity || session) return undefined;
    let stopped = false;
    async function recheck() {
      const probed = await probeIdentity(supabase);
      if (stopped) return;
      if (probed.mode === "verified") {
        setSession(probed.session);
        setOfflineIdentity(null);
      } else if (probed.mode === "signed-out") {
        setOfflineIdentity(null);
      }
    }
    const timer = setInterval(recheck, 30000);
    window.addEventListener("online", recheck);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener("online", recheck);
    };
  }, [offlineIdentity, session, supabase]);

  // Who the match list is for: a verified session, or (offline only) a
  // display-only account for the offline identity — never a token.
  const account = useMemo(() => {
    if (session?.user) return session;
    if (offlineIdentity?.userId) return { user: { id: offlineIdentity.userId, email: offlineIdentity.email }, offline: true };
    return null;
  }, [session, offlineIdentity]);

  const owner = station?.access_token
    ? ownerKey("station", stationDeviceId(station))
    : account?.user?.id ? ownerKey("user", account.user.id) : null;
  const sync = useUmpireSync({ cfg, supabase, store, owner, setStation });

  // Offline identity → verified again (same owner): send pending work now
  // instead of waiting out the retry backoff.
  const verifiedUserId = session?.user?.id ?? null;
  useEffect(() => {
    if (verifiedUserId) sync.engine?.kick({ resetBackoff: true });
  }, [verifiedUserId, sync.engine]);

  // Signing out / unpairing never deletes saved work: queued actions stay on
  // this device, tied to the identity that recorded them, and are never sent
  // by a different account or pairing.
  function guardedLeave(kind, run) {
    return () => {
      if (unsyncedCount(sync.status) > 0) setLeaveRequest({ kind, run, count: unsyncedCount(sync.status) });
      else run();
    };
  }
  const unpair = () => { clearStation(); setStation(null); setMatchId(null); };
  // Offline, supabase-js can't always clear its stored session; forgetting the
  // verification stamp guarantees an explicit sign-out is never resumed as an
  // offline identity.
  const signOut = () => {
    const uid = account?.user?.id;
    if (uid) forgetVerified(uid);
    setOfflineIdentity(null);
    setMatchId(null);
    supabase.auth.signOut({ scope: "local" });
  };

  const leaveDialog = leaveRequest ? (
    <ConfirmDialog
      title={leaveRequest.kind === "station" ? "Unpair with unsynced scores?" : "Sign out with unsynced scores?"}
      body={leaveRequest.kind === "station"
        ? `${leaveRequest.count} saved action${leaveRequest.count === 1 ? " has" : "s have"} not reached the server yet. They stay saved on this device, but after unpairing they can no longer be sent as this court. Stay paired until they show SYNCED if you can.`
        : `${leaveRequest.count} saved action${leaveRequest.count === 1 ? " has" : "s have"} not reached the server yet. They stay saved on this device and are sent only when this same account signs in here again. No other account can send them.`}
      confirmLabel={leaveRequest.kind === "station" ? "Unpair anyway (keep saved scores)" : "Sign out (keep saved scores)"}
      danger
      onCancel={() => setLeaveRequest(null)}
      onConfirm={() => { const run = leaveRequest.run; setLeaveRequest(null); run(); }}
    />
  ) : null;

  if (session === undefined) {
    return <SplashScreen tagline="Umpire" status="Restoring your session…" />;
  }
  if (station?.access_token) {
    return (
      <>
        {matchId ? (
          <MatchDesk
            cfg={cfg}
            supabase={supabase}
            station={station}
            matchId={matchId}
            sync={sync}
            onBack={() => setMatchId(null)}
            onSignOut={guardedLeave("station", unpair)}
          />
        ) : (
          <CourtQueue
            cfg={cfg}
            station={station}
            setStation={setStation}
            sync={sync}
            onOpen={setMatchId}
            onUnpair={guardedLeave("station", unpair)}
          />
        )}
        {leaveDialog}
      </>
    );
  }
  if (!account) return <Auth cfg={cfg} supabase={supabase} store={store} error={error} setError={setError} onPaired={setStation} />;
  if (recovering && session) {
    return (
      <RecoveryScreen
        supabase={supabase}
        onDone={() => setRecovering(false)}
        onSignOut={() => supabase.auth.signOut({ scope: "local" })}
      />
    );
  }

  return (
    <>
      {matchId ? (
        <MatchDesk
          cfg={cfg}
          supabase={supabase}
          matchId={matchId}
          sync={sync}
          onBack={() => setMatchId(null)}
          onSignOut={guardedLeave("user", signOut)}
        />
      ) : (
        <MyMatches
          supabase={supabase}
          session={account}
          sync={sync}
          onOpen={setMatchId}
          onSignOut={guardedLeave("user", signOut)}
        />
      )}
      {leaveDialog}
    </>
  );
}

// Status + actions for the device's outbox, shown on the match lists.
function SyncNotices({ sync, who }) {
  const [confirmClaim, setConfirmClaim] = useState(false);
  const s = sync?.status;
  if (!s) return null;
  return (
    <>
      {s.durable === false && (
        <Alert>{NO_OFFLINE_STORAGE_MESSAGE}</Alert>
      )}
      {s.needsAuth && unsyncedCount(s) > 0 && <Alert tone="warn">{s.needsAuth}</Alert>}
      {s.pending > 0 && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="ump-sync ump-sync-offline">
            <span className="ump-sync-dot" aria-hidden="true" /> {s.pending} action{s.pending === 1 ? "" : "s"} saved on this device — {s.syncing ? "syncing…" : s.offline ? "offline, will sync when connected" : "not yet synced"}
          </span>
          <Button variant="secondary" onClick={() => sync.engine?.kick({ resetBackoff: true })}>Sync now</Button>
        </div>
      )}
      {s.conflicts > 0 && (
        <Alert>{s.conflicts} saved action{s.conflicts === 1 ? " needs" : "s need"} attention — open the match marked "Needs attention" below.</Alert>
      )}
      {s.unclaimed > 0 && (
        <Alert tone="warn">
          {s.unclaimed} action{s.unclaimed === 1 ? " was" : "s were"} saved on this device by an earlier version of this app. They are only sent after you confirm they are yours.
          <div className="row" style={{ marginTop: 8 }}>
            <Button variant="secondary" onClick={() => setConfirmClaim(true)}>Review and send</Button>
          </div>
        </Alert>
      )}
      {s.otherOwner > 0 && (
        <p className="muted" style={{ color: "var(--muted-court)" }}>
          {s.otherOwner} saved action{s.otherOwner === 1 ? " belongs" : "s belong"} to another account or court pairing on this device and will not be sent from here.
        </p>
      )}
      {confirmClaim && (
        <ConfirmDialog
          title="Send earlier saved actions?"
          body={`${s.unclaimed} saved action${s.unclaimed === 1 ? "" : "s"} will be sent as ${who}. Only confirm if they were recorded by you on this device.`}
          confirmLabel="Send as me"
          onCancel={() => setConfirmClaim(false)}
          onConfirm={async () => { setConfirmClaim(false); await sync.engine?.claimUnowned(); }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Match lists (MyMatches / CourtQueue): "last known good" data.
// A failed load never replaces rows the server already returned — only a
// successful response (even an empty one) changes them. The last good list
// is also kept per owner in localStorage so a restart can show it offline.
// ---------------------------------------------------------------------------
const LIVE_OR_READY = ["in_progress", "assigned", "ready"];

function listCacheKey(owner) {
  return owner ? `tournament.umpire.dashboard.${owner}` : null;
}

// Only what the list renders (MatchGroup / participantNameFor).
function trimListRow(m, courtName) {
  return {
    id: m.id,
    status: m.status,
    stage_label: m.stage_label ?? null,
    round: m.round ?? null,
    bracket_side: m.bracket_side ?? null,
    courtName: courtName ?? null,
    score_state: m.score_state && typeof m.score_state === "object"
      ? { scoreA: m.score_state.scoreA ?? null, scoreB: m.score_state.scoreB ?? null }
      : null,
  };
}

function trimListMeta(sides, participants) {
  const ids = new Set((sides || []).map((s) => s.participant_id).filter(Boolean));
  return {
    sides: (sides || []).map((s) => ({ match_id: s.match_id, slot: s.slot, participant_id: s.participant_id ?? null, team_id: s.team_id ?? null })),
    participants: (participants || []).filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, display_name: p.display_name })),
  };
}

// Makes live/ready matches from a successful list load openable offline even
// if this device never opened them. Confirmed context only (the store never
// moves a confirmed score backwards); the command queue is not touched, and
// `openedAt` is left alone so pruning still favours matches actually opened.
async function seedMatchContexts(store, owner, matches, sides, participants, courtFor) {
  if (!store || !owner) return;
  for (const m of matches || []) {
    if (!LIVE_OR_READY.includes(m.status)) continue;
    const existing = await store.getMatch(m.id);
    if (existing && existing.owner !== owner) continue; // another account's context on this device
    const record = matchContextRecord({
      owner,
      match: m,
      sides: (sides || []).filter((s) => s.match_id === m.id),
      participants,
      court: courtFor(m.id),
    });
    delete record.openedAt;
    await store.putMatch(record);
  }
}

// Non-destructive status for a list. Network trouble says "offline —
// showing saved data"; auth/permission/app errors say what they are.
function ListStatusBanner({ state, onRetry, noun }) {
  const { status, error, lastUpdatedAt, rows } = state;
  const hasData = Array.isArray(rows);
  const when = lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleTimeString() : null;
  const saved = hasData ? ` Showing saved data${when ? ` (last updated ${when})` : ""}.` : "";
  let tone = "warn";
  let text = null;
  if (status === "offline") {
    text = hasData
      ? `Offline — showing saved data${when ? ` (last updated ${when})` : ""}. Matches saved on this device can still be opened and scored; everything syncs when you're back online.`
      : `Offline — ${noun} can't be loaded right now. Matches saved on this device are listed below.`;
  } else if (status === "server") {
    text = `The server isn't responding right now (${error}).${saved} It will refresh automatically.`;
  } else if (status === "auth") {
    tone = "error";
    text = `Your sign-in needs to be renewed (${error}).${hasData ? " The list below may be out of date." : ""}`;
  } else if (status === "forbidden") {
    tone = "error";
    text = `The server refused access (${error}).${hasData ? " The list below may be out of date." : ""}`;
  } else if (status === "error") {
    tone = "error";
    text = `Couldn't load ${noun} (${error}).${hasData ? " The list below may be out of date." : ""}`;
  }
  if (!text) return null;
  return (
    <>
      <Alert tone={tone}>{text}</Alert>
      <Button onClick={onRetry}>Retry</Button>
    </>
  );
}

// Matches this device can reopen with no network (confirmed context on disk).
function SavedMatches({ sync, onOpen, showAll }) {
  const [rows, setRows] = useState([]);
  const { store, owner, status } = sync || {};
  useEffect(() => {
    if (!store || !owner) return undefined;
    let alive = true;
    store.listMatches()
      .then((all) => {
        if (!alive) return;
        setRows(all
          .filter((r) => r.owner === owner)
          .sort((a, b) => (b.openedAt || b.savedAt || 0) - (a.openedAt || a.savedAt || 0)));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [store, owner, status]);
  const byLane = status?.byLane || {};
  const visible = rows.filter((r) => showAll || ((byLane[r.matchId]?.pending || 0) + (byLane[r.matchId]?.conflicts || 0)) > 0);
  if (!visible.length) return null;
  return (
    <section>
      <div className="section-label">Saved on this device</div>
      {visible.map((r) => {
        const lane = byLane[r.matchId] || {};
        const st = r.match?.score_state || {};
        const nameFor = (slot) => participantNameFor(r.sides || [], r.participants || [], r.matchId, slot);
        return (
          <ClickableCard key={r.matchId} className="ump-card" live={r.match?.status === "in_progress"} onClick={() => onOpen(r.matchId)}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{r.court?.name || "No court"}</strong>
              {lane.conflicts > 0 ? <Badge tone="warn">Needs attention</Badge> : lane.pending > 0 ? <Badge tone="warn">{lane.pending} not synced</Badge> : <StatusBadge status={r.match?.status} />}
            </div>
            <div className="ump-name">{nameFor("A")} vs {nameFor("B")}</div>
            <div className="muted" style={{ color: "var(--muted-court)" }}>
              Server score {st.scoreA ?? 0}–{st.scoreB ?? 0}
              {r.savedAt ? ` · saved ${new Date(r.savedAt).toLocaleTimeString()}` : ""}
            </div>
          </ClickableCard>
        );
      })}
    </section>
  );
}

function Auth({ cfg, supabase, store, error, setError, onPaired }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("pair");
  const [info, setInfo] = useState("");
  const [pairText, setPairText] = useState("");
  const [scanning, setScanning] = useState(false);
  const [savedCount, setSavedCount] = useState(0);

  // Signing in needs the internet (there is deliberately no offline login).
  // If scores were saved on this device before the session ended, say so —
  // they are kept and sync once the same account/court is signed in again.
  useEffect(() => {
    let alive = true;
    store?.list()
      .then((rows) => { if (alive) setSavedCount(rows.filter((r) => r.status !== "discarded").length); })
      .catch(() => {});
    return () => { alive = false; };
  }, [store]);

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
        {savedCount > 0 && (
          <Alert tone="warn">
            {savedCount} scoring action{savedCount === 1 ? " is" : "s are"} saved on this device and not yet synced. Signing in needs an internet connection; they are sent automatically once the same umpire account signs in again. (Actions saved under an earlier court pairing can't be sent by a new pairing — they stay on this device.)
          </Alert>
        )}
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
  const done = rows.filter((m) => DONE_STATUSES.includes(m.status));
  const other = rows.filter((m) => ![...live, ...ready, ...upcoming, ...done].some((x) => x.id === m.id));
  return { live, ready, upcoming, done, other };
}

function MyMatches({ supabase, session, sync, onOpen, onSignOut }) {
  const owner = ownerKey("user", session.user.id);
  const cache = useMemo(() => createDashboardCache(listCacheKey(owner)), [owner]);
  // Starts from the last good list saved on this device (instant, works
  // offline), then refreshes from the server.
  const [list, setList] = useState(() => stateFromCache(cache.read()));
  const [query, setQuery] = useState("");
  const [showAllDone, setShowAllDone] = useState(false);
  const rows = list.rows;
  const meta = list.meta || { sides: [], participants: [] };
  const store = sync?.store;

  const load = useCallback(async () => {
    // A failed query only records WHY it failed; rows already on screen stay.
    const fail = (res) => {
      setList((prev) => applyLoadOutcome(prev, { ok: false, kind: classifyQueryFailure(res), message: res.error?.message || res.message }));
    };
    // Without a real session supabase-js queries anonymously and RLS returns
    // no assignments — which would wipe the saved list. Keep it instead.
    const gate = await sessionGate(supabase);
    if (gate) {
      setList((prev) => applyLoadOutcome(prev, gate));
      return;
    }
    const assigned = await supabase
      .from("umpire_assignments")
      .select("*")
      .eq("user_id", session.user.id);
    if (assigned.error) return fail(assigned);
    const ids = (assigned.data || []).map((a) => a.match_id);
    if (!ids.length) {
      // The server positively answered "no assignments" — a real empty list.
      const snapshot = { rows: [], meta: { sides: [], participants: [] } };
      cache.write(snapshot);
      setList((prev) => applyLoadOutcome(prev, { ok: true, ...snapshot }));
      return;
    }
    const [matches, courtsA, sides] = await Promise.all([
      supabase.from("matches").select("*").in("id", ids),
      supabase.from("court_assignments").select("*").in("match_id", ids),
      supabase.from("match_participants").select("*").in("match_id", ids),
    ]);
    const firstFailure = [matches, courtsA, sides].find((x) => x.error);
    if (firstFailure) return fail(firstFailure);
    // Only the courts and players these matches use. Unfiltered, the
    // 1000-row response cap dropped names once an account had enough data —
    // and that incomplete list was then saved for offline use.
    const courtIds = [...new Set((courtsA.data || []).map((a) => a.court_id).filter(Boolean))];
    const participantIds = [...new Set((sides.data || []).map((x) => x.participant_id).filter(Boolean))];
    const none = { data: [], error: null };
    const [courts, participants] = await Promise.all([
      courtIds.length ? supabase.from("courts").select("*").in("id", courtIds) : none,
      participantIds.length ? supabase.from("participants").select("*").in("id", participantIds) : none,
    ]);
    const detailFailure = [courts, participants].find((x) => x.error);
    if (detailFailure) return fail(detailFailure);
    const courtByMatch = Object.fromEntries((courtsA.data || []).map((a) => [a.match_id, a.court_id]));
    const courtById = Object.fromEntries((courts.data || []).map((c) => [c.id, c]));
    const courtFor = (matchId) => courtById[courtByMatch[matchId]] || null;
    const snapshot = {
      rows: (matches.data || []).map((m) => trimListRow(m, courtFor(m.id)?.name)),
      meta: trimListMeta(sides.data, participants.data),
    };
    cache.write(snapshot);
    setList((prev) => applyLoadOutcome(prev, { ok: true, ...snapshot }));
    seedMatchContexts(store, owner, matches.data, sides.data, participants.data, courtFor).catch(() => {});
  }, [supabase, session.user.id, cache, store, owner]);

  // Also reloads when an offline identity becomes a verified sign-in.
  useEffect(() => { load(); }, [load, session.offline]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") load();
    }
    // Reload when the device says it's back online. `navigator.onLine` is
    // never trusted as proof of connectivity — only the request result is.
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
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
        <SyncNotices sync={sync} who={session.user.email} />
        <ListStatusBanner state={list} onRetry={load} noun="your assigned matches" />
        <SavedMatches sync={sync} onOpen={onOpen} showAll={list.status !== "online" && list.status !== "loading"} />
        {rows === null && list.status === "loading" && <LoadingState label="Loading assignments" />}
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

// The recommended default shown in the "Match scoring" confirmation dialog
// before a match starts — the operator/umpire can still change it. Only a
// stage-based recommendation; the server independently validates whatever
// target is actually submitted (see ALLOWED_MATCH_SCORING_TARGETS in
// packages/api/src/handleCommand.js).
// The race-to target is decided by stage and enforced by the server (see
// packages/api matchScoringSettings). Once started, score_state.winTo is
// authoritative. Before start this device only sees the one match, so the
// target is shown only when the stage is known from the match itself;
// otherwise (e.g. an unlabeled single-elimination round) the server decides.
// Game timer on the scoreboard. Its own component so only it re-renders on
// each tick — the scoring controls never do. Remaining time is recomputed
// from the match's persisted timer on every render (timerView), so reopening,
// rerendering or reloading the match never restarts or drifts it, and it
// keeps counting offline from the saved match. `onExpire` fires once when a
// running countdown reaches 00:00 (the match itself is left untouched).
// A game won on this device but not yet synced freezes at that winning point
// (timerDisplay.js); the server's completed match replaces it after sync.
function MatchGameTimer({ match, onExpire }) {
  const shown = timerDisplayMatch(match);
  const running = timerView(shown, Date.now()).state === "running";
  const now = useNow(running);
  const view = timerView(shown, now);
  const prevState = useRef(view.state);
  useEffect(() => {
    if (prevState.current === "running" && view.state === "expired") onExpire?.();
    prevState.current = view.state;
  }, [view.state, onExpire]);
  return <GameTimer view={view} clock={formatClock(view.remainingMs)} />;
}

// Game-time setup for the assigned umpire, before the match has ever started.
// Online only (set_match_timer is authorized and validated on the server);
// setting a time never starts the countdown — start_match does.
function GameTimeModal({ match, busy, onClose, onSend }) {
  const configured = timerView(match, Date.now());
  const hasTimer = configured.state === "configured";
  const [minutes, setMinutes] = useState(hasTimer ? String(Math.round(configured.durationSec / 60)) : "10");
  const [error, setError] = useState("");
  const minMin = MIN_GAME_TIME_SEC / 60;
  const maxMin = MAX_GAME_TIME_SEC / 60;

  async function submit(payload) {
    setError("");
    if (await onSend(payload)) onClose();
  }

  function submitSet() {
    const n = Number(minutes);
    if (!/^\d+$/.test(minutes.trim()) || !Number.isInteger(n) || n < minMin || n > maxMin) {
      setError(`Enter whole minutes from ${minMin} to ${maxMin}.`);
      return;
    }
    submit({ action: "set", duration_seconds: n * 60 });
  }

  return (
    <Modal title="Game time" onClose={() => !busy && onClose()}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          {hasTimer ? `Currently ${Math.round(configured.durationSec / 60)} minutes.` : "No game time is set for this match."}
        </p>
        <Input
          label="Game time (minutes)"
          inputMode="numeric"
          value={minutes}
          onChange={(e) => setMinutes(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
          hint="The countdown starts when the match is started, not now."
          disabled={busy}
        />
        {error && <Alert>{error}</Alert>}
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          {hasTimer && (
            <Button variant="secondary" disabled={busy} onClick={() => submit({ action: "clear" })}>Remove</Button>
          )}
          <Button disabled={busy} onClick={submitSet}>{busy ? "Saving…" : "Set game time"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function knownScoringTarget(match) {
  const started = Number(match?.score_state?.winTo);
  if (Number.isInteger(started) && started > 0) return started;
  if (match?.stage_label) return stageScoringTarget(match.stage_label);
  if (match?.bracket_side === "bronze" || match?.bracket_side === "final") return stageScoringTarget(match.bracket_side);
  return null;
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

function CourtQueue({ cfg, station, setStation, sync, onOpen, onUnpair }) {
  const owner = sync?.owner;
  const store = sync?.store;
  const cache = useMemo(() => createDashboardCache(listCacheKey(owner)), [owner]);
  // Last good court list from this device (instant, works offline) — only a
  // successful station_sync replaces it.
  const [list, setList] = useState(() => stateFromCache(cache.read()));
  const [revoked, setRevoked] = useState("");
  const [court, setCourt] = useState(station.court || null);
  const stationRef = useRef(station);
  stationRef.current = station;
  const getAuth = sync.getAuth;
  const rows = list.rows;
  const meta = list.meta || { sides: [], participants: [] };

  const load = useCallback(async () => {
    try {
      // liveCommand refreshes the station token itself (via the shared
      // getAuth) when it is near expiry or the server answers 401.
      const body = await liveCommand({ cfg, getAuth, type: "station_sync", payload: {} });
      const result = body.result;
      setCourt(result.court);
      const courtFor = () => result.court || null;
      const snapshot = {
        rows: (result.matches || []).map((m) => trimListRow(m, result.court?.name)),
        meta: trimListMeta(result.sides, result.participants),
      };
      cache.write(snapshot);
      setList((prev) => applyLoadOutcome(prev, { ok: true, ...snapshot }));
      setRevoked("");
      seedMatchContexts(store, owner, result.matches, result.sides, result.participants, courtFor).catch(() => {});
      if (result.court) {
        const next = { ...readStation(), court: result.court };
        writeStation(next);
        const prev = stationRef.current.court;
        if (prev?.id !== result.court.id || prev?.name !== result.court.name) {
          setStation(next);
        } else {
          stationRef.current = next;
        }
      }
    } catch (err) {
      if (isStationInactiveError(err)) {
        // A real answer, not an outage: this pairing is no longer valid.
        setRevoked("This court station was revoked. Pair again with a new QR.");
        return;
      }
      // Network / server / other failures keep the list already on screen.
      setList((prev) => applyLoadOutcome(prev, { ok: false, kind: classifyQueryFailure(err), message: err.message }));
    }
  }, [cfg, getAuth, setStation, cache, store, owner]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") load();
    }
    window.addEventListener("focus", load);
    window.addEventListener("online", load);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("focus", load);
      window.removeEventListener("online", load);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  const nameFor = (id, slot) => participantNameFor(meta.sides, meta.participants, id, slot);
  // A revoked pairing can't open these matches any more — don't list them.
  const grouped = rows && !revoked ? groupMatches(rows) : null;

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
        <SyncNotices sync={sync} who={`this court (${court?.name || "paired device"})`} />
        {revoked ? (
          <>
            <Alert>{revoked}</Alert>
            <Button onClick={onUnpair}>Pair again</Button>
          </>
        ) : (
          <ListStatusBanner state={list} onRetry={load} noun="this court's matches" />
        )}
        <SavedMatches sync={sync} onOpen={onOpen} showAll={Boolean(revoked) || (list.status !== "online" && list.status !== "loading")} />
        {rows === null && list.status === "loading" && !revoked && <LoadingState label="Loading court" />}
        {!revoked && rows?.length === 0 && <EmptyState title="No matches on this court">When an organizer assigns a match here, it appears without a new QR scan.</EmptyState>}
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

// Edit Score / Instant Score Entry — sends a "correction" score_event through
// the same command/engine/audit pipeline as normal point-scoring (see
// packages/engine/src/scoring.js applyScoreEvent's "correction" case and
// packages/api/src/handleCommand.js handleScoreEvent). Like every other match
// action it is saved on this device first and synced by the outbox; a
// correction the server refuses shows up as a sync conflict, never silently.
// `initialScoreA/B` prefill the form (used to re-apply this device's score
// after a sync conflict).
function EditScoreModal({ match, nameA, nameB, sendCorrection, onClose, initialScoreA, initialScoreB, title = "Edit score" }) {
  const state = match.score_state || {};
  const wasCompleted = match.status === "completed";
  const [scoreA, setScoreA] = useState(String(initialScoreA ?? state.scoreA ?? 0));
  const [scoreB, setScoreB] = useState(String(initialScoreB ?? state.scoreB ?? 0));
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
  const reasonOk = !wasCompleted || reason.trim().length > 0;
  // Same rule the engine enforces: race to winTo, no deuce (11–10 / 15–14 end the match).
  const winTo = Number(state.winTo) || null;
  const check = validNumbers && winTo ? validateFinalScore(nextA, nextB, winTo) : null;
  const scoreError = check && !check.ok ? check.reason : "";
  const canContinue = validNumbers && !unchanged && reasonOk && !scoreError && !busy;

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await sendCorrection({
        scoreA: nextA,
        scoreB: nextB,
        reason: reason.trim() || undefined,
        ...(wasCompleted ? { confirm_completed: true } : {}),
      });
      onClose();
    } catch (err) {
      setError(err.message || "Could not save the correction");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <div className="stack">
        {wasCompleted && (
          <Alert>
            This match is already completed. This correction updates the recorded score only — it cannot change the winner. Standings and bracket progression are not affected.
          </Alert>
        )}
        <p className="muted" style={{ margin: 0 }}>Game {state.gameNumber || 1} · {nameA} vs {nameB}{winTo ? ` · Race to ${winTo}` : ""}</p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div className="stack" style={{ gap: 4 }}>
            <Input label={nameA} inputMode="numeric" value={scoreA} onChange={(e) => setScoreA(digitsOnly(e.target.value))} />
            <div className="row" style={{ gap: 6 }}>
              <Button type="button" variant="secondary" onClick={() => step(setScoreA, scoreA, -1)} disabled={busy}>−1</Button>
              <Button type="button" variant="secondary" onClick={() => step(setScoreA, scoreA, 1)} disabled={busy}>+1</Button>
            </div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <Input label={nameB} inputMode="numeric" value={scoreB} onChange={(e) => setScoreB(digitsOnly(e.target.value))} />
            <div className="row" style={{ gap: 6 }}>
              <Button type="button" variant="secondary" onClick={() => step(setScoreB, scoreB, -1)} disabled={busy}>−1</Button>
              <Button type="button" variant="secondary" onClick={() => step(setScoreB, scoreB, 1)} disabled={busy}>+1</Button>
            </div>
          </div>
        </div>
        <Input
          label={wasCompleted ? "Reason (required)" : "Reason (optional)"}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this score being corrected?"
        />
        {scoreError && <Alert>{scoreError}</Alert>}
        {check?.ok && check.complete && !unchanged && !wasCompleted && (
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
            <p style={{ margin: 0 }}>
              Change score from {state.scoreA ?? 0}–{state.scoreB ?? 0} to {nextA}–{nextB}?
              {wasCompleted ? " This match is completed — the correction will be audited." : ""}
            </p>
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

function MatchDesk({ cfg, supabase, station, matchId, sync, onBack, onSignOut }) {
  const { store, owner, engine, status: syncStatus, getAuth } = sync;
  // `base` = this match's last CONFIRMED (server-acknowledged) context, kept
  // on disk; `entries` = this device's durable, not-yet-acknowledged actions
  // for the match. What's on screen is always derived from the two.
  const [base, setBase] = useState(null);
  const [entries, setEntries] = useState([]);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [laneBusy, setLaneBusy] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [showEditScore, setShowEditScore] = useState(false);
  const [showScoringConfirm, setShowScoringConfirm] = useState(false);
  const [showGameTime, setShowGameTime] = useState(false);
  const [showHold, setShowHold] = useState(false);
  const [holdReason, setHoldReason] = useState("");
  const [holding, setHolding] = useState(false);
  const [confirmKeepServer, setConfirmKeepServer] = useState(false);
  const [reapplyLocal, setReapplyLocal] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [justSynced, setJustSynced] = useState(false);
  const baseRef = useRef(null);
  baseRef.current = base;

  // The single seq allocator + write-ahead path for this match. Every
  // offline-capable action below goes through lane.enqueue — there is no
  // other way to mint a seq for this match.
  const lane = useMemo(
    () => createMatchLane({ store, matchId, owner, commandUrl: cfg.commandUrl, publishableKey: cfg.publishableKey }),
    [store, matchId, owner, cfg.commandUrl, cfg.publishableKey],
  );

  // Overlapping re-reads (every sync status change triggers one): only the
  // latest may apply, or an older read could briefly un-show a point.
  const refreshSeq = useRef(0);
  const refreshLocal = useCallback(async () => {
    const seq = ++refreshSeq.current;
    const [rec, all] = await Promise.all([store.getMatch(matchId), store.list()]);
    if (seq !== refreshSeq.current) return;
    setBase(rec && rec.owner === owner ? rec : null);
    setEntries(all.filter((e) => e.owner === owner && e.payload?.match_id === matchId));
    setHydrated(true);
  }, [store, matchId, owner]);

  const view = useMemo(() => {
    if (!base?.match) return null;
    return reconstructMatchView({ baseMatch: base.match, entries, applyEntry: applyEntryToMatch });
  }, [base, entries]);
  const match = view?.match ?? null;
  const sides = base?.sides || [];
  const participants = base?.participants || [];
  const court = base?.court || null;

  // Keep the allocator at or above everything known for this match (confirmed
  // lastSeq and every seq already in the queue) — it never goes backwards.
  useEffect(() => {
    if (view) lane.observeSeq(view.localLastSeq);
  }, [view, lane]);

  // Re-read the durable state whenever the sync engine reports progress
  // (an ack moves an entry out of the queue and into the confirmed base).
  useEffect(() => {
    refreshLocal().catch(() => {});
  }, [refreshLocal, syncStatus]);

  const unsyncedHere = view ? view.unsynced : 0;
  const prevUnsynced = useRef(0);
  useEffect(() => {
    if (prevUnsynced.current > 0 && unsyncedHere === 0 && hydrated) {
      setJustSynced(true);
      const t = window.setTimeout(() => setJustSynced(false), 2500);
      prevUnsynced.current = unsyncedHere;
      return () => window.clearTimeout(t);
    }
    prevUnsynced.current = unsyncedHere;
    return undefined;
  }, [unsyncedHere, hydrated]);

  const load = useCallback(async () => {
    try {
      let record;
      if (station) {
        const body = await liveCommand({ cfg, getAuth, type: "station_sync", payload: {} });
        const result = body.result;
        const m = (result.matches || []).find((row) => row.id === matchId);
        if (!m) {
          if (baseRef.current) setError("This match is no longer assigned to this court. Scores already saved on this device are kept.");
          else setLoadError("This match is not on this court.");
          return;
        }
        record = matchContextRecord({
          owner,
          match: m,
          sides: (result.sides || []).filter((row) => row.match_id === matchId),
          participants: result.participants || [],
          court: result.court || null,
        });
      } else {
        // Without a real session (offline identity, or an expired token that
        // couldn't refresh) supabase-js queries anonymously and RLS answers
        // "not found" — never let that replace the match saved on this device.
        if (await sessionGate(supabase)) {
          if (!baseRef.current) setLoadError("You're offline and this match isn't saved on this device yet. Reconnect to load it.");
          return;
        }
        const [m, s, ca] = await Promise.all([
          supabase.from("matches").select("*").eq("id", matchId).maybeSingle(),
          supabase.from("match_participants").select("*").eq("match_id", matchId),
          supabase.from("court_assignments").select("*").eq("match_id", matchId).maybeSingle(),
        ]);
        // supabase-js doesn't separate "offline" from other failures; the
        // rule is simple: never blank a match that is already on screen (or
        // saved on this device) — the Reload button retries.
        const firstErr = m.error || s.error || ca.error;
        if (firstErr) {
          if (!baseRef.current) setLoadError(`This match isn't saved on this device yet and couldn't be loaded (${firstErr.message}). Reconnect and try again.`);
          return;
        }
        if (!m.data) { if (!baseRef.current) setLoadError("Match not found."); return; }
        const participantIds = [...new Set((s.data || []).map((x) => x.participant_id).filter(Boolean))];
        const [p, c] = await Promise.all([
          participantIds.length ? supabase.from("participants").select("*").in("id", participantIds) : Promise.resolve({ data: [] }),
          ca.data?.court_id ? supabase.from("courts").select("*").eq("id", ca.data.court_id).maybeSingle() : Promise.resolve({ data: null }),
        ]);
        if (p.error || c?.error) {
          if (!baseRef.current) setLoadError((p.error || c.error).message);
          return;
        }
        record = matchContextRecord({ owner, match: m.data, sides: s.data || [], participants: p.data || [], court: c?.data || null });
      }
      // Confirmed server truth goes to disk first (the store only ever moves
      // the confirmed score forward); the screen is then rebuilt from it plus
      // any unsynced local actions — a reload never replaces them.
      await store.putMatch(record);
      await refreshLocal();
      setLoadError("");
      setError("");
      engine?.kick();
    } catch (err) {
      if (isNetworkError(err)) {
        if (!baseRef.current) setLoadError("You're offline and this match isn't saved on this device yet. Reconnect to load it.");
        return;
      }
      const message = isStationInactiveError(err) ? "This court station was revoked. Pair again with a new QR." : err.message;
      if (baseRef.current) setError(message); else setLoadError(message);
    }
  }, [supabase, matchId, station, cfg, getAuth, owner, store, refreshLocal, engine]);

  useEffect(() => {
    refreshLocal().catch(() => {}).finally(() => load());
  }, [refreshLocal, load]);
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

  // Offline-capable match action: allocate seq → persist → show → sync.
  async function enqueue(kind, fields) {
    if (!view) return { accepted: false, reason: "not_ready" };
    lane.observeSeq(view.localLastSeq);
    const current = view.match;
    setLaneBusy(true);
    setError("");
    let res;
    try {
      res = await lane.enqueue(kind, fields, {
        validate: (payload) => {
          const type = kind === "coin_toss" || kind === "complete_match" ? kind : "score_event";
          const next = applyEntryToMatch(current, { type, payload });
          return { result: scoreSummary(next.score_state) };
        },
      });
    } finally {
      setLaneBusy(false);
    }
    if (!res.accepted) {
      if (res.reason === "invalid") setError(res.error?.message || "That action can't be applied to the current score.");
      else if (res.reason === "persist_failed") setError("This device could not save that action, so it was NOT recorded. Please try again.");
      return res;
    }
    setEntries((prev) => [...prev, res.entry]);
    engine?.kick();
    return res;
  }

  function sendScore(type, extra = {}) {
    return enqueue(type, extra);
  }

  async function sendCorrection(correctionPayload) {
    const res = await enqueue("correction", correctionPayload);
    if (!res.accepted) throw new Error(res.error?.message || "Could not save the correction");
    return res;
  }

  // Start and Hold change the match lifecycle that other devices act on, so
  // they stay online-only, and only once this match has nothing unsynced
  // (otherwise the server would see them out of order).
  async function onlineOnly(type, payload, offlineMessage) {
    if (unsyncedHere > 0) {
      setError("This match still has actions saved on this device that haven't synced. Connect to the internet and wait for SYNCED first.");
      engine?.kick({ resetBackoff: true });
      return false;
    }
    setBusy(true);
    setError("");
    try {
      const body = await liveCommand({ cfg, getAuth, type, payload });
      if (body?.result && baseRef.current) {
        await store.putMatch({ ...baseRef.current, match: mergeMatchFromResult(baseRef.current.match, body.result), savedAt: Date.now() });
        await refreshLocal();
      } else {
        await load();
      }
      return true;
    } catch (err) {
      setError(isNetworkError(err) ? offlineMessage : err.message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmHold() {
    setHolding(true);
    try {
      const ok = await onlineOnly(
        "transition_match",
        { match_id: match.id, status: "postponed", reason: holdReason.trim() || undefined },
        "You're offline — the match was NOT put on hold. Holding a match needs an internet connection.",
      );
      if (ok) {
        setShowHold(false);
        setHoldReason("");
      }
    } finally {
      setHolding(false);
    }
  }

  // Conflict resolution — every option keeps the local actions on disk.
  async function keepServerScore() {
    setResolving(true);
    try {
      await engine?.archiveLane(matchId);
      lane.reset(Number(baseRef.current?.match?.score_state?.lastSeq || 0));
      await refreshLocal();
      setError("");
    } finally {
      setResolving(false);
      setConfirmKeepServer(false);
    }
  }

  async function applyLocalAsCorrection(correctionPayload) {
    const serverMatch = baseRef.current?.match;
    if (!serverMatch || !engine) throw new Error("Match not ready");
    await engine.archiveLane(matchId);
    lane.reset(Number(serverMatch.score_state?.lastSeq || 0));
    const res = await lane.enqueue("correction", correctionPayload, {
      validate: (payload) => {
        const next = applyEntryToMatch(serverMatch, { type: "score_event", payload });
        return { result: scoreSummary(next.score_state) };
      },
    });
    await refreshLocal();
    if (!res.accepted) throw new Error(res.error?.message || "Could not save the correction");
    engine.kick();
    return res;
  }

  if (!hydrated && !match) {
    return (
      <div className="ump-shell ump-desk">
        <div className="ump-top"><LoadingState label="Loading match" /></div>
      </div>
    );
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

  const nameFor = (slot) => participantNameFor(sides, participants, match.id, slot);
  const score = match.score_state || {};
  const lastSeq = Number(score.lastSeq || 0);
  const nameA = nameFor("A");
  const nameB = nameFor("B");
  // Before completion syncs, only the score knows the winner (the server sets
  // match.winner when the match is completed).
  const winnerSlot = match.winner ?? score.winner ?? null;
  const winnerName = winnerSlot === "A" ? nameA : winnerSlot === "B" ? nameB : null;
  const gamesA = score.gamesWonA ?? score.gamesA ?? (winnerSlot === "A" ? 1 : 0);
  const gamesB = score.gamesWonB ?? score.gamesB ?? (winnerSlot === "B" ? 1 : 0);
  const canStart = (match.status === "assigned" || match.status === "ready") && isCoinTossCommitted(match);
  const scoring = match.status === "in_progress";
  const readyToComplete = match.status === "in_progress" && score.status === "completed";
  const completed = match.status === "completed";
  const showToss = (match.status === "assigned" || match.status === "in_progress" || match.status === "ready") && !completed;

  const inConflict = Boolean(view && (view.conflicts.length > 0 || view.blocked.length > 0));
  const conflictEntries = view ? [...view.conflicts, ...view.blocked] : [];
  const conflictReason = view?.conflicts[0]?.lastError?.message
    || (view?.blocked.length ? "The score on the server changed while this device was offline (another device or the organizer scored this match)." : "");
  const localResult = [...conflictEntries].reverse().find((e) => e.local?.result)?.local?.result || null;
  const serverScore = base?.match?.score_state || {};
  const pendingHere = view ? view.pending.length : 0;
  const offlineNow = Boolean(syncStatus?.offline) || (typeof navigator !== "undefined" && navigator.onLine === false);
  // A paired court station may only score points and undo: the server refuses
  // corrections from a station, and a refused correction would block this
  // match's sync queue. So corrections are offered to signed-in umpires only.
  const canCorrect = !station;
  const canReapply = canCorrect && Boolean(localResult) && (localResult.bestOf || 1) <= 1
    && ["in_progress", "completed"].includes(base?.match?.status);
  const actionsLocked = laneBusy || inConflict;

  return (
    <div className="ump-shell ump-desk">
      <header className="ump-top">
        <Button variant="secondary" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> {station ? "Court" : "My matches"}</Button>
        <div className="row ump-top-actions">
          {scoring && !station && (
            <Button variant="secondary" className="ump-hold-btn" onClick={() => setShowHold(true)} disabled={busy}>
              <PauseCircle size={15} aria-hidden="true" /> Hold
            </Button>
          )}
          <Button variant="secondary" onClick={load} disabled={busy}><RefreshCw size={15} aria-hidden="true" /> Reload</Button>
          <Button variant="ghost" onClick={onSignOut}><LogOut size={15} aria-hidden="true" /> Sign out</Button>
        </div>
      </header>

      <div className="ump-context-bar">
        <span className="ump-context-item">{match.stage_label ? stageTitle(match.stage_label) : `Round ${match.round || 1}`}</span>
        <span className="ump-context-sep" aria-hidden="true">·</span>
        <span className="ump-context-item">{court?.name || "No court"}</span>
        {score.winTo ? (
          <>
            <span className="ump-context-sep" aria-hidden="true">·</span>
            <span className="ump-context-item">Race to {score.winTo}</span>
          </>
        ) : null}
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
              {/* On expiry, one re-read picks up any time the organizer added. */}
              <MatchGameTimer match={match} onExpire={load} />
              <StatusBadge status={match.status} />
              {laneBusy ? <div className="ump-sync"><span className="ump-sync-dot" aria-hidden="true" /> Saving…</div> : null}
              {inConflict ? (
                <div className="ump-sync ump-sync-offline">
                  <span className="ump-sync-dot" aria-hidden="true" /> Sync conflict — action needed
                </div>
              ) : pendingHere > 0 ? (
                <div className="ump-sync ump-sync-offline">
                  <span className="ump-sync-dot" aria-hidden="true" />{" "}
                  {syncStatus?.needsAuth
                    ? `SAVED ON THIS DEVICE — ${pendingHere} waiting for sign-in`
                    : offlineNow
                      ? `OFFLINE — ${pendingHere} saved on this device`
                      : `SYNCING — ${pendingHere} saved on this device`}
                </div>
              ) : justSynced ? (
                <div className="ump-sync">SYNCED</div>
              ) : null}
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
        {pendingHere > 0 && !inConflict && (
          <p className="muted" style={{ color: "var(--muted-court)", margin: 0 }}>
            Confirmed by server: {serverScore.scoreA ?? 0}–{serverScore.scoreB ?? 0}. The score above includes {pendingHere} action{pendingHere === 1 ? "" : "s"} saved only on this device.
            {" "}
            <Button variant="ghost" className="compact" onClick={() => engine?.kick({ resetBackoff: true })}>Sync now</Button>
          </p>
        )}
      </div>

      <div className="ump-actions">
        {error && <Alert>{error}</Alert>}
        {store.durable === false && (
          <Alert>{NO_OFFLINE_STORAGE_MESSAGE}</Alert>
        )}
        {syncStatus?.needsAuth && pendingHere > 0 && <Alert tone="warn">{syncStatus.needsAuth}</Alert>}
        {inConflict && (
          <Alert>
            <strong>Sync conflict.</strong> {conflictReason}
            <div style={{ marginTop: 6 }}>
              Server score: {serverScore.scoreA ?? 0}–{serverScore.scoreB ?? 0}
              {localResult ? ` · This device's unsynced score: ${localResult.scoreA}–${localResult.scoreB}` : ""}
              {` · ${conflictEntries.length} action${conflictEntries.length === 1 ? "" : "s"} kept on this device`}
            </div>
            <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
              {view.conflicts.length > 0 && (
                <Button variant="secondary" disabled={resolving} onClick={() => engine?.retryLane(matchId)}>Retry sync</Button>
              )}
              <Button variant="secondary" disabled={resolving} onClick={() => setConfirmKeepServer(true)}>Keep server score</Button>
              {canReapply && (
                <Button variant="secondary" disabled={resolving} onClick={() => setReapplyLocal(localResult)}>Apply this device's score as a correction</Button>
              )}
            </div>
            <div className="muted" style={{ marginTop: 6 }}>
              Nothing is deleted. You can also leave this for now — the saved actions stay on this device until you choose.
            </div>
          </Alert>
        )}

        {canStart && (
          <Button
            disabled={busy}
            onClick={() => setShowScoringConfirm(true)}
          >
            Start match
          </Button>
        )}

        {canUmpireSetGameTime(match, { station: Boolean(station) }) && (
          <Button variant="secondary" disabled={busy} onClick={() => setShowGameTime(true)}>
            {timerView(match, Date.now()).state === "configured"
              ? `Game time: ${Math.round(timerView(match, Date.now()).durationSec / 60)} min`
              : "Set game time"}
          </Button>
        )}

        {showGameTime && canUmpireSetGameTime(match, { station: Boolean(station) }) && (
          <GameTimeModal
            match={match}
            busy={busy}
            onClose={() => setShowGameTime(false)}
            onSend={(payload) => onlineOnly(
              "set_match_timer",
              { match_id: match.id, ...payload },
              "You're offline — the game time was NOT changed. Changing it needs an internet connection.",
            )}
          />
        )}

        {showScoringConfirm && (
          <Modal title="Match scoring" onClose={() => setShowScoringConfirm(false)}>
            <div className="stack">
              {knownScoringTarget(match) ? (
                <p style={{ margin: 0 }}>
                  <strong>Race to {knownScoringTarget(match)}</strong>
                  <span className="muted"> — set by stage. The first team to {knownScoringTarget(match)} wins immediately (no deuce).</span>
                </p>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  The target is set automatically by stage (qualification: race to 11 · semifinal/final: race to 15) and shown once the match starts. No deuce.
                </p>
              )}
              {timerView(match, Date.now()).state === "configured" && (
                <p style={{ margin: 0 }}>
                  <strong>Game time: {Math.round(timerView(match, Date.now()).durationSec / 60)} minutes</strong>
                  <span className="muted"> — the countdown starts when the match starts.</span>
                </p>
              )}
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                <Button variant="secondary" disabled={busy} onClick={() => setShowScoringConfirm(false)}>Cancel</Button>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setShowScoringConfirm(false);
                    await onlineOnly(
                      "start_match",
                      { match_id: match.id },
                      "You're offline — the match was NOT started. Starting a match needs an internet connection.",
                    );
                  }}
                >
                  Start Match
                </Button>
              </div>
            </div>
          </Modal>
        )}

        {showToss && (
          <CoinTossPanel
            match={match}
            nameA={nameA}
            nameB={nameB}
            busy={busy || actionsLocked}
            lastSeq={lastSeq}
            onCommit={async (payload) => {
              if (isCoinTossCommitted(match)) return { match };
              // Same durable path as scoring. The lane allocates the seq and
              // event id itself; the panel's own seq/event_id are ignored so
              // there is exactly one seq counter for this match. The saved
              // toss is shown immediately (readCoinToss() reads this shape).
              const res = await enqueue("coin_toss", {
                result: payload.result,
                winner: payload.winner,
                serving_team: payload.serving_team,
                court_side: payload.court_side,
              });
              if (!res.accepted) throw new Error(res.error?.message || "Could not save the coin toss");
              return { queued: true };
            }}
          />
        )}

        {scoring && !readyToComplete && (
          <>
            <div className="pads">
              <Button className="point a" disabled={busy || actionsLocked} aria-label={`Point ${nameA}`} onClick={() => sendScore("point", { team: "A" })}>
                Point {nameA}
              </Button>
              <Button className="point b" disabled={busy || actionsLocked} aria-label={`Point ${nameB}`} onClick={() => sendScore("point", { team: "B" })}>
                Point {nameB}
              </Button>
            </div>
            <div className="row">
              <Button variant="secondary" disabled={busy || actionsLocked} onClick={() => setConfirmUndo(true)}>
                Undo last point
              </Button>
              {canCorrect && (
                <Button variant="ghost" className="compact" disabled={actionsLocked} onClick={() => setShowEditScore(true)}>
                  Edit score
                </Button>
              )}
            </div>
          </>
        )}

        {readyToComplete && !confirmComplete && (
          <Button disabled={busy || actionsLocked} onClick={() => setConfirmComplete(true)}>Complete match</Button>
        )}

        {completed && (
          <Card className="ump-complete">
            <div className="kicker" style={{ color: "var(--gold-accent)" }}>Match complete</div>
            <h2>Winner {winnerName}</h2>
            <p>Final score {gamesA} – {gamesB}</p>
            <p className="muted">{score.scoreA ?? 0}–{score.scoreB ?? 0} in the last game</p>
            {canCorrect && (
              <Button variant="ghost" className="compact" disabled={actionsLocked} onClick={() => setShowEditScore(true)}>
                Edit score
              </Button>
            )}
          </Card>
        )}
      </div>

      {showEditScore && (
        <EditScoreModal
          match={match}
          nameA={nameA}
          nameB={nameB}
          sendCorrection={sendCorrection}
          onClose={() => setShowEditScore(false)}
        />
      )}

      {reapplyLocal && base?.match && (
        <EditScoreModal
          match={base.match}
          nameA={nameA}
          nameB={nameB}
          title="Apply this device's score"
          initialScoreA={reapplyLocal.scoreA}
          initialScoreB={reapplyLocal.scoreB}
          sendCorrection={applyLocalAsCorrection}
          onClose={() => setReapplyLocal(null)}
        />
      )}

      {confirmKeepServer && (
        <ConfirmDialog
          title="Keep the server's score?"
          body={`The server's score (${serverScore.scoreA ?? 0}–${serverScore.scoreB ?? 0}) stays official. The ${conflictEntries.length} unsynced action${conflictEntries.length === 1 ? "" : "s"} saved on this device for this match are moved to this device's archive (kept for 30 days) and are not sent.`}
          confirmLabel="Keep server score"
          busy={resolving}
          onCancel={() => setConfirmKeepServer(false)}
          onConfirm={keepServerScore}
        />
      )}

      {showHold && (
        <Modal title="Hold this match?" onClose={() => !holding && setShowHold(false)}>
          <div className="stack">
            <p style={{ margin: 0 }}>
              The match is put on hold — the current score and history are kept exactly as they are. The organizer can resume it from the desk when play continues.
            </p>
            <Input
              label="Reason (optional)"
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value)}
              placeholder="e.g. injury timeout, court issue"
              disabled={holding}
            />
            {error && <Alert>{error}</Alert>}
            <div className="row">
              <Button variant="secondary" onClick={() => setShowHold(false)} disabled={holding}>Cancel</Button>
              <Button onClick={confirmHold} disabled={holding}>{holding ? "Holding…" : "Hold match"}</Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmComplete && (
        <ConfirmDialog
          title="Match complete"
          body={`Winner: ${winnerName || "—"}. Final score ${gamesA} – ${gamesB}. This writes the official result.`}
          confirmLabel="Complete match"
          busy={busy}
          onCancel={() => setConfirmComplete(false)}
          onConfirm={() => {
            setConfirmComplete(false);
            enqueue("complete_match", {});
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
