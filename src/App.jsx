import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { flushSync } from "react-dom";
import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
// NOTE: Supabase is loaded lazily from a CDN at runtime (see getSupabase below),
// NOT statically imported — a static import of a package the preview sandbox
// doesn't have would blank the whole app.
import { D } from "./theme/tokens.js";
import { useTheme } from "./theme/useTheme.js";
import { LS } from "./lib/storage.js";
import { Log } from "./lib/log.js";
import { uid, today, fmtDate, nameOf, teamLabel, clamp, withTimeout, isStrongPassword, PASSWORD_HINT, hasElectron } from "./lib/utils.js";
import { Outbox } from "./lib/outbox.js";
import { RatingEngine } from "./lib/ratingEngine.js";
import { newMatchState, applyPoint, undoPoint, applyEditedScore, callTimeout, clearTimeoutBanner } from "./lib/scoring.js";
import { advanceBracket, advanceBronzeMatchSlot, computeSemifinalFillPatches } from "./lib/tournamentBracket.js";
import { advanceDoubleEliminationBracket } from "./lib/tournamentDoubleElimination.js";
import { advanceIndividualMatchup, advanceBronzeIndividualMatchup, finalizeCrossTeamMatchup, groupRegistrationsByTeam } from "./lib/tournamentTeamVsTeam.js";
import { isTeamRoundRobinComplete, rankIndividualPairsForSemifinals } from "./lib/tournamentTeamRoundRobin.js";
import { selectQualifiers, generateQualifierBracketShell } from "./lib/tournamentTeamPlayoffs.js";
import { buildTournamentStandings } from "./lib/tournamentStandings.js";
import { isValidMatchup, canControlMatch, canControlEvent, buildMixRound, eligibleForRound } from "./lib/mixmatch.js";
import { isAssignedUmpire } from "./lib/umpire.js";
import { SITE_URL_PATH, isRecoveryLink } from "./lib/config.js";
import { Cloud, readErr } from "./lib/cloud.js";
import { useLiveBoard } from "./lib/liveBoard.js";
import { Notify } from "./lib/notify.js";
import { useAppHistory } from "./navigation/useAppHistory.js";
import { BackHandlerContext } from "./navigation/BackHandlerContext.jsx";
import { isInsideHorizontalScroller } from "./navigation/gestures.js";
import { useAndroidBackButton } from "./navigation/useAndroidBackButton.js";
import { NAV_TABS } from "./navigation/navTabs.jsx";

import { UpdateBanner } from "./components/ui/UpdateBanner.jsx";
import { OfflineBanner } from "./components/ui/OfflineBanner.jsx";
import { SplashScreen } from "./components/SplashScreen.jsx";
import { AppHeader } from "./components/AppHeader.jsx";
import { BottomNav } from "./components/BottomNav.jsx";
import { SideNav } from "./components/SideNav.jsx";
import { CourtMgrModal } from "./modals/CourtMgrModal.jsx";
import { AuthGate } from "./screens/auth/AuthGate.jsx";
import { ResetPasswordScreen } from "./screens/auth/ResetPasswordScreen.jsx";
import { CourtsScreen } from "./screens/courts/CourtsScreen.jsx";
import { LiveBoardScreen } from "./screens/courts/LiveBoardScreen.jsx";
import { ScoringScreen } from "./screens/courts/ScoringScreen.jsx";
import { TournamentsListScreen } from "./screens/tournaments/TournamentsListScreen.jsx";
import { ErrorBoundary } from "./components/ui/ErrorBoundary.jsx";
import { HomeScreen } from "./screens/home/HomeScreen.jsx";
import { PlayerProfilePanel } from "./screens/players/PlayerProfilePanel.jsx";
import { PlayersScreen } from "./screens/players/PlayersScreen.jsx";
import { AdminPanel } from "./screens/settings/AdminPanel.jsx";
import { MyProfilePanel } from "./screens/settings/MyProfilePanel.jsx";
import { NotificationInboxPanel } from "./screens/settings/NotificationInboxPanel.jsx";
import { SettingsScreen } from "./screens/settings/SettingsScreen.jsx";

const pendingTeamMatchupPatches = new Map();

// Electron desktop builds get a sidebar shell instead of the phone-shaped
// bottom-nav column — see [data-platform="electron"] in base.css and
// SideNav.jsx. window.electronAPI only exists inside Electron's preload
// bridge, so this is false on web/Android.

const INIT_COURTS=[
  {id:"c1",name:"Court 1",color:D.blue,   active:true},
  {id:"c2",name:"Court 2",color:D.green,  active:true},
  {id:"c3",name:"Court 3",color:D.amber,  active:true},
  {id:"c4",name:"Court 4",color:D.purple, active:true},
];



export default function App(){
  const {theme,setTheme} = useTheme();

  // = Auth =
  const [accounts,      setAccounts]      = useState(()=>LS.get("pl6_accounts",[]));
  // account = {id, name, email, photo, hand, joinDate, role:"player"|"admin", banned:false} — Supabase Auth owns credentials.
  // Admin access is a real Supabase Auth account (see admins table / is_admin()), gated by
  // accounts.role==="admin", not a client-side secret.
  const [currentUser,   setCurrentUser]   = useState(()=>LS.get("pl6_session",null));
  const [authScreen,    setAuthScreen]    = useState("login"); // "login" | "signup"

  // = State =
  const [panel,         setPanel]         = useState(null);
  // Manual court assignment shortcut: when set, the next time the "setup" panel opens it
  // pre-selects this court and starts in Manual Team Setup mode instead of the default
  // Automatic Mix & Match. Cleared whenever any panel closes (see closePanel below) so it can
  // never leak into a later, unrelated "+ Match" open.
  const [presetCourtId, setPresetCourtId] = useState(null);
  // Set only by the Event page's "+ Add Match" button — forces the New Match wizard to attach
  // straight to that specific, already-existing Event (no name field, no resolve/create), rather
  // than the usual "current session" resolution. Cleared whenever any panel closes, same as
  // presetCourtId above.
  const [forceEventId, setForceEventId] = useState(null);
  // Which Event's detail page is currently open (set/cleared by CalendarScreen's onViewEvent/
  // onLeaveEvent — CalendarScreen keeps its own local selEvtId for the UI; this is a parallel
  // notification so App() can resolve rosterOwnerId below even when just viewing an event, not
  // only while inside the New Match wizard). Not persisted — resets to null on reload, matching
  // presetCourtId/forceEventId's lifecycle.
  const [viewingEventId, setViewingEventId] = useState(null);
  // Set when "Open Event" is tapped from a notification — tells CalendarScreen which event to
  // jump straight into instead of landing on the bare month view. Consumed/cleared once.
  const [openEventId, setOpenEventId] = useState(null);
  // Screen-level swipe-navigation history stack (see useAppHistory above). `screen` is derived
  // straight from the reducer's current entry — no mirrored useState/effect pair — so there's
  // no extra render pass and no risk of the two ever disagreeing. `setScreen` keeps the exact
  // same (screenId:string)=>void signature every existing call site already uses; it now also
  // pushes onto the history stack, with zero edits needed at any call site. `useReducer`'s
  // dispatch is referentially stable for the lifetime of the component, so closing over
  // `appHistory.push` with an empty dep array is safe even though `appHistory` itself is a
  // fresh object every render.
  const appHistory = useAppHistory(()=>LS.get("pl6_screen","home"));
  const screen = appHistory.current;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const setScreen = useCallback((s)=>{ appHistory.push(s); },[]);
  // Screens visited at least once stay mounted (display:none instead of unmounting) so their
  // local search/filter/tab state and scroll position survive Back/Forward navigation.
  const [visitedScreens, setVisitedScreens] = useState(()=>new Set([screen]));
  // Accumulating "every screen seen so far" is inherently a running-history concern, not a pure
  // derivation of current props/state — an effect is the correct tool here (guarded by the
  // `prev.has(screen)` check, so it never re-fires once a screen is already recorded).
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{ setVisitedScreens(prev=> prev.has(screen) ? prev : new Set(prev).add(screen)); },[screen]);
  // Local drill-down back-handler stack (deepest-registered-first). See BackHandlerContext above.
  const backHandlersRef = useRef([]);
  const backHandlerCtx = useMemo(()=>({
    register(fn){ backHandlersRef.current=[...backHandlersRef.current,fn]; return ()=>{ backHandlersRef.current=backHandlersRef.current.filter(f=>f!==fn); }; },
  }),[]);
  const gestureBack = useCallback(()=>{
    const handlers = backHandlersRef.current;
    for(let i=handlers.length-1;i>=0;i--){ if(handlers[i]()) return; } // deepest local drill-down first
    if(panel){ setPanel(null); return; }                               // panel overlay layer
    if(appHistory.canGoBack) appHistory.back();                        // screen history layer
  },[panel,appHistory]);
  const gestureForward = useCallback(()=>{
    if(appHistory.canGoForward) appHistory.forward();
  },[appHistory]);
  const canGestureBack = useCallback(
    ()=> backHandlersRef.current.length>0 || !!panel || appHistory.canGoBack,
    [panel,appHistory]
  );
  useAndroidBackButton(gestureBack, canGestureBack);
  // Ctrl+1..7 jumps straight to a main-nav tab (Electron desktop only — same
  // convention as browser/Slack tab switching), calling the exact same
  // setScreen already wired to SideNav/BottomNav so it can never navigate
  // anywhere those aren't already able to.
  useEffect(()=>{
    if(!hasElectron) return;
    const onKeyDown=(e)=>{
      if(!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      const idx = NAV_TABS.findIndex((_,i)=>String(i+1)===e.key);
      if(idx<0) return;
      e.preventDefault();
      setScreen(NAV_TABS[idx].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return ()=>window.removeEventListener("keydown", onKeyDown);
  },[setScreen]);
  const [players,       setPlayers]       = useState(()=>LS.get("pl6_players",[]));
  const [courts,        setCourts]        = useState(()=>LS.get("pl6_courts",INIT_COURTS));
  const [matches,       setMatches]       = useState(()=>LS.get("pl6_matches",[]));
  // Live match scoreboards (score/server/point-history per in-progress match). Restored from
  // localStorage so a reload/background/close never loses an active match — reconciled against
  // `matches` so a stale snapshot (deleted/completed/cancelled match) never resurrects a ghost.
  const [liveStates,    setLiveStates]    = useState(()=>{
    const raw = LS.get("pl6_liveStates", {});
    const out = {};
    for(const id of Object.keys(raw||{})){
      const st = raw[id];
      const m = matches.find(x=>x.id===id);
      if(!m || !st) continue;
      if(m.status!=="in_progress" && m.status!=="paused") continue;
      if(st.status==="completed") continue;
      out[id] = st;
    }
    return out;
  });
  const [activeMatchId, setActiveMatchId] = useState(()=>LS.get("pl6_activeMatchId",null));
  const [viewPlayerId,  setViewPlayerId]  = useState(null);
  const [toast,         setToast]         = useState(null);
  // Declared this early (rather than near the other UI-state helpers further down) so functions
  // defined earlier in the component body — e.g. reconcileOwnLiveMatches — can safely close over
  // it without a temporal-dead-zone reference.
  const notify = useCallback((msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast(null),3200);},[]);
  // Friendships: [{from, to, status:"pending"|"accepted"}]
  const [friends,       setFriends]       = useState(()=>LS.get("pl6_friends",[]));
  // Shared player directory pulled from the cloud (empty until Supabase is configured)
  const [directory,     setDirectory]     = useState([]);
  // Shared calendar events + their attendee/request rows (from cloud)
  const [cloudEvents,   setCloudEvents]   = useState(()=>LS.get("pl6_events",[]));
  const [eventAtt,      setEventAtt]       = useState(()=>LS.get("pl6_eventAtt",[]));
  // Persistent per-user notification inbox (e.g. "you were added as an organizer") — synced via
  // the same 10s poll as everything else in the sync effect below.
  const [notifications, setNotifications] = useState(()=>LS.get("pl6_notifications",[]));
  // This user's own assigned-as-umpire tournament matches, tournament-wide — feeds the
  // Tournaments screen's "Umpiring" list, HomeScreen's MyUmpireAssignmentsCard, AND
  // reconcileOwnLiveMatches' `mine` filter below (so an assigned-but-not-owned live match
  // actually becomes controllable on this device, not just visible read-only via the Live
  // Match Board). One fetch/subscribe pair, three consumers — no duplicate realtime channels.
  const [umpireAssignments, setUmpireAssignments] = useState(()=>LS.get("pl6_umpireAssignments",[]));
  // Pending deep-link target set by the Home "YOU'RE UMPIRING" banner or an umpire_assigned
  // notification tap — consumed once by TournamentsListScreen's own openScoreboard (the same
  // function its "Open Scoreboard" button already uses), not a second navigation path.
  const [umpireDeepLinkMatchId, setUmpireDeepLinkMatchId] = useState(null);
  // Pending {tournamentId,divisionId} deep-link target from a match_assigned notification
  // tap — resolved once at tap time (async fetch, since the target tournament/division/match
  // aren't preloaded for an arbitrary player the way umpire assignments are above), then
  // consumed by TournamentsListScreen/TournamentDetailPanel the same way umpireDeepLinkMatchId
  // is, just two levels (tournament, then division) instead of one.
  const [matchAssignedDeepLink, setMatchAssignedDeepLink] = useState(null);
  const [chatMsgs,      setChatMsgs]       = useState(()=>LS.get("pl6_chat",[]));
  const [feedPosts,     setFeedPosts]      = useState(()=>LS.get("pl6_feed",[]));
  const [booting,       setBooting]        = useState(true);   // loading intro
  const [pullY,         setPullY]          = useState(0);      // pull-to-refresh offset
  const [refreshing,    setRefreshing]     = useState(false);
  // Live share tokens {matchId: shareToken}
  const [shareTokens,   setShareTokens]   = useState(()=>LS.get("pl6_shares",{}));
  // Mix & Match queue — setups waiting for a free court (auto-started when one frees)
  const [matchQueue,    setMatchQueue]    = useState(()=>LS.get("pl6_queue",[]));
  // Live matches running on OTHER devices (read-only, for the Live Match view)
  const [remoteLive,    setRemoteLive]    = useState([]);
  // Player categories + organizer teams (tournament-style, distinct from in-match Team A/B)
  const [categories,    setCategories]    = useState(()=>LS.get("pl6_categories",[]));
  const [teams,         setTeams]         = useState(()=>LS.get("pl6_teams",[]));
  // Admin
  const [clubs,         setClubs]         = useState(()=>LS.get("pl6_clubs",[]));
  const [adminMode,     setAdminMode]     = useState(false);
  // Organizer-configurable Rating Engine settings (Admin → Ratings tab)
  const [ratingConfig,  setRatingConfig]  = useState(()=>LS.get("pl6_ratingConfig",{baseRating:RatingEngine.BASE}));
  // Live Match Board: this organizer's own session round counter (shared with every logged-in
  // user via live_sessions). Resets to 1 once their session has no live/paused matches and an
  // empty queue left (see syncLiveSession/endMatch/cancelMatch below).
  const [liveRound,     setLiveRound]     = useState(()=>LS.get("pl6_liveRound",1));
  // Which Event (events.id) this organizer's current match-creation session is attached to —
  // the single source of truth, on this device, for "New Match creates a new Event vs. joins
  // the one already running." Same lazy-load + persist pattern as liveRound; reset back to null
  // by refreshLiveSessionAfter the moment nothing is live/queued anymore, exactly like liveRound
  // resets to 1, so the NEXT session (even later the same day) always starts a fresh Event.
  const [activeEventId, setActiveEventId] = useState(()=>LS.get("pl6_activeEventId",null));
  // Home's "Today" card list: purely a local display filter (never touches matches, ratings,
  // Supabase, or history) — a match dismissed here just stops showing up on Home.
  const [dismissedHomeIds, setDismissedHomeIds] = useState(()=>new Set(LS.get("pl6_dismissedHome",[])));
  // Whose Players/Categories/Teams/Courts this device should be reading and writing right now.
  // Defaults to my own roster (unchanged behavior for the solo/legacy path) but resolves to the
  // EVENT OWNER's id whenever this device is actively working inside a shared Event it doesn't
  // own — via the New Match wizard forced onto that event, an ongoing session attached to it, or
  // simply having that event's detail page open. This is THE fix for "Organizer sees an empty
  // roster/categories/courts": every Cloud fetch/upsert for those resources already takes an
  // organizerId param — they were just always called with currentUser.id instead of this.
  const eventOwnerOf = (eventId)=> {
    const ev = eventId ? cloudEvents.find(e=>e.id===eventId) : null;
    return (ev && canControlEvent(ev, currentUser)) ? ev.ownerId : null;
  };
  // Same organizer/co-organizer/admin gate the RLS on live_matches already enforces server-side —
  // mirrored here so an unauthorized tap fails fast with a message instead of a silent/late 403
  // from Supabase. Resolves the match's event the same way ScoringScreen/CourtsScreen already do.
  // Widened (not narrowed) with the assigned-umpire check — organizer/co-organizer/admin
  // control from canControlMatch is never reduced, only ORed with "is this the assigned
  // umpire," so every one of the 10 existing call sites gated behind this single wrapper
  // (score/undo/edit/pause/resume/timeout/hold/cancel/end) picks up umpire access in one
  // place instead of 10 separate edits.
  const canControlMatchNow = (match)=>
    canControlMatch(match, currentUser, match?.eventId ? cloudEvents.find(e=>e.id===match.eventId) : null)
    || isAssignedUmpire(match, currentUser);
  // Umpire audit trail (fire-and-forget, cross-device — see Cloud.appendAuditLog). No-op for
  // any non-tournament match (match_audit_log.tournament_match_id is not null, so there's
  // nothing meaningful to log for a casual/mixmatch match). Auto-detects "organizer override"
  // by comparing the acting user against the match's assigned umpire — if a distinct umpire is
  // assigned but someone else is taking the action, canControlMatchNow already gated entry to
  // only the organizer/co-organizer/admin, so this can only be an override.
  const logMatchAudit = (match, action, detail)=>{
    if(!match?.tournamentMatchId) return;
    const isOverride = match.umpireId && match.umpireId!==currentUser?.id;
    Cloud.appendAuditLog({
      tournamentMatchId: match.tournamentMatchId, liveMatchId: match.id,
      organizerId: match.organizerId, actorId: currentUser?.id, actorName: currentUser?.name,
      action: isOverride ? action+"_organizer_override" : action, detail,
    });
  };
  const rosterOwnerId = eventOwnerOf(forceEventId) || eventOwnerOf(activeEventId) || eventOwnerOf(viewingEventId) || currentUser?.id;
  // The cloud-sync effect below is only re-created when `currentUser` changes (its own deps
  // array), but rosterOwnerId can change far more often (opening/closing an Event page, forcing
  // the wizard onto one) — its periodic sync() tick needs the CURRENT value each time it fires,
  // not whatever it was when the effect/interval was first set up.
  const rosterOwnerIdRef=useRef(rosterOwnerId); useEffect(()=>{rosterOwnerIdRef.current=rosterOwnerId;},[rosterOwnerId]);
  const cooldown = useRef({});
  // Latest cloud-sync fn (so pull-to-refresh can trigger it without a page reload)
  const syncRef = useRef(()=>Promise.resolve());
  // Guards against overlapping sync() calls — the periodic 10s poll, a manual pull-to-refresh,
  // and a repeated swipe could otherwise all fire concurrently with zero mutex between them.
  const syncInFlightRef = useRef(false);
  // Debounce timers for streaming live scores to the cloud (one per match)
  const liveWriteTimers = useRef({});
  // Latest `matches`, for reads inside setLiveStates updaters (sendPoint/sendUndo/editScore) —
  // those updaters build the payload handed to pushLive/pushLiveDebounced, so they need the
  // freshest match row (court/teams/organizer fields), not whatever `matches` closed over at
  // the render those callbacks were created in. Same ref-mirror pattern as rosterOwnerIdRef above.
  const matchesRef = useRef(matches); useEffect(()=>{matchesRef.current=matches;},[matches]);
  // Offline/reconnected audit entries for whichever tournament match this device is
  // currently controlling (umpire or organizer) — piggybacks on the same browser
  // online/offline events OfflineBanner.jsx already uses, just for a different purpose
  // (an audit trail entry here, a UI banner there — no shared state needed between them).
  useEffect(()=>{
    if(!activeMatchId) return;
    const onOffline=()=>{ const m=matchesRef.current.find(x=>x.id===activeMatchId); if(m) logMatchAudit(m,"offline"); };
    const onOnline=()=>{ const m=matchesRef.current.find(x=>x.id===activeMatchId); if(m) logMatchAudit(m,"reconnected"); };
    window.addEventListener("offline",onOffline);
    window.addEventListener("online",onOnline);
    return ()=>{ window.removeEventListener("offline",onOffline); window.removeEventListener("online",onOnline); };
  },[activeMatchId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Infinite Match Making: organizer-configured launcher state (on/off, player source, format,
  // rest interval). Client-side only, same lazy-load + persist pattern as every other setting in
  // this file — the matches it produces already sync via the existing matches/live_matches
  // tables, so the launcher config itself doesn't need a Supabase row.
  const [infiniteMM, setInfiniteMM] = useState(()=>LS.get("pl6_infiniteMM",{enabled:false,source:"master",isDoubles:false,winTo:11,restInterval:2,roundsMode:"infinite",roundsCount:4,organizerId:null,organizerName:null,date:null,location:"",organizerIds:[],organizerNames:{}}));
  // Persistent (across repeated auto-generations) rotation/rest memory for Infinite Match Making —
  // deliberately separate from MixMatchPanel's own per-click histRef/sitRef so the one-shot manual
  // "Mix & Match" button's reset-per-generation behavior is completely unaffected.
  const infiniteHistRef = useRef({partner:{},opp:{}});
  const infiniteRestRef = useRef({});
  // Single-flight guard so a court-freed event and a near-simultaneous cloud sync tick can never
  // both trigger a generation for the same freed court (mirrors the `cooldown` ref above).
  const infiniteGenLock = useRef(false);
  // How many rounds (auto-generated matches) have been produced since Infinite Mode was last
  // turned on — reset on enable, checked against infiniteMM.roundsCount when roundsMode is
  // "fixed" so the launcher can auto-stop itself exactly like an admin flipping it off manually.
  const infiniteRoundsPlayedRef = useRef(0);

  // Global background/reset/safe-area now live in src/theme/base.css, loaded
  // once from main.jsx — no more imperative <style>-tag injection here.

  // = Persist =
  useEffect(()=>{LS.set("pl6_players",players);},[players]);
  useEffect(()=>{LS.set("pl6_courts",courts);},[courts]);
  useEffect(()=>{LS.set("pl6_matches",matches);},[matches]);
  // Live match auto-save: synchronous (not debounced) so score/server/history are never lost,
  // even if the tab is killed mid-point. The debounced Cloud push (pushLiveDebounced) is a
  // separate, unrelated concern for cross-device sync — this is the local safety net.
  useEffect(()=>{LS.set("pl6_liveStates",liveStates);},[liveStates]);
  useEffect(()=>{LS.set("pl6_screen",screen);},[screen]);
  useEffect(()=>{LS.set("pl6_activeMatchId",activeMatchId);},[activeMatchId]);
  useEffect(()=>{LS.set("pl6_umpireAssignments",umpireAssignments);},[umpireAssignments]);
  useEffect(()=>{LS.set("pl6_friends",friends);},[friends]);
  useEffect(()=>{LS.set("pl6_shares",shareTokens);},[shareTokens]);
  useEffect(()=>{LS.set("pl6_queue",matchQueue);},[matchQueue]);
  useEffect(()=>{LS.set("pl6_accounts",accounts);},[accounts]);
  useEffect(()=>{LS.set("pl6_clubs",clubs);},[clubs]);
  useEffect(()=>{LS.set("pl6_categories",categories);},[categories]);
  useEffect(()=>{LS.set("pl6_teams",teams);},[teams]);
  useEffect(()=>{LS.set("pl6_events",cloudEvents);},[cloudEvents]);
  useEffect(()=>{LS.set("pl6_eventAtt",eventAtt);},[eventAtt]);
  useEffect(()=>{LS.set("pl6_notifications",notifications);},[notifications]);
  useEffect(()=>{LS.set("pl6_chat",chatMsgs);},[chatMsgs]);
  useEffect(()=>{LS.set("pl6_feed",feedPosts);},[feedPosts]);
  // Rating Engine config: persists locally and immediately re-points the shared RatingEngine
  // singleton's BASE getter/setter — every existing call site that reads RatingEngine.BASE for
  // new-player defaults picks this up automatically, with zero edits to those call sites.
  useEffect(()=>{ LS.set("pl6_ratingConfig",ratingConfig); RatingEngine.BASE = +ratingConfig?.baseRating || 3.000; },[ratingConfig]);
  useEffect(()=>{LS.set("pl6_liveRound",liveRound);},[liveRound]);
  useEffect(()=>{LS.set("pl6_activeEventId",activeEventId);},[activeEventId]);
  useEffect(()=>{LS.set("pl6_dismissedHome",[...dismissedHomeIds]);},[dismissedHomeIds]);
  useEffect(()=>{LS.set("pl6_infiniteMM",infiniteMM);},[infiniteMM]);
  useEffect(()=>{if(currentUser)LS.set("pl6_session",currentUser);else LS.del("pl6_session");},[currentUser]);

  // = Logging: capture runtime errors + record app boot (once) =
  useEffect(()=>{
    const cleanup = Log.installGlobalHandlers();
    Log.info("system","App started",{screen});
    return cleanup;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // = Loading intro: show the splash briefly on launch =
  useEffect(()=>{ const t=setTimeout(()=>setBooting(false),1900); return ()=>clearTimeout(t); },[]);

  // = Live match restore guard: a "scoring" screen with no matching live match (localStorage
  // edited by hand, or the match was cancelled/completed/deleted on another device WHILE this
  // device had it open) must never render ScoringScreen's broken empty state — fall back to
  // Courts instead. Runs on every relevant change (not just mount) so a match being pulled out
  // from under an actively-scoring user by reconcileOwnLiveMatches' pruning or a remote
  // completion is caught immediately, not just at app boot. =
  useEffect(()=>{
    if(screen==="scoring" && (!activeMatchId || !liveStates[activeMatchId])){
      setScreen("courts");
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guard-rail redirect, not a render-derived value
      if(activeMatchId) setActiveMatchId(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[screen,activeMatchId,liveStates]);

  // Lightweight cross-device restore: if this organizer has an in-progress/paused match in the
  // cloud that's missing locally (localStorage was cleared, new device), synthesize a local
  // match + live-state entry from the cloud snapshot. Only ever FILLS GAPS — never overwrites
  // an existing local match/liveState, so there's no conflict resolution to build. The cloud
  // snapshot only carries the latest score, not point-by-point history, so a restored match
  // starts with an empty Undo stack — an accepted limitation of this fallback path.
  // Pulls a live match onto THIS device's local state whenever the current user is either the
  // one pushing it (r.ownerId — same device/session, the original restore-after-clear case) OR
  // the match's owner/co-organizer (r.organizerId/r.organizerIds — a DIFFERENT device than the
  // one that started it). This is what makes a co-organizer's own Courts/Scoring screens show a
  // match as fully controllable instead of read-only "Live Elsewhere": once synthesized here,
  // every existing control function (pauseMatch, sendPoint, endMatch, ...) just works, since they
  // all operate on this same local `matches`/`liveStates` state already.
  // `canPrune=false` skips the prune-stale-local-matches half entirely (the
  // add/patch half below still runs against whatever rows are given — there's
  // nothing unsafe about adding/patching from a real, if possibly incomplete,
  // snapshot, only about concluding absence means deletion). Callers driven by
  // an awaited, already-fetch-confirmed array default to true; the
  // useLiveBoard()-driven effect below passes its own hasLoadedOnce instead,
  // since that hook's `matches` starts as [] synchronously before its first
  // real fetch ever resolves — pruning against that empty starting snapshot is
  // exactly what used to cancel a user's own still-live match on a page reload.
  const reconcileOwnLiveMatches = (remoteRows,canPrune=true)=>{
    if(!currentUser) return;
    const rows=remoteRows||[];
    // Also pulls in any match belonging to an Event I currently control (owner or accepted
    // co-organizer), not just ones whose own frozen organizerIds snapshot happens to include me
    // — that snapshot is only ever set once, at startMatch() time, so a match created before my
    // invite was accepted would otherwise never reach my device at all (see canControlMatch).
    // Also pulls in any match I'm the assigned umpire for (umpireAssignments, kept in sync by
    // its own fetch/subscribe effect above) — without this an umpire's device would only ever
    // see this match read-only via the Live Match Board, never as a controllable entry, even
    // though RLS (migration 127) already lets them write to it.
    const myUmpireTournamentMatchIds=new Set(umpireAssignments.map(u=>u.id));
    const isMineByUmpire=r=>r.tournamentMatchId && myUmpireTournamentMatchIds.has(r.tournamentMatchId);
    const mine=rows.filter(r=>r.status!=="completed" &&
      (r.ownerId===currentUser.id || r.organizerId===currentUser.id || (r.organizerIds||[]).includes(currentUser.id)
       || (r.eventId && canControlEvent(cloudEvents.find(e=>e.id===r.eventId), currentUser)) || isMineByUmpire(r)));

    // --- Two-way sync, part 1: PRUNE stale local matches whose live_matches row is gone. Runs
    // unconditionally — independent of whether `mine` has anything to add/patch below. That
    // independence is the actual ghost-court fix: previously, `if(!mine.length) return` skipped
    // reconciliation entirely the instant ALL of a user's live matches were deleted remotely,
    // which is exactly the "Delete All Matches" scenario. Deliberately excludes "held" matches —
    // holdMatch/cancelAllMatchesForEvent already delete a held match's live_matches row on
    // purpose, so "held + absent remotely" is expected, not evidence of a remote deletion.
    const remoteIds=new Set(rows.map(r=>r.id));
    const isLocallyMine=m=>m.organizerId===currentUser.id || (m.organizerIds||[]).includes(currentUser.id)
      || (m.eventId && canControlEvent(cloudEvents.find(e=>e.id===m.eventId), currentUser)) || isMineByUmpire(m);
    const PRUNE_GRACE_MS=15000; // > the 10s poll cadence, so a just-started match (not yet
      // round-tripped into this particular remoteRows snapshot) is never mistaken for one
      // deleted elsewhere.
    const now=Date.now();
    const pruneIds=canPrune?new Set(
      matches.filter(m=>(m.status==="in_progress"||m.status==="paused")
        && isLocallyMine(m) && !remoteIds.has(m.id)
        && (now-new Date(m.createdAt||0).getTime())>PRUNE_GRACE_MS
      ).map(m=>m.id)
    ):new Set();
    if(pruneIds.size){
      Log.info("system","Cleared local live match(es) removed/ended remotely",{count:pruneIds.size});
      // Flip to "cancelled" (never spliced out) — the same terminal status cancelMatch/
      // cancelAllMatchesForEvent already use, so it drops out of liveMatches/heldMatches
      // (matches.filter(status==="in_progress"||"paused")) without ever landing in doneMatches
      // (only "completed" rows do), keeping the row as an audit trail like every other cancel path.
      setMatches(prevM=>prevM.map(m=>pruneIds.has(m.id)?{...m,status:"cancelled"}:m));
      setLiveStates(prevLS=>{
        const n={...prevLS}; let changed=false;
        pruneIds.forEach(id=>{ if(id in n){ delete n[id]; changed=true; } });
        return changed?n:prevLS;
      });
    }

    // --- Two-way sync, part 2: existing ADD/PATCH behavior, unchanged. ---
    if(!mine.length) return;
    // Last-write-wins conflict detection (Phase 20): a co-organizer on a different device can
    // legitimately push a newer score/status for a match I also have open. `ownerId` on the
    // remote row is whichever device pushed it last — if that's not me, and the score/status
    // differs from what I'm showing, someone else's write already won server-side; adopt it here
    // too and surface a toast instead of silently leaving my screen stuck on the losing value.
    // Collected here (outside setMatches) so the actual notify() call happens once, after state
    // commits, not from inside the updater.
    const conflicts=[];
    setMatches(prevM=>{
      const localMap=new Map(prevM.map(m=>[m.id,m]));
      const missing=mine.filter(r=>!localMap.has(r.id));
      // Patch organizer fields (always) and, on a detected conflict, score/status/winner too —
      // onto matches that already exist locally. Absent a conflict, score/status/history stay
      // purely locally-authoritative (see the comment above this function) so routine reconcile
      // ticks can never clobber an in-flight point.
      let organizersChanged=false;
      const patched=prevM.map(m=>{
        const r=mine.find(x=>x.id===m.id); if(!r) return m;
        const idsSame=JSON.stringify([...(r.organizerIds||[])].sort())===JSON.stringify([...(m.organizerIds||[])].sort());
        const namesSame=JSON.stringify(r.organizerNames||{})===JSON.stringify(m.organizerNames||{});
        const ownerSame=(r.organizerId||null)===(m.organizerId||null);

        const remoteWroteLast=r.ownerId && r.ownerId!==currentUser.id;
        const remoteStatus=r.status==="paused"?"paused":"in_progress";
        const scoreDiffers=(r.scoreA||0)!==(m.scoreA||0) || (r.scoreB||0)!==(m.scoreB||0) || remoteStatus!==m.status;
        const isConflict=remoteWroteLast && scoreDiffers && (m.status==="in_progress"||m.status==="paused");
        if(isConflict){
          conflicts.push({id:m.id,courtName:m.courtName,scoreA:r.scoreA||0,scoreB:r.scoreB||0,status:remoteStatus,winner:r.winner||null});
          // Our own pending debounced push (if any) was computed from the now-stale local score —
          // let it go, or it would silently re-overwrite the remote value we're about to adopt.
          if(liveWriteTimers.current[m.id]){ clearTimeout(liveWriteTimers.current[m.id]); liveWriteTimers.current[m.id]=null; }
        }

        if(idsSame&&namesSame&&ownerSame&&!isConflict) return m;
        if(!(idsSame&&namesSame&&ownerSame)) organizersChanged=true;
        return {...m,organizerId:r.organizerId||m.organizerId,organizerName:r.organizerName||m.organizerName,
          organizerIds:r.organizerIds||[],organizerNames:r.organizerNames||{},
          ...(isConflict?{scoreA:r.scoreA||0,scoreB:r.scoreB||0,status:remoteStatus,winner:r.winner||null}:{})};
      });
      if(!missing.length&&!organizersChanged&&!conflicts.length) return prevM;
      if(missing.length) Log.info("system","Restored in-progress match(es) from cloud (local copy was missing)",{count:missing.length});
      return [...missing.map(r=>({
        id:r.id, courtId:r.courtId, courtName:r.courtName, isDoubles:r.isDoubles, winTo:r.winTo,
        teamA:r.teamA, teamB:r.teamB, scoreA:r.scoreA||0, scoreB:r.scoreB||0,
        status:r.status==="paused"?"paused":"in_progress", winner:r.winner||null,
        category:r.category||null, location:r.location||null,
        organizerId:r.organizerId||null, organizerName:r.organizerName||null,
        organizerIds:r.organizerIds||[], organizerNames:r.organizerNames||{},
        date:r.date||today(), createdAt:r.updatedAt||new Date().toISOString(),
        // Carried through from the live_matches row (pushLive/buildLiveMatchRow already embeds
        // these) so a match picked up on a device that didn't create it — a co-organizer's
        // device, a second tab — doesn't regress name display to that device's own possibly-
        // lagging `players` roster lookup, and doesn't lose its Event association.
        playerNames:r.playerNames||undefined, eventId:r.eventId||null,
        teamALabel:r.teamALabel||undefined, teamBLabel:r.teamBLabel||undefined,
        teamACountry:r.teamACountry||undefined, teamAClub:r.teamAClub||undefined,
        teamBCountry:r.teamBCountry||undefined, teamBClub:r.teamBClub||undefined,
      })),...patched];
    });
    setLiveStates(prevLS=>{
      const missing=mine.filter(r=>!(r.id in prevLS));
      if(!missing.length && !conflicts.length) return prevLS;
      const add={};
      missing.forEach(r=>{ add[r.id]={ scoreA:r.scoreA||0, scoreB:r.scoreB||0, server:1, servingTeam:r.servingTeam||"A",
        history:[], isDoubles:r.isDoubles, winTo:r.winTo, status:r.status==="paused"?"paused":"in_progress",
        winner:r.winner||null, rally:0 }; });
      conflicts.forEach(c=>{
        if(!(c.id in prevLS)) return; // already covered by `add` above if it was also missing
        add[c.id]={...prevLS[c.id],scoreA:c.scoreA,scoreB:c.scoreB,status:c.status,winner:c.winner};
      });
      return {...prevLS,...add};
    });
    // Fire after both state updates are queued — never from inside a setState updater.
    conflicts.forEach(c=>notify((c.courtName?c.courtName+": ":"")+"Score updated by a co-organizer elsewhere","err"));
  };

  // Reuses the SAME shared/refcounted Realtime channel every other Live Match Board consumer
  // (HomeScreen's MyLiveStatusCard, LiveBoardScreen) already opens for live_matches/live_sessions
  // — calling useLiveBoard() here just increments that existing refcount, it does not open a
  // second subscription (see ISSUE about avoiding duplicate subscriptions). This is what makes
  // reconcileOwnLiveMatches run the instant a live_matches row changes (e.g. a co-organizer
  // invite gets accepted and the roster is patched in), not just on the 10s poll below.
  const {matches:liveBoardMatchesForReconcile,sessions:liveBoardSessions,hasLoadedOnce:liveBoardHasLoadedOnce}=useLiveBoard();
  // eslint-disable-next-line react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- mirrors an external realtime source into local state, the sanctioned use of an effect
  useEffect(()=>{ reconcileOwnLiveMatches(liveBoardMatchesForReconcile,liveBoardHasLoadedOnce); },[liveBoardMatchesForReconcile,liveBoardHasLoadedOnce]);
  // `remoteLive` used to be populated ONLY by the 10s Cloud.fetchLiveMatches() poll below, so a
  // match cancelled/deleted (e.g. via "Delete All Matches") on another organizer's device could
  // visibly linger on this one for up to ~10s. liveBoardMatchesForReconcile is the exact same
  // row shape (_mapLiveMatchRow) but already realtime — mirroring it into remoteLive here makes
  // every remoteLive consumer (CourtsScreen's "LIVE ELSEWHERE", CalendarScreen/EventDetailPanel's
  // matchesOf) update instantly, with zero changes to how those consumers read it. The poll stays
  // as-is as the boot/no-Realtime fallback.
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors an external realtime source into local state, the sanctioned use of an effect
  useEffect(()=>{ setRemoteLive(liveBoardMatchesForReconcile); },[liveBoardMatchesForReconcile]);
  // Global Courts tab's queue: same fix as CalendarScreen's event-queue (read the shared
  // live_sessions row instead of the purely-local matchQueue) so a co-organizer working from the
  // bottom-nav Courts tab — not just the Calendar → Event drill-down — sees the real queue too.
  // Falls back to my own local matchQueue when rosterOwnerId is just me (solo/legacy path).
  const globalQueue = rosterOwnerId===currentUser?.id ? matchQueue
    : ((liveBoardSessions||[]).find(s=>s.organizerId===rosterOwnerId)?.queue || matchQueue);

  // = Cloud sync: publish my profile, then pull the shared directory + friend requests =
  useEffect(()=>{
    if(!currentUser) return;
    Cloud.upsertProfile(currentUser);
    // Best-effort, once per login: pick up any guest/manual roster rows (on any organizer's
    // board) that match this account's verified email/phone, so match history/stats carry
    // forward instead of staying stuck under a guest entry.
    Cloud.autoLinkGuestsByContact(currentUser.id,{email:currentUser.email,phone:currentUser.phone});
  },[currentUser]);

  useEffect(()=>{
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets synced state when the source (cloud/login) turns off, not render-derived
    if(!Cloud.enabled || !currentUser){ syncRef.current=()=>Promise.resolve(); setRemoteLive([]); setUmpireAssignments([]); return; }
    let alive=true;
    const sync=async()=>{
      // Retry any match-completion writes that didn't confirm last time (see Outbox above,
      // endMatch below). Best-effort, never blocks the rest of the sync pass.
      Outbox.drain();
      try{
        const dir=await Cloud.fetchDirectory();
        // Overlay currentUser onto its own row before committing: this poll can resolve with
        // pre-edit server data if it was in flight when a local profile edit landed (upsertProfile
        // hadn't committed yet), which would otherwise regress the just-edited name/avatar back to
        // stale until the next tick. Every other row (everyone else) is untouched.
        if(alive) setDirectory(dir.map(d=>d.id===currentUser.id?{...d,...currentUser}:d));
        const reqs=await Cloud.fetchFriendRequests(currentUser.id);
        // Additive-only merge, like the attendees merge just below: a row present
        // locally but absent from this fetch might just be a write that hasn't
        // landed yet (Outbox retry pending, replication lag) rather than something
        // genuinely deleted remotely — pruning on `!f.remote` alone previously
        // deleted any row whose write silently failed, the moment this ran. Real
        // remote deletions are handled by realtime DELETE events instead.
        if(alive) setFriends(prev=>{
          const remoteIds=new Set(reqs.map(r=>r.id));
          const localOnly=prev.filter(f=>!remoteIds.has(f.id));
          return [...reqs,...localOnly];
        });
        const evs=await Cloud.fetchEvents();
        // Same fix as friends above — see that comment. This was the exact
        // mechanism that made a freshly-created Event vanish: createCloudEvent
        // stamped it remote:true (meaning "cloud sync is on", not "this insert
        // actually succeeded"), so a failed insert got silently pruned right here
        // on the very next sync pass.
        if(alive && evs) setCloudEvents(prev=>{
          const ids=new Set(evs.map(e=>e.id));
          const localOnly=prev.filter(e=>!ids.has(e.id));
          return [...evs,...localOnly];
        });
        const att=await Cloud.fetchAttendees();
        if(alive && att) setEventAtt(prev=>{
          // keep any locally-added rows (joins, +1 guests) not yet reflected in the cloud
          const keys=new Set(att.map(a=>a.eventId+"|"+a.userId));
          const localOnly=prev.filter(a=>!keys.has(a.eventId+"|"+a.userId));
          return [...att,...localOnly];
        });
        // My notification inbox (organizer invites, etc.) — cloud is the source of truth here,
        // same 10s cadence as everything else; this is how an added organizer's "you were added"
        // notification actually reaches them without a dedicated realtime channel.
        const notifs=await Cloud.fetchNotifications(currentUser.id);
        if(alive && notifs) setNotifications(notifs);
        const cls=await Cloud.fetchClubs();
        if(alive && cls) setClubs(prev=>{
          // Cloud clubs win; keep any local-only clubs not yet uploaded.
          const remoteIds=new Set(cls.map(c=>c.id));
          const localOnly=prev.filter(c=>!c.remote && !remoteIds.has(c.id));
          return [...cls,...localOnly];
        });
        const mtc=await Cloud.fetchMatches();
        if(alive && mtc){
          setMatches(prev=>{
            // Upsert by id — same fix as subscribeMatchesChanges above (this poll is that
            // realtime path's offline/fallback equivalent): an id already present locally as a
            // stale in_progress/paused ghost copy must be replaced by the authoritative completed
            // row from the shared history table, not skipped.
            const remoteMap=new Map(mtc.map(m=>[m.id,m]));
            const merged=prev.map(m=>remoteMap.has(m.id)?remoteMap.get(m.id):m);
            const localIds=new Set(prev.map(m=>m.id));
            const extra=mtc.filter(m=>!localIds.has(m.id));
            return [...merged,...extra];
          });
          setLiveStates(prev=>{
            const remoteIds=new Set(mtc.map(m=>m.id));
            const staleIds=Object.keys(prev).filter(id=>remoteIds.has(id));
            if(!staleIds.length) return prev;
            const n={...prev}; staleIds.forEach(id=>delete n[id]); return n;
          });
        }
        const msgs=await Cloud.fetchMessages();
        if(alive && msgs) setChatMsgs(msgs);
        const posts=await Cloud.fetchPosts();
        if(alive && posts) setFeedPosts(prev=>{
          const ids=new Set(posts.map(p=>p.id));
          const localOnly=prev.filter(p=>!p.remote && !ids.has(p.id));
          return [...localOnly,...posts];
        });
        // Live matches from other devices (read-only cards in the Live Match view)
        const live=await Cloud.fetchLiveMatches();
        if(alive && live){ setRemoteLive(live); reconcileOwnLiveMatches(live); }
        // Umpire assignments — fallback poll alongside the realtime subscription below (same
        // fast-path/fallback pattern as notifications/invites elsewhere in this effect), so a
        // missed realtime event (e.g. an assignment removed — the row no longer matches this
        // subscription's own filter once umpire_id changes, so Postgres never delivers that
        // particular UPDATE) still self-heals within one poll tick.
        const myUmpiring=await Cloud.fetchMyUmpireAssignments(currentUser.id);
        if(alive) setUmpireAssignments(myUmpiring);
        // Match/Event Organizer Invites — offline/missed-realtime fallback for the OWNER's own
        // devices (the fast path is subscribeMyOwnedMatchInvites below). Re-derives each of my
        // own currently-live matches'/events' organizerIds from whatever invites have reached
        // 'accepted', using the live_matches rows just fetched above (fresher than local state,
        // and works even if this device hasn't reconciled the match into local `matches` yet) —
        // cheap and idempotent, guarantees an acceptance is never permanently stuck just because
        // this device's realtime event was missed (app closed, etc.).
        const myLiveOwned=(live||[]).filter(r=>r.organizerId===currentUser.id && (r.status==="in_progress"||r.status==="paused"));
        myLiveOwned.filter(r=>!r.eventId).forEach(r=>Cloud.syncMatchOrganizersFromInvites(r.id));
        // Recompute organizer_ids for EVERY event I own, not just ones with a live match right
        // now — an event created and invited-to before any match exists had no fallback at all
        // before this, leaving acceptance stuck until my device happened to be online with a
        // realtime connection at the exact moment of accept (see subscribeMyOwnedMatchInvites).
        cloudEvents.filter(e=>e.ownerId===currentUser.id).forEach(e=>Cloud.syncEventOrganizersFromInvites(e.id));
        // Organizer's configured starting rating (cloud wins once fetched; local value is the
        // fallback used until this resolves, so a fresh boot never shows a wrong default).
        const rcfg=await Cloud.fetchRatingConfig(currentUser.id);
        if(alive && rcfg) setRatingConfig(prev=>({...prev,...rcfg}));
        // Mix & Match roster (manual + imported + added-registered players), Categories, Team
        // links, and Teams — fetched for MY OWN organizer_id, and ALSO for rosterOwnerId when
        // it currently points at a different Event owner (i.e. this device is actively working
        // inside a shared Event it doesn't own). This is the fix for "Organizer sees an empty
        // roster/categories/teams": these were always fetched (and written, see quickAddPlayer/
        // addCategory/addTeam/etc) under currentUser.id only, so a co-organizer's device could
        // never see the Event owner's actual data. Every id here (mixmatch_players.id, etc.) is
        // already a globally-unique uid(), so merging two organizers' rows together is safe —
        // still add-missing-by-id only, never overwriting an existing local row.
        const rosterScopeIds=[...new Set([currentUser.id, rosterOwnerIdRef.current].filter(Boolean))];
        for(const scopeId of rosterScopeIds){
          const mixPl=await Cloud.fetchMixPlayers(scopeId);
          if(alive && mixPl) setPlayers(prev=>{
            const localIds=new Set(prev.map(p=>p.id));
            const newOnes=mixPl.filter(p=>!localIds.has(p.id));
            return newOnes.length?[...prev,...newOnes]:prev;
          });
          // Player <-> Category links (many-to-many). Cloud wins for every player mixPl just
          // confirmed exists in this organizer's roster (covers additions/removals made on
          // another device); players not yet known to the cloud (upsert still in flight) are
          // left untouched so an optimistic local category assignment is never clobbered.
          const catLinks=await Cloud.fetchMixCategoryLinks(scopeId);
          if(alive && catLinks && mixPl){
            const knownIds=new Set(mixPl.map(p=>p.id));
            const catsByPlayer=new Map();
            knownIds.forEach(id=>catsByPlayer.set(id,[]));
            catLinks.forEach(l=>{ if(catsByPlayer.has(l.playerId)) catsByPlayer.get(l.playerId).push(l.categoryId); });
            setPlayers(prev=>prev.map(p=>knownIds.has(p.id)?{...p,categories:catsByPlayer.get(p.id)}:p));
          }
          // Categories + Teams + Courts (cloud wins; keep local-only ones not yet uploaded)
          const cats=await Cloud.fetchMixCategories(scopeId);
          if(alive && cats) setCategories(prev=>{
            const remoteIds=new Set(cats.map(c=>c.id));
            return [...cats,...prev.filter(c=>!remoteIds.has(c.id))];
          });
          const tms=await Cloud.fetchMixTeams(scopeId);
          if(alive && tms) setTeams(prev=>{
            const remoteIds=new Set(tms.map(t=>t.id));
            return [...tms,...prev.filter(t=>!remoteIds.has(t.id))];
          });
          const crts=await Cloud.fetchCourts(scopeId);
          if(alive && crts) setCourts(prev=>{
            const remoteIds=new Set(crts.map(c=>c.id));
            return [...crts,...prev.filter(c=>!remoteIds.has(c.id))];
          });
        }
      }catch(e){ Log.error("system","Cloud sync failed",{message:e?.message}); }
    };
    // Ensures only one sync() ever runs at a time — without this, the 10s poll below, a manual
    // pull-to-refresh, and a repeated swipe could all fire sync() concurrently (duplicate
    // requests). Also races sync() against a timeout so a single hung Supabase call can never
    // block pull-to-refresh's spinner forever (see withTimeout above) — sync()'s own try/catch
    // already resolves on any normal error, so the only real risk this guards against is a
    // request that never settles at all.
    const guardedSync = ()=>{
      if(syncInFlightRef.current) return Promise.resolve();
      syncInFlightRef.current=true;
      return withTimeout(sync(),15000,"cloud-sync").finally(()=>{ syncInFlightRef.current=false; });
    };
    syncRef.current = guardedSync;   // let pull-to-refresh trigger a data-only sync
    guardedSync();
    const t=setInterval(guardedSync,10000); // refresh every 10s
    // Instant notification delivery (ISSUE: "use Supabase Realtime" instead of only the 10s
    // poll above). Prepends on insert; the poll above stays as the fallback/reconciliation pass.
    let notifChannel=null, inviteChannel=null, eventsChannel=null, matchesChannel=null, umpireChannel=null;
    Cloud.subscribeMyNotifications(currentUser.id,(notif)=>{
      if(!alive) return;
      setNotifications(prev=> prev.some(n=>n.id===notif.id) ? prev : [notif,...prev]);
    }).then(ch=>{ if(alive) notifChannel=ch; else Cloud.removeChannel(ch); });
    // Instant event sync: an owner's title/date/location edit, or organizer_ids/organizer_names
    // updated the moment an invite is accepted (see syncEventOrganizersFromInvites), reaches
    // every other device immediately instead of waiting up to 10s for the poll below — this is
    // what makes a freshly-accepted co-organizer's full control (see canControlEvent) actually
    // arrive right away instead of looking permanently stuck.
    Cloud.subscribeEventsChanges((row,evtType)=>{
      if(!alive || !row) return;
      setCloudEvents(prev=>{
        if(evtType==="DELETE") return prev.filter(e=>e.id!==row.id);
        const exists=prev.some(e=>e.id===row.id);
        return exists ? prev.map(e=>e.id===row.id?row:e) : [row,...prev];
      });
    }).then(ch=>{ if(alive) eventsChannel=ch; else Cloud.removeChannel(ch); });
    // Lets THIS device (the match owner) react the instant one of its own sent invites is
    // accepted, recomputing that match's organizerIds from every accepted invite and pushing it
    // back to live_matches — which then reaches every other device (including the invitee's)
    // over the existing Live Match Board channel via reconcileOwnLiveMatches above.
    Cloud.subscribeMyOwnedMatchInvites(currentUser.id,(row)=>{
      if(!alive || !row || row.status!=="accepted") return;
      // Event-scoped invites (the common case now that New Match always belongs to an Event)
      // cascade to every match in the event; the legacy standalone-match path (no event_id,
      // e.g. the no-active-session "Manually Assign" shortcut) patches just that one match.
      if(row.event_id) Cloud.syncEventOrganizersFromInvites(row.event_id);
      else if(row.match_id) Cloud.syncMatchOrganizersFromInvites(row.match_id);
    }).then(ch=>{ if(alive) inviteChannel=ch; else Cloud.removeChannel(ch); });
    // Instant History delivery: a match finishing (endMatch's Outbox-enqueued upsertMatch) reaches
    // every connected viewer right away instead of waiting up to 10s for the poll below — this is
    // also what prevents a just-finished match from briefly vanishing from a Viewer's Event page
    // (already realtime-dropped from live_matches, not yet poll-fetched into history).
    Cloud.subscribeMatchesChanges((row)=>{
      if(!alive || !row) return;
      // Upsert by id: this table only ever gets a match's FINAL row once (INSERT-only), but that
      // id may already exist locally as a stale in_progress/paused ghost copy (synthesized by
      // reconcileOwnLiveMatches, or the match finishing on a different device first) — that ghost
      // must be replaced with the authoritative completed row, not silently dropped.
      setMatches(prev=> prev.some(m=>m.id===row.id) ? prev.map(m=>m.id===row.id?row:m) : [...prev,row]);
      setLiveStates(prev=>{
        if(!(row.id in prev)) return prev;
        const n={...prev}; delete n[row.id]; return n;
      });
    }).then(ch=>{ if(alive) matchesChannel=ch; else Cloud.removeChannel(ch); });
    // Instant umpire-assignment delivery: the moment an organizer assigns/reassigns/removes me
    // as umpire, this device's `matches` set (via reconcileOwnLiveMatches' isMineByUmpire above)
    // and the Tournaments screen's "Umpiring" list pick it up without waiting up to 10s.
    Cloud.subscribeMyUmpireAssignments(currentUser.id,(mapped,eventType)=>{
      if(!alive || !mapped) return;
      setUmpireAssignments(prev=>{
        if(eventType==="DELETE"||!mapped.umpireId) return prev.filter(m=>m.id!==mapped.id);
        const exists=prev.some(m=>m.id===mapped.id);
        return exists ? prev.map(m=>m.id===mapped.id?mapped:m) : [...prev,mapped];
      });
    }).then(ch=>{ if(alive) umpireChannel=ch; else Cloud.removeChannel(ch); });
    return ()=>{
      alive=false; clearInterval(t); syncRef.current=()=>Promise.resolve();
      Cloud.removeChannel(notifChannel); Cloud.removeChannel(inviteChannel); Cloud.removeChannel(eventsChannel); Cloud.removeChannel(matchesChannel); Cloud.removeChannel(umpireChannel);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[currentUser]);

  // = Device notifications: fire when new relevant things arrive (app open) =
  const notifSeed = useRef(false);
  const seenRef = useRef({fr:new Set(),jr:new Set(),go:new Set(),fp:new Set(),fa:new Set()});
  useEffect(()=>{
    if(!currentUser) return;
    const S=seenRef.current;
    const myId=currentUser.id;
    const incomingReq=friends.filter(f=>f.to===myId&&f.status==="pending").map(f=>f.id);
    const acceptedReq=friends.filter(f=>f.from===myId&&f.status==="accepted").map(f=>f.id);
    const myEventIds=new Set((cloudEvents||[]).filter(e=>e.ownerId===myId).map(e=>e.id));
    const joinReq=(eventAtt||[]).filter(a=>a.status==="pending"&&myEventIds.has(a.eventId)).map(a=>a.id||(a.eventId+"_"+a.userId));
    const myGoing=(eventAtt||[]).filter(a=>a.userId===myId&&a.status==="going"&&(a.playStatus||"confirmed")==="confirmed").map(a=>a.eventId);
    const feedIds=(feedPosts||[]).filter(p=>p.authorId!==myId).map(p=>p.id);

    if(!notifSeed.current){
      incomingReq.forEach(x=>S.fr.add(x)); joinReq.forEach(x=>S.jr.add(x));
      myGoing.forEach(x=>S.go.add(x)); feedIds.forEach(x=>S.fp.add(x)); acceptedReq.forEach(x=>S.fa.add(x));
      notifSeed.current=true; return;
    }
    incomingReq.forEach(x=>{ if(!S.fr.has(x)){ S.fr.add(x); Notify.show("New friend request 👋","Someone wants to connect on PickleLive.",{tag:"fr"}); }});
    acceptedReq.forEach(x=>{ if(!S.fa.has(x)){ S.fa.add(x); Notify.show("Friend request accepted 🤝","You have a new friend on PickleLive.",{tag:"fa"}); }});
    joinReq.forEach(x=>{ if(!S.jr.has(x)){ S.jr.add(x); Notify.show("New join request 🏓","A player asked to join your event.",{tag:"jr"}); }});
    myGoing.forEach(x=>{ if(!S.go.has(x)){ S.go.add(x); const ev=(cloudEvents||[]).find(e=>e.id===x); Notify.show("You're confirmed to play ✅",(ev?ev.title:"Your event")+".",{tag:"go"}); }});
    feedIds.forEach(x=>{ if(!S.fp.has(x)){ S.fp.add(x); const p=(feedPosts||[]).find(y=>y.id===x); Notify.show("New post in the feed 📣",(p?.clubName||p?.authorName||"Someone")+" shared something.",{tag:"fp"}); }});
  },[friends,eventAtt,cloudEvents,feedPosts,currentUser]);
  const openPanel = p=>setPanel(p);
  const closePanel= ()=>{ setPanel(null); setPresetCourtId(null); setForceEventId(null); };
  // Opens New Match pre-set to Manual Team Setup with a specific court already chosen — the
  // "Manually Assign" shortcut on an empty court card. Reuses the exact same MatchSetupModal /
  // startMatch pipeline as every other match-creation path; only the initial form state differs.
  const openManualAssign = courtId=>{ setPresetCourtId(courtId); setScreen("tournaments"); };
  // "+ Add Match" from inside an Event's management page — opens the same wizard but forced to
  // attach every match this session creates straight to that Event (see MatchSetupModal's
  // forceEventId prop), skipping the Event Name field and resolveOrCreateSessionEvent entirely.
  const openAddMatchToEvent = eventId=>{ setForceEventId(eventId); openPanel("setup"); };

  // Refs so effects subscribed once always see the latest state
  const currentUserRef=useRef(currentUser); useEffect(()=>{currentUserRef.current=currentUser;},[currentUser]);
  // hydrate() (boot/auth-listener path) and logIn() (explicit sign-in path) both independently
  // need "my accounts row, creating it if this is a genuinely new user" on a fresh sign-in — and
  // authSignIn() inside logIn() itself triggers the SIGNED_IN event that fires hydrate()
  // concurrently. Without dedup, both sides can race two Cloud.createAccount() calls for the
  // same new profile: one insert succeeds, the other's duplicate-key retry then fails (accounts'
  // column-level SELECT lockdown breaks that retry's upsert). Caching the in-flight promise per
  // auth user id means every concurrent caller awaits the SAME fetch-or-create and gets the same
  // resolved profile, instead of one of them erroring out or double-creating.
  const profileFetchRef=useRef(new Map());
  const ensureProfile=(authUserId)=>{
    if(profileFetchRef.current.has(authUserId)) return profileFetchRef.current.get(authUserId);
    // Server-authoritative resolve-or-create via the ensure_my_account() RPC (see cloud.js) —
    // replaces the old myAccount()+createAccount() dance, which fabricated an in-memory-only
    // placeholder profile even when the underlying insert silently failed (e.g. a pre-existing
    // legacy-id row sharing this email). undefined means the call itself failed (network/RPC
    // error) — callers must not fabricate a profile on that path.
    const p=Cloud.ensureMyAccount();
    profileFetchRef.current.set(authUserId,p);
    p.finally(()=>{ profileFetchRef.current.delete(authUserId); });
    return p;
  };
  const accountsRef=useRef(accounts); useEffect(()=>{accountsRef.current=accounts;},[accounts]);

  // Password-recovery flow: if the user opened the Supabase reset link, show the reset screen.
  const [recovery,setRecovery]=useState(false);
  const [recoveryErr,setRecoveryErr]=useState("");
  const recoveryRef=useRef(false);
  const authInit=useRef(false);
  const enterRecovery=()=>{ recoveryRef.current=true; setRecovery(true); };
  useEffect(()=>{
    if(!Cloud.enabled) return;
    let alive=true;
    const loc=(typeof window!=="undefined"&&window.location)?window.location:{href:"",hash:"",search:"",pathname:"/"};
    const url=loc.href||"";
    const isRecoveryUrl = isRecoveryLink(url) || isRecoveryLink(loc.pathname||"");
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time boot read of window.location, can't happen during render
    if(isRecoveryUrl) enterRecovery();

    // Load a profile from the accounts table for a signed-in auth user and enter the app.
    const hydrate=async(session,{recoveryMode=false}={})=>{
      if(!alive||!session||!session.user) return;
      if(recoveryMode||recoveryRef.current) return; // don't auto-login while resetting the password
      const authUser=session.user;
      const cur=currentUserRef.current;
      if(cur && cur.id===authUser.id) return; // already in
      // Own profile, including PII columns (accounts' direct column grant excludes those —
      // my_account() is the SECURITY DEFINER escape hatch for reading your own full row).
      // ensureProfile dedupes against a concurrent logIn() call for the same auth user — see
      // its declaration above.
      let profile=await ensureProfile(authUser.id);
      // undefined = the check itself failed (network/RPC error) — NOT "no profile exists".
      // Bail out without touching currentUser: creating a placeholder here would upsert-
      // overwrite a real, existing accounts row with blank data (see Cloud.createAccount's
      // duplicate-id branch). The auth listener retries on the next SIGNED_IN/TOKEN_REFRESHED.
      if(profile===undefined) return;
      if(profile.banned){ notify("This account has been suspended. Contact admin.","err"); Cloud.signOutAuth(); return; }
      setCurrentUser(profile);
      setAccounts(prev=> prev.find(a=>a.id===profile.id)?prev.map(a=>a.id===profile.id?{...a,...profile}:a):[...prev,profile]);
      setPlayers(prev=> prev.some(p=>p.id===profile.id||p.linkedUserId===profile.id)?prev:[...prev,{...profile}]);
      if(profile.role==="admin") setAdminMode(true);
    };

    const unsub=Cloud.onAuth((event,session)=>{
      if(!alive) return;
      if(event==="PASSWORD_RECOVERY"){ enterRecovery(); return; }
      if(event==="SIGNED_OUT"){
        // Supabase only fires this on a definitive session loss (explicit sign-out, or a refresh
        // attempt the server actually rejected) — never on a network blip, which it retries
        // instead. Safe to bounce a stale cached session back to Login here; logOut() already
        // clears currentUser itself before this fires, so this is a no-op on the explicit path.
        if(currentUserRef.current) setCurrentUser(null);
        return;
      }
      if(event==="SIGNED_IN"||event==="INITIAL_SESSION"||event==="TOKEN_REFRESHED"){
        hydrate(session,{recoveryMode:isRecoveryUrl});
      }
    });

    // If the URL carries recovery/confirmation tokens (?code=, #access_token, ?type=recovery),
    // establish the Supabase session from them, then either show reset or restore normal session.
    const hasTokens = /[?&]code=/.test(loc.search||"") || /access_token=/.test(loc.hash||"") || isRecoveryUrl;
    const boot=async()=>{
      if(hasTokens){
        const res=await Cloud.establishSessionFromUrl();
        if(!alive) return;
        if(res.recovery||isRecoveryUrl){
          enterRecovery();
          if(res.error) setRecoveryErr(res.error);
          authInit.current=true;
          return; // stay on the reset screen; do NOT hydrate into the app
        }
        if(res.error) setRecoveryErr("");
      }
      const s=await Cloud.getSession();
      if(!alive) return;
      authInit.current=true;
      if(s) hydrate(s,{recoveryMode:isRecoveryUrl});
    };
    boot();
    return ()=>{ alive=false; unsub(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  // Native Android: a tapped password-reset link arrives via Capacitor (App Links), not
  // window.location — the webview's own URL never becomes the emailed https:// link. Handle
  // both a cold start (getLaunchUrl) and the app already running in the background (appUrlOpen).
  useEffect(()=>{
    if(!Cloud.enabled || !Capacitor.isNativePlatform()) return;
    let alive=true;
    const handleDeepLink=async(url)=>{
      if(!alive || !url || !isRecoveryLink(url)) return;
      enterRecovery();
      const res=await Cloud.establishSessionFromUrl(url);
      if(!alive) return;
      if(res.error) setRecoveryErr(res.error);
    };
    CapacitorApp.getLaunchUrl().then(res=>{ if(res && res.url) handleDeepLink(res.url); }).catch(()=>{});
    const listenerHandle=CapacitorApp.addListener('appUrlOpen', ({url})=>{ handleDeepLink(url); });
    return ()=>{ alive=false; listenerHandle.then(l=>l.remove()).catch(()=>{}); };
  },[]);

  // = Auth handlers = (Supabase Auth is the single source of truth for credentials)
  const signUp = async ({name,username,email,password,hand,photo,age,sex,address,country,phone})=>{
    try {
      const emailClean=(email||"").trim().toLowerCase();
      const userClean=(username||"").trim();
      if(!Cloud.enabled) return {err:"Cloud isn't connected. Connect Supabase to create an account."};
      if(password && !isStrongPassword(password)) return {err:PASSWORD_HINT};

      // Pre-check username uniqueness against the profile table (email uniqueness is enforced by Auth).
      if(userClean){
        const existingEmail = await Cloud.resolveLogin(userClean);
        if(existingEmail){ return {err:"That username is already taken."}; }
      }

      // 1) Create the Supabase Auth user FIRST.
      const auth = await Cloud.authSignUp(emailClean, password);
      if(!auth.ok) return {err:auth.error||"Couldn't create the account."};

      // 2) Insert the profile keyed by the Auth user id.
      const acc={id:auth.userId,name:name.trim(),username:userClean||null,email:emailClean,hand:hand||"Right",
        photo:photo||null,joinDate:today(),role:"player",banned:false,
        singlesRating:RatingEngine.BASE,doublesRating:RatingEngine.BASE,wins:0,losses:0,
        age:age||null,sex:sex||null,address:address||null,country:country||null,phone:phone||null};

      // If email confirmation is required, there's no session yet — accounts_insert's RLS check
      // (id = auth.uid()) can never pass pre-confirmation, so don't even attempt the insert here.
      // hydrate()'s auto-create-profile fallback creates this same row once the user confirms and
      // signs in for real (a session exists by then), so nothing is lost by deferring it.
      if(!auth.session){
        Log.success("auth","Account created (confirmation required)",{email:emailClean});
        return {ok:true, confirm:true};
      }

      const r = await Cloud.createAccount(acc);
      if(!r.ok){
        // Duplicate username → clean rollback (the auth user shouldn't linger).
        if(r.err && /duplicate|unique|conflict/i.test(r.err) && /username/i.test(r.err)){
          await Cloud.authDeleteCurrent();
          return {err:"That username is already taken."};
        }
        // Any other insert failure is almost always an RLS policy blocking the write.
        // The Auth user already exists, so DON'T delete it — surface a precise, actionable error
        // and let the auth-state listener create the profile on next sign-in once policies allow it.
        const detail = readErr(r.err,"");
        Log.error("auth","Profile insert failed (auth user kept)",{message:detail});
        const isRLS = /row-level security|rls|policy|permission|denied|not authorized|violates/i.test(detail);
        return {err: isRLS
          ? "Your login was created, but the profile couldn't be saved right now. Try signing in — it'll finish setting up automatically."
          : ("Couldn't save your profile"+(detail?(": "+detail):".")+" Please try again.")};
      }

      setAccounts(prev=>[...prev.filter(a=>a.id!==acc.id),acc]);
      setPlayers(prev=> prev.some(p=>p.linkedUserId===acc.id) ? prev.filter(p=>p.id!==acc.id) : [...prev.filter(p=>p.id!==acc.id),{...acc}]);
      setCurrentUser(acc);
      Log.success("auth","Account created",{actor:acc.name,email:acc.email});
      notify("Welcome to PickleLive! 🎾");
      return {ok:true};
    } catch(e) {
      Log.error("auth","Sign up error",{message:e?.message});
      return {err:"Sign up failed. Please try again."};
    }
  };

  // Login: resolve username→email locally/cloud, then sign in ONLY via Supabase Auth.
  const logIn = async ({identifier,password})=>{
    try {
      const idRaw   = (identifier||"").trim();
      const idClean = idRaw.toLowerCase();
      const passClean = (password||"").trim();
      const isEmail = idRaw.includes("@");

      if(!Cloud.enabled) return {err:"Cloud isn't connected. Connect Supabase to sign in."};

      // Resolve the email to authenticate with (username lookups go through the resolve_login()
      // RPC so they work pre-session, without a permissive SELECT policy on accounts).
      let email = isEmail ? idClean : null;
      if(!isEmail){
        email = await Cloud.resolveLogin(idRaw);
        if(!email) return {err:"Invalid username/email or password."};
        email = email.toLowerCase();
      }

      // Sign in with Supabase Auth.
      const auth = await Cloud.authSignIn(email, passClean);
      if(!auth.ok) return {err:auth.error||"Invalid username/email or password."};

      // Load the profile (own row, including PII — see hydrate()'s comment on my_account()).
      // ensureProfile dedupes against the SIGNED_IN event this authSignIn() triggers, which
      // fires hydrate() concurrently — see its declaration above.
      let profile = await ensureProfile(auth.userId);
      // undefined = the check itself failed — don't fabricate/overwrite a real profile with
      // placeholder data on a transient error (same reasoning as hydrate() above).
      if(profile===undefined) return {err:"Couldn't load your profile. Please try again."};
      if(profile.banned) return {err:"This account has been suspended. Contact admin."};

      setCurrentUser(profile);
      setAccounts(prev=> prev.find(a=>a.id===profile.id) ? prev.map(a=>a.id===profile.id?{...a,...profile}:a) : [...prev,profile]);
      setPlayers(prev=> prev.some(p=>p.id===profile.id||p.linkedUserId===profile.id) ? prev.filter(p=>p.id!==profile.id) : [...prev,{...profile}]);
      if(profile.role==="admin") setAdminMode(true);
      Log.success("auth","Logged in",{actor:profile.name,role:profile.role});
      notify(profile.role==="admin"?"Welcome, Admin! ⭐":"Welcome back, "+profile.name+"! 🏓");
      return {ok:true};
    } catch(e) {
      Log.error("auth","Login error",{message:e?.message});
      return {err:"Login failed. Please try again."};
    }
  };

  // Forgot password → send Supabase recovery email (works for every registered auth user).
  const sendPasswordReset = async (email)=>{
    const emailClean=(email||"").trim().toLowerCase();
    if(!emailClean||!emailClean.includes("@")) return {sent:false, error:"Please enter a valid email address."};
    return await Cloud.sendPasswordReset(emailClean);
  };
  // Reset password page → update the password in Supabase Auth (from the recovery session).
  const completePasswordReset = async (newPassword)=>{
    if(!newPassword || !isStrongPassword(newPassword)) return {err:PASSWORD_HINT};
    const r = await Cloud.updatePasswordFromRecovery(newPassword);
    if(!r || !r.ok) return {err:(r&&r.error)||"Couldn't update the password."};
    Cloud.signOutAuth();
    Log.event("auth","Password reset completed",{email:r.email||""});
    return {ok:true};
  };
  const logOut = ()=>{Log.event("auth","Logged out",{actor:currentUser?.name});setCurrentUser(null);setAdminMode(false);setScreen("home");setActiveMatchId(null);Cloud.signOutAuth();notify("Logged out");};
  // Change password while signed in → Supabase Auth updateUser.
  const changePassword = async (newPassword)=>{
    if(!currentUser) return {err:"You're not signed in."};
    if(!newPassword || !isStrongPassword(newPassword)) return {err:PASSWORD_HINT};
    if(!Cloud.enabled) return {err:"Cloud isn't connected."};
    const r = await Cloud.updatePassword(newPassword);
    if(!r.ok) return {err:r.error||"Couldn't update the password."};
    Log.event("auth","Password changed",{actor:currentUser?.name});
    return {ok:true};
  };
  const deleteAccount = ()=>{
    try{
      const id=currentUser?.id;
      Log.warn("auth","Account deleted",{actor:currentUser?.name});
      setAccounts(prev=>prev.filter(a=>a.id!==id));
      setPlayers(prev=>prev.filter(p=>p.id!==id));
      if(Cloud.enabled && id) Cloud.deleteAccountRow(id);
      Cloud.signOutAuth();
      setCurrentUser(null);
      setAdminMode(false);
      notify("Account deleted");
    }catch(e){Log.error("auth","Account deletion failed",{message:e?.message});notify("Failed to delete account","err");}
  };
  const updateProfile = async patch=>{
    const id=currentUser.id;
    setCurrentUser(u=>({...u,...patch}));
    setAccounts(prev=>prev.map(a=>a.id===id?{...a,...patch}:a));
    setPlayers(prev=>prev.map(p=>p.id===id?{...p,...patch}:p));
    // directory[] is otherwise only ever refreshed by the 10s cloud poll below — without this,
    // any view reading "me" from directory (e.g. viewing your own profile via a leaderboard/
    // player-card click before you have a players[] row) stays stale for up to 10s after an edit.
    setDirectory(prev=>prev.map(d=>d.id===id?{...d,...patch}:d));
    // Persist to the accounts row itself — this is what hydrate()/logIn() read back on every
    // fresh session, so without this write the edit above only ever lives in local state/
    // localStorage and silently reverts the next time the app has to re-fetch from Supabase.
    const r=await Cloud.updateAccount(id,patch);
    if(!r.ok){ notify("Couldn't save your profile"+(r.err?": "+r.err:". Try again."),"err"); return; }
    Log.event("auth","Profile updated",{actor:currentUser?.name,fields:Object.keys(patch||{})});
    notify("Profile updated ✓");
  };

  // = Players =
  // Quick add used from within the New Match / Match Setup flow: pushes a temporary
  // event player (name + optional rating) without navigating away from Match Setup.
  const quickAddPlayer = (name,rating)=>{
    const nm=(name||"Player").trim()||"Player";
    const r=clamp(parseFloat(rating)||RatingEngine.BASE,2,8);
    const np={id:uid(),name:nm,hand:"Right",gender:"",rating:r,
      singlesRating:r,doublesRating:r,
      wins:0,losses:0,email:"",phone:"",photo:null,joinDate:today(),role:"player",banned:false,source:"manual"};
    setPlayers(p=>[...p,np]);
    Outbox.enqueue("upsertMixPlayer",{player:np,organizerId:rosterOwnerId});
    Log.event("player","Player added",{actor:currentUser?.name,target:nm});
    notify(nm+" added");
    return np;
  };
  // Convention: endMatch() is the ONLY code path that automatically mutates rating/wins/losses
  // (via RatingEngine, after a completed match). updPlayer is the organizer's manual-override
  // path (Admin/PlayerEditPanel) — intentionally still allowed, since that's deliberate organizer
  // control, not automatic drift. Don't add a second automatic mutator elsewhere.
  const updPlayer  = (id,patch)=>{
    const prev=players.find(x=>x.id===id);
    setPlayers(p=>p.map(x=>x.id===id?{...x,...patch}:x));
    if(prev) Outbox.enqueue("upsertMixPlayer",{player:{...prev,...patch},organizerId:rosterOwnerId});
    if(patch.categories && prev){
      const before=new Set(prev.categories||[]);
      const after=new Set(patch.categories||[]);
      after.forEach(cid=>{ if(!before.has(cid)) Cloud.addCategoryPlayer(cid,id,rosterOwnerId); });
      before.forEach(cid=>{ if(!after.has(cid)) Cloud.removeCategoryPlayer(cid,id); });
    }
  };
  const delPlayer  = id=>{const nm=players.find(x=>x.id===id)?.name;Log.warn("player","Player removed",{actor:currentUser?.name,target:nm});setPlayers(p=>p.filter(x=>x.id!==id));Cloud.deleteMixPlayer(id);notify("Player removed");};
  // Manual "Submit to DUPR" trigger (History/ScoringScreen). Routed through Outbox for the
  // same durability the automatic post-endMatch path gets — see OUTBOX_HANDLERS.submitDuprMatch
  // in cloud.js and src/lib/dupr.js.
  const submitMatchToDupr = (matchId)=>{ Outbox.enqueue("submitDuprMatch",{matchId}); Outbox.drain(); };
  // Organizer-configurable default starting rating (Admin → Ratings tab).
  const updateRatingConfig = (patch)=>{
    const next={...ratingConfig,...patch};
    setRatingConfig(next);
    Cloud.upsertRatingConfig(currentUser?.id, next);
    Log.event("admin","Rating config updated",{actor:currentUser?.name,baseRating:next.baseRating});
    notify("Rating settings saved");
  };
  const banPlayer  = id=>{const nm=players.find(x=>x.id===id)?.name;updPlayer(id,{banned:true});Log.warn("admin","Player banned",{actor:currentUser?.name,target:nm});notify("Player banned");};
  const unbanPlayer= id=>{const nm=players.find(x=>x.id===id)?.name;updPlayer(id,{banned:false});Log.event("admin","Player unbanned",{actor:currentUser?.name,target:nm});notify("Player unbanned");};
  const importPlayers=(list,mode)=>{
    // Resolve any "category" column from the spreadsheet (case-insensitive name match),
    // auto-creating categories that don't exist yet. Rows without a category are untouched.
    let knownCats=categories; const newCats=[];
    const stripCatName=p=>{ const clean={...p}; delete clean.catName; return clean; };
    const resolved=list.map(p=>{
      if(!p.catName) return stripCatName(p);
      let cat=knownCats.find(c=>c.name.toLowerCase()===p.catName.toLowerCase());
      if(!cat){ cat={id:uid(),name:p.catName,color:D.accent}; knownCats=[...knownCats,cat]; newCats.push(cat); }
      return {...stripCatName(p),categories:[cat.id]};
    });
    if(newCats.length){
      setCategories(prev=>[...prev,...newCats]);
      newCats.forEach(cat=>Cloud.upsertMixCategory(cat,rosterOwnerId));
    }
    setPlayers(prev=>mode==="replace"?resolved:[...prev,...resolved]);
    resolved.forEach(p=>Outbox.enqueue("upsertMixPlayer",{player:p,organizerId:rosterOwnerId}));
    resolved.forEach(p=>(p.categories||[]).forEach(cid=>Cloud.addCategoryPlayer(cid,p.id,rosterOwnerId)));
    Log.success("player","Players imported",{actor:currentUser?.name,count:resolved.length,mode});
    notify(`${resolved.length} players imported`);
  };
  // Add a registered (directory) user to this organizer's roster without duplicating them.
  const addRegisteredPlayer = id=>{
    if(players.find(p=>p.id===id)){ notify("Already in your roster"); return; }
    const reg=directory.find(d=>d.id===id);
    if(!reg){ notify("Player not found","err"); return; }
    const np={...reg,source:"registered",linkedUserId:id,banned:!!reg.banned};
    setPlayers(p=>[...p,np]);
    Outbox.enqueue("upsertMixPlayer",{player:np,organizerId:rosterOwnerId});
    Log.event("player","Registered user added to roster",{actor:currentUser?.name,target:reg.name});
    notify(reg.name+" added to roster");
  };
  // Link an existing guest/manual/imported roster row to a real registered account so their
  // history (rating, wins, losses, categories, teams, match history — all keyed by this row's
  // own id) carries forward with zero duplication. The row's id is never changed; only
  // linkedUserId/source are set on the same row, so nothing referencing it needs to move.
  const linkPlayerToAccount = (guestPlayerId, accountId)=>{
    const guest=players.find(p=>p.id===guestPlayerId);
    if(!guest){ notify("Player not found","err"); return; }
    const acc=directory.find(d=>d.id===accountId);
    if(!acc){ notify("Account not found","err"); return; }
    const merged={...guest, linkedUserId:accountId, source:"registered",
      email:guest.email||acc.email, photo:guest.photo||acc.photo};
    setPlayers(prev=>prev.filter(p=>p.id!==accountId).map(p=>p.id===guestPlayerId?merged:p));
    Cloud.upsertMixPlayer(merged,rosterOwnerId);
    Cloud.deleteMixPlayer(accountId); // best-effort cleanup of any pre-existing duplicate row; no-op if none exists
    Log.event("player","Guest linked to registered account",{actor:currentUser?.name,target:merged.name});
    notify(merged.name+" linked to their account");
  };

  // = Player Categories (organizer-scoped; used to filter Mix & Match) =
  const addCategory = (name)=>{
    const cat={id:uid(),name:(name||"New Category").trim()||"New Category",color:D.accent};
    setCategories(c=>[...c,cat]);
    Cloud.upsertMixCategory(cat,rosterOwnerId);
    return cat;
  };
  const renameCategory = (id,name)=>{
    setCategories(c=>c.map(x=>x.id===id?{...x,name}:x));
    const cat=categories.find(x=>x.id===id);
    if(cat) Cloud.upsertMixCategory({...cat,name},rosterOwnerId);
  };
  const recolorCategory = (id,color)=>{
    setCategories(c=>c.map(x=>x.id===id?{...x,color}:x));
    const cat=categories.find(x=>x.id===id);
    if(cat) Cloud.upsertMixCategory({...cat,color},rosterOwnerId);
  };
  const deleteCategory = (id)=>{
    setCategories(c=>c.filter(x=>x.id!==id));
    setPlayers(prev=>prev.map(p=>(p.categories||[]).includes(id)?{...p,categories:p.categories.filter(c=>c!==id)}:p));
    Cloud.deleteMixCategory(id); // FK ON DELETE CASCADE removes matching mixmatch_category_players rows server-side
  };

  // = Category <-> Player memberships (many-to-many join) =
  const addPlayersToCategory = (categoryId, playerIds)=>{
    if(!categoryId || !playerIds?.length) return;
    setPlayers(prev=>prev.map(p=>playerIds.includes(p.id) && !(p.categories||[]).includes(categoryId)
      ? {...p,categories:[...(p.categories||[]),categoryId]} : p));
    playerIds.forEach(pid=>Cloud.addCategoryPlayer(categoryId,pid,rosterOwnerId));
  };
  const removePlayerFromCategory = (categoryId, playerId)=>{
    setPlayers(prev=>prev.map(p=>p.id===playerId?{...p,categories:(p.categories||[]).filter(c=>c!==categoryId)}:p));
    Cloud.removeCategoryPlayer(categoryId, playerId);
  };
  const setCategoryMembers = (categoryId, selectedPlayerIds)=>{
    const currentMembers=players.filter(p=>(p.categories||[]).includes(categoryId)).map(p=>p.id);
    const toAdd=selectedPlayerIds.filter(id=>!currentMembers.includes(id));
    const toRemove=currentMembers.filter(id=>!selectedPlayerIds.includes(id));
    if(toAdd.length) addPlayersToCategory(categoryId, toAdd);
    toRemove.forEach(id=>removePlayerFromCategory(categoryId, id));
    notify(selectedPlayerIds.length+" player"+(selectedPlayerIds.length!==1?"s":"")+" in category");
  };

  // = Organizer Teams (tournament-style grouping; distinct from in-match Team A/B) =
  const addTeam = (name)=>{
    const team={id:uid(),name:(name||"New Team").trim()||"New Team",color:D.blue,logo:null};
    setTeams(t=>[...t,team]);
    Cloud.upsertMixTeam(team,rosterOwnerId);
    return team;
  };
  const renameTeam = (id,name)=>{
    setTeams(t=>t.map(x=>x.id===id?{...x,name}:x));
    const team=teams.find(x=>x.id===id);
    if(team) Cloud.upsertMixTeam({...team,name},rosterOwnerId);
  };
  const recolorTeam = (id,color)=>{
    setTeams(t=>t.map(x=>x.id===id?{...x,color}:x));
    const team=teams.find(x=>x.id===id);
    if(team) Cloud.upsertMixTeam({...team,color},rosterOwnerId);
  };
  const setTeamLogo = (id,logo)=>{
    setTeams(t=>t.map(x=>x.id===id?{...x,logo}:x));
    const team=teams.find(x=>x.id===id);
    if(team) Cloud.upsertMixTeam({...team,logo},rosterOwnerId);
  };
  const deleteTeam = (id)=>{
    setTeams(t=>t.filter(x=>x.id!==id));
    setPlayers(prev=>prev.map(p=>p.teamId===id?{...p,teamId:null}:p));
    Cloud.deleteMixTeam(id);
  };

  // = Courts — previously 100% local (no Cloud sync existed at all); same organizer-scoped
  // shared pattern as Teams/Categories above, so an accepted co-organizer's device now sees
  // and can edit the Event owner's actual court list instead of its own local defaults. =
  const COURT_COLORS=[D.blue,D.green,D.amber,D.purple,D.accent,D.teal];
  const addCourt = ()=>{
    const court={id:uid(),name:"Court "+(courts.length+1),color:COURT_COLORS[courts.length%COURT_COLORS.length],active:true};
    setCourts(c=>[...c,court]);
    Cloud.upsertCourt(court,rosterOwnerId);
    return court;
  };
  const renameCourt = (id,name)=>{
    setCourts(c=>c.map(x=>x.id===id?{...x,name}:x));
    const court=courts.find(x=>x.id===id);
    if(court) Cloud.upsertCourt({...court,name},rosterOwnerId);
  };
  const recolorCourt = (id,color)=>{
    setCourts(c=>c.map(x=>x.id===id?{...x,color}:x));
    const court=courts.find(x=>x.id===id);
    if(court) Cloud.upsertCourt({...court,color},rosterOwnerId);
  };
  const toggleCourtActive = (id,active)=>{
    setCourts(c=>c.map(x=>x.id===id?{...x,active}:x));
    const court=courts.find(x=>x.id===id);
    if(court) Cloud.upsertCourt({...court,active},rosterOwnerId);
  };
  const deleteCourt = (id)=>{
    setCourts(c=>c.filter(x=>x.id!==id));
    Cloud.deleteCourt(id);
  };

  // = Matches =
  // Build the cloud payload for a live match (best-effort, never blocks the UI).
  // Extracted so startMatch's initial push (see below) can route the exact same
  // row through a durable Outbox write instead of pushLive's best-effort one,
  // without duplicating this whole object literal.
  const buildLiveMatchRow = (m,st) => ({
      id:m.id, courtId:m.courtId, courtName:m.courtName, isDoubles:!!m.isDoubles, winTo:m.winTo,
      status:st?.status||"in_progress", scoreA:st?.scoreA||0, scoreB:st?.scoreB||0,
      servingTeam:st?.servingTeam||"A", winner:st?.winner||null,
      // Tournament-only best-of-N fields (see lib/scoring.js) — undefined/1 for every
      // casual match, so consumers that don't know about them simply never see them.
      bestOf:st?.bestOf&&st.bestOf>1?st.bestOf:undefined,
      games:st?.games?.length?st.games:undefined,
      gameNumber:st?.bestOf>1?st.gameNumber:undefined,
      gamesWonA:st?.bestOf>1?st.gamesWonA:undefined,
      gamesWonB:st?.bestOf>1?st.gamesWonB:undefined,
      // Tournament bridge (see startTournamentMatch) — undefined for every casual match, so
      // LiveBoardScreen/the external scoreboard fall back to plain display when absent.
      // tournamentMatchId is REQUIRED here, not just informational: the live_matches_insert/
      // update RLS policies (migration 127) grant the assigned umpire write access by looking
      // up data->>'tournamentMatchId' — if it's missing from this row, an umpire whose own id
      // isn't also the tournament's organizerId gets a bare RLS violation on every write for
      // their own match (reproduced live: INSERT into live_matches errored 42501 for the
      // umpire despite a correct assignment, because this field was never being sent).
      tournamentMatchId:m.tournamentMatchId||undefined,
      tournamentId:m.tournamentId||undefined, tournamentName:m.tournamentName||undefined,
      tournamentLogo:m.tournamentLogo||undefined, divisionName:m.divisionName||undefined,
      tournamentRound:m.tournamentRound||undefined,
      // Scoreboard elapsed-time display — set once at match start, undefined for nothing (every
      // match has a createdAt), so this is the one new field that reaches casual matches too.
      matchStartedAt:m.createdAt||undefined,
      // Optional per-team Country/Club (from tournament registrations) — absent for every
      // casual match and every registration that didn't set them.
      teamACountry:m.teamACountry||undefined, teamBCountry:m.teamBCountry||undefined,
      teamAClub:m.teamAClub||undefined, teamBClub:m.teamBClub||undefined,
      category:m.category||null,
      teamA:m.teamA, teamB:m.teamB,
      // m.teamALabel/teamBLabel/playerNames win when explicitly provided (startTournamentMatch
      // passes them precomputed from the registration it just read — a brand-new guest player
      // added to the roster in this same tick isn't reliably visible yet through the `players`
      // closure below, since React hasn't re-rendered between the setPlayers call and this one).
      // Every other caller never sets these on `m`, so they fall back to today's lookup unchanged.
      teamALabel:m.teamALabel||teamLabel(players,m.teamA), teamBLabel:m.teamBLabel||teamLabel(players,m.teamB),
      // Per-player name resolution so a spectator/player on a DIFFERENT organizer's roster can
      // still resolve "my partner"/"my opponents" by id on the Live Match Board / personal
      // status card — teamALabel/teamBLabel above are team-level strings only.
      playerNames:m.playerNames||Object.fromEntries([...(m.teamA||[]),...(m.teamB||[])].map(id=>[id,nameOf(players,id)])),
      // ownerId/ownerName above = which device/session is pushing this row (used for Live Board
      // grouping + "LIVE ELSEWHERE" dedup). organizerId/organizerIds below is a DIFFERENT concept —
      // the match's actual owner/co-organizers (who's allowed to control it) — carried through so
      // reconcileOwnLiveMatches can pull this match onto a co-organizer's OWN device.
      ownerId:currentUser?.id||null, ownerName:currentUser?.name||null,
      organizerId:m.organizerId||null, organizerName:m.organizerName||null,
      organizerIds:m.organizerIds||[], organizerNames:m.organizerNames||{},
      // See tournamentMatchId comment above — same reason, same fix, for the umpire-recognition
      // half of the story rather than the RLS-write half.
      umpireId:m.umpireId||undefined,
      // Which Calendar Event this match belongs to (null for the rare no-active-session
      // "Manually Assign" case) — this is what lets an Event's embedded Courts view, and
      // syncEventOrganizersFromInvites' bulk patch, find every match that's part of it.
      eventId:m.eventId||null,
      date:m.date||null, location:m.location||null,
  });
  const pushLive = (m,st)=>{
    if(!m) return;
    // Cancel any pending debounced write for this match FIRST. Without this, the winning point's
    // immediate "completed" push races the still-armed timer from the previous point (scheduled by
    // pushLiveDebounced ~600ms earlier): that stale timer fires ~200ms AFTER this push and
    // overwrites the completed row with the one-point-behind in_progress score — which is exactly
    // what every other viewer then sees. Reproduced live before this fix.
    if(liveWriteTimers.current[m.id]){ clearTimeout(liveWriteTimers.current[m.id]); liveWriteTimers.current[m.id]=null; }
    // Outboxed (was a direct fire-and-forget Cloud call) — this is every point-by-point
    // score/status write for every live match, tournament or casual. A lost write here
    // during a network drop used to be silently indistinguishable from "no score change
    // happened," with zero retry — the one gap "offline support" (umpire assignment)
    // actually depends on. pushLiveDebounced's existing 600ms coalescing means this is
    // one outbox item per settled score change, not one per tap, so it doesn't flood
    // the queue. Full-row upserts, so replaying several queued snapshots in order after
    // a reconnect still converges correctly on the last (truest) one.
    Outbox.enqueue("upsertLiveMatch",{match:buildLiveMatchRow(m,st)});
    Outbox.drain();
  };
  // Live Match Board: push this organizer's session-level metadata (event name, round, waiting
  // queue, sitting-out players) so every logged-in user can see it on the board / resolve their
  // own status. Best-effort, never blocks the UI. `patch` overrides individual fields (e.g. just
  // `{sittingOut}` from Mix & Match generation, or `{queue}` after startMixSession queues extras).
  const syncLiveSession = (patch={})=>{
    if(!currentUser) return;
    // When this session is backed by a real Calendar Event, show its actual title on the Live
    // Match Board instead of the generic "X's Session" placeholder — same field, just resolved
    // from the Event once one exists.
    const activeEvent=activeEventId?cloudEvents.find(e=>e.id===activeEventId):null;
    const base={
      organizerId:currentUser.id, organizerName:currentUser.name,
      eventName:activeEvent?.title||(currentUser.name+"'s Session"), eventId:activeEventId||null, round:liveRound,
      queue:matchQueue, sittingOut:[], playerNames:{},
    };
    const session={...base,...patch};
    Cloud.upsertLiveSession(currentUser.id, session);
  };
  // After a match ends/cancels, either sync the organizer's session (a live/paused match or a
  // queued one remains) or delete it entirely (nothing left — the session is over).
  const refreshLiveSessionAfter = (matchId,remainingQueue)=>{
    if(!currentUser) return;
    const stillActive=matches.some(m=>m.id!==matchId && (m.status==="in_progress"||m.status==="paused"));
    if(!stillActive && !(remainingQueue||[]).length){
      Cloud.deleteLiveSession(currentUser.id);
      setLiveRound(1);
      // Nothing left running or queued — this session is over. The Event itself is a permanent
      // calendar record and is NOT touched, but the next New Match (even later the same day)
      // should start a fresh one rather than silently continuing to attach to this one.
      setActiveEventId(null);
    } else {
      syncLiveSession({queue:remainingQueue||[]});
    }
  };
  // Debounced live-score push so a burst of points doesn't hammer the network.
  const pushLiveDebounced = (m,st)=>{
    if(!m) return;
    const id=m.id;
    if(liveWriteTimers.current[id]) clearTimeout(liveWriteTimers.current[id]);
    liveWriteTimers.current[id]=setTimeout(()=>{ liveWriteTimers.current[id]=null; pushLive(m,st); },600);
  };

  const startMatch = (setup,opts={})=>{
    const {navigate=true}=opts;
    if(!isValidMatchup(setup.teamA, setup.teamB)){
      Log.error("match","Blocked match: invalid matchup (self-match or duplicate player)",{teamA:setup.teamA,teamB:setup.teamB});
      notify("Can't start match — a player can't play against themselves","err");
      return null;
    }
    // A match belonging to an Event inherits that Event's CURRENT accepted co-organizer roster
    // directly (organizer invites for event-backed matches are created ONCE, at event-creation
    // time — see inviteEventOrganizers/resolveOrCreateSessionEvent — not per match), so every
    // match created after an invite is accepted already carries that access with zero extra
    // invite traffic. A match with no Event (the legacy standalone path, e.g. the
    // no-active-session "Manually Assign" shortcut) keeps the original per-match behavior below:
    // starts empty, grows only once its OWN invite is accepted.
    const ownerEvent=setup.eventId?cloudEvents.find(e=>e.id===setup.eventId):null;
    const m={id:uid(),...setup,scoreA:0,scoreB:0,status:"in_progress",winner:null,
      // A provided setup.date (New Match's Date field) wins; otherwise defaults to today, same
      // as before this field existed. Organizer defaults to whoever created the match unless a
      // different registered account was explicitly assigned via the Organizer picker.
      date:setup.date||today(),createdAt:new Date().toISOString(),
      organizerId:setup.organizerId||currentUser?.id, organizerName:setup.organizerName||currentUser?.name,
      organizerIds:ownerEvent?(ownerEvent.organizerIds||[]):[],
      organizerNames:ownerEvent?(ownerEvent.organizerNames||{}):{},
      // Optional link to a calendar event (events table). Nullable — a match created with no
      // active session (e.g. a quick "Manually Assign") stays standalone, same as before this
      // feature existed.
      eventId:setup.eventId||null};
    const shareToken="pl_"+uid();
    const st=newMatchState(m);
    setMatches(prev=>[m,...prev]);
    setShareTokens(prev=>({...prev,[m.id]:shareToken}));
    setLiveStates(prev=>({...prev,[m.id]:st}));
    // Durable (not pushLive's best-effort call, used for every later score/status update) — this
    // is the write that establishes the live_matches row's existence at all. A transient failure
    // here that pushLive's plain fire-and-forget would silently drop used to be indistinguishable,
    // 15s later, from "this match was deleted remotely" to reconcileOwnLiveMatches' prune logic —
    // turning a network blip into permanent match loss. Outbox.drain() attempts it immediately
    // (clearing within this tick on a healthy connection, same as every other Outbox write);
    // any failure stays durably queued for the next retry.
    Outbox.enqueue("upsertLiveMatch",{match:buildLiveMatchRow(m,st)});
    Outbox.drain();
    Log.event("match","Match started",{actor:currentUser?.name,court:setup.courtName,
      type:setup.isDoubles?"doubles":"singles",
      teamA:teamLabel(players,setup.teamA),teamB:teamLabel(players,setup.teamB)});
    if(m.eventId){
      // Registered/linked roster players automatically see this Event in their own Calendar —
      // reuses the exact same "going" attendee mechanism the RSVP join flow already writes,
      // Cloud.joinEvent upserts on (event_id,user_id) so this is safe to call repeatedly.
      // Guest/manual roster players are left alone: they have no account, nothing to show them.
      const rosterIds=[...(m.teamA||[]),...(m.teamB||[])];
      const linkedPlayers=rosterIds.map(id=>players.find(p=>p.id===id)).filter(p=>p&&p.source==="registered"&&p.linkedUserId);
      if(linkedPlayers.length){
        const newRows=linkedPlayers.map(p=>({
          id:m.eventId+"_"+p.linkedUserId, eventId:m.eventId, userId:p.linkedUserId, userName:p.name,
          status:"going", playStatus:"confirmed",
        }));
        setEventAtt(prev=>{
          const already=new Set(prev.filter(a=>a.eventId===m.eventId).map(a=>a.userId));
          const toAdd=newRows.filter(r=>!already.has(r.userId));
          return toAdd.length?[...prev,...toAdd]:prev;
        });
        newRows.forEach(r=>Cloud.joinEvent(r));
      }
    } else if((setup.organizerIds||[]).length){
      // Legacy per-match invite path — only reached when this match has no Event.
      const matchSummary=(m.isDoubles?"Doubles":"Singles")+" · "+fmtDate(m.date);
      setup.organizerIds.forEach(inviteeId=>{
        const inviteeName=(setup.organizerNames||{})[inviteeId]||"Player";
        const invite={id:"moi_"+uid(),matchId:m.id,ownerId:m.organizerId,ownerName:m.organizerName,
          inviteeId,inviteeName,courtName:m.courtName,matchSummary};
        Outbox.enqueue("createMatchOrganizerInvite",{invite});
        Cloud.sendNotification({
          userId:inviteeId, type:"match_organizer_invite",
          title:"You've been invited to co-organize a match",
          body:(m.organizerName||"Someone")+" · "+matchSummary+" · "+(m.courtName||"Court"),
          inviteId:invite.id, matchId:m.id, actorId:currentUser?.id, actorName:currentUser?.name,
        });
      });
      Log.event("match","Organizer invites sent",{actor:currentUser?.name,court:m.courtName,count:setup.organizerIds.length});
      Outbox.drain();
    }
    if(navigate){
      closePanel();
      setActiveMatchId(m.id);
      setScreen("scoring");
      notify(`Match on ${setup.courtName}`);
    }
    return m;
  };

  // = Tournament bridge (foundation phase) =
  // Starting a tournament match reuses startMatch() as-is — the only new work is ensuring
  // both entrants exist in this organizer's roster (same identity model Mix & Match already
  // uses for guest/import/registered players) and carrying tournament context through so the
  // Live Board / external scoreboard can display it with zero extra subscription code. Every
  // branch here is additive and only ever runs when a tournament match is actually involved —
  // a non-tournament startMatch/endMatch call never sets any of these fields.
  const startTournamentMatch = (tournamentMatch,division,registrations,tournament,servingTeam)=>{
    const regA=registrations.find(r=>r.id===tournamentMatch.registrationAId);
    const regB=registrations.find(r=>r.id===tournamentMatch.registrationBId);
    if(!regA||!regB){ notify("Both sides must be set before starting","err"); return; }
    // flushSync forces the roster addition(s) to commit before startMatch() runs below, so
    // `players` (read by canControlMatchNow/RatingEngine lookups elsewhere) has the new
    // entrant(s) as soon as possible. It does NOT help pushLive's own teamALabel/teamBLabel/
    // playerNames, though — pushLive is a closure already bound to the pre-update `players`
    // from this render, and flushSync's re-render can't retroactively change a closure a
    // function already captured earlier in the same call stack. So those three fields are
    // passed explicitly below, computed straight from the registrations (the actual source of
    // truth for these names) instead of round-tripping through `players` at all.
    flushSync(()=>{
      const byId=new Map(players.map(p=>[p.id,p]));
      [regA,regB].forEach(r=>(r.playerIds||[]).forEach(pid=>{
        const isLinked=(r.linkedAccountIds||[]).includes(pid);
        const existing=byId.get(pid);
        if(existing){
          // Player already loaded in this organizer's roster — normally nothing to do, but if the
          // registration knows this entrant is a linked account and the cached roster row predates
          // that link (linkedUserId still unset), repair it here too; otherwise it would silently
          // stay unresolvable for DUPR forever, since this is the only place a tournament entrant's
          // roster row gets written.
          if(isLinked && !existing.linkedUserId){
            const patched={...existing,linkedUserId:pid,source:existing.source==="manual"?"registered":existing.source};
            byId.set(pid,patched);
            setPlayers(prev=>prev.map(p=>p.id===pid?patched:p));
            Outbox.enqueue("upsertMixPlayer",{player:patched,organizerId:division.organizerId});
          }
          return;
        }
        const name=(r.playerNames||{})[pid];
        const np={id:pid,name:name||"Player",source:isLinked?"registered":"manual",
          linkedUserId:isLinked?pid:undefined,
          singlesRating:RatingEngine.BASE,doublesRating:RatingEngine.BASE,wins:0,losses:0};
        byId.set(pid,np);
        setPlayers(prev=>[...prev,np]);
        Outbox.enqueue("upsertMixPlayer",{player:np,organizerId:division.organizerId});
      }));
    });

    const court=courts.find(c=>c.id===tournamentMatch.courtId);
    const labelFor=reg=>Object.values(reg.playerNames||{}).join(" & ")||"Player";
    const m=startMatch({
      teamA:regA.playerIds, teamB:regB.playerIds, isDoubles:division.isDoubles!==false, winTo:division.winTo||11,
      bestOf:division.bestOf>1?division.bestOf:undefined,
      winBy:division.winBy||"two", timeoutsAllowed:division.timeoutsAllowed||undefined,
      courtId:tournamentMatch.courtId||null, courtName:court?.name||"Court",
      organizerId:division.organizerId, organizerName:currentUser?.name, category:division.category||null,
      tournamentId:division.tournamentId, tournamentName:tournament?.name||null, tournamentLogo:tournament?.logoUrl||null,
      tournamentDivisionId:division.id, divisionName:division.name, tournamentRound:tournamentMatch.round,
      tournamentMatchId:tournamentMatch.id,
      // Carried through so isAssignedUmpire(match,currentUser) (canControlMatchNow / ScoringScreen /
      // CourtsScreen) can actually recognize the umpire on the LIVE match object — organizerId above
      // deliberately stays the real tournament organizer's id (so their override keeps working), so
      // the umpire's own control has to come from this field instead. Without it, the umpire could
      // write to Supabase (RLS grants it via tournamentMatchId) but the app's own UI still showed
      // them a permanent "View only" banner on the match they just started.
      umpireId:tournamentMatch.umpireId||undefined,
      // Pool-to-Knockout's own division.format is literally "pool_to_knockout", not the
      // actual bracket shape advanceTournamentBracket needs to pick the right advancement
      // algorithm — a pool-phase match (still poolId-tagged) is plain round-robin (safe
      // no-op there, same as a round_robin division), while a knockout-phase match (no
      // poolId — generated by generateKnockoutFromPools) is shaped exactly like whichever
      // format the organizer chose (poolKnockoutFormat) and must be tagged as such or a
      // double-elimination knockout phase would silently take the single-elim advancement
      // path and never route losers into the losers bracket.
      tournamentFormat:division.format==="pool_to_knockout"
        ? (tournamentMatch.poolId ? "round_robin" : (division.poolKnockoutFormat||"single_elimination"))
        : division.format,
      registrationAId:regA.id, registrationBId:regB.id,
      teamALabel:labelFor(regA), teamBLabel:labelFor(regB),
      playerNames:{...(regA.playerNames||{}), ...(regB.playerNames||{})},
      teamACountry:regA.country||undefined, teamBCountry:regB.country||undefined,
      teamAClub:regA.club||undefined, teamBClub:regB.club||undefined,
      // Additive — undefined for every current caller, incl. the umpire's coin-toss-then-start
      // flow (the toss is HEADS/TAILS-only now, per spec, and never picks a server), so this
      // always falls through to scoring.js's newMatchState "A" default. Parameter kept for any
      // future caller that legitimately needs to seed first server.
      servingTeam:servingTeam||undefined,
    },{navigate:true});
    // Outboxed (was a direct fire-and-forget Cloud call) — a lost write here left the
    // bracket/schedule view showing this match as still "pending" forever even though it
    // was actually live, with no retry.
    if(m){
      Outbox.enqueue("updateTournamentMatch",{id:tournamentMatch.id,patch:{status:"in_progress",liveMatchId:m.id}});
      Outbox.drain();
      logMatchAudit(m,"match_started",servingTeam?{servingTeam}:undefined);
    }
    // Truthy only when the match actually started (falsy on the guard returns above and on
    // startMatch's own isValidMatchup guard) — lets callers optimistically patch their own
    // local match-list state instead of waiting on the realtime echo of the Outbox write above.
    return m;
  };
  // Best-effort bracket advancement — a fresh fetch of the division's matches keeps this
  // out of endMatch's hot path (no stale-closure risk) at the cost of one extra round trip only
  // when a tournament match with a next_match_id actually just finished. No-op for round robin
  // (its generated matches never set nextMatchId, so advanceBracket returns null immediately).
  // Champion/Runner-up/2nd Runner-up auto-population once a division's final (or bronze)
  // match completes — same one-row-per-player fan-out convention as ResultsPanel.jsx's
  // manual save (migration 123's header + Cloud.fetchAccountTournamentHistory both assume
  // player_id is always populated). Best-effort/additive only, mirrors this file's existing
  // "best-effort bracket advancement" comment above — never blocks or throws into endMatch.
  const writeTournamentAward = async(divisionId,tournamentId,organizerId,registrationId,awardType)=>{
    if(!registrationId) return;
    const regs=await Cloud.fetchRegistrations(divisionId);
    const reg=regs.find(r=>r.id===registrationId);
    if(!reg) return;
    const playerIds=Object.keys(reg.playerNames||{});
    (playerIds.length?playerIds:[null]).forEach(pid=>{
      Outbox.enqueue("upsertTournamentResult",{result:{
        id:"tres_"+uid(), tournamentId, divisionId, organizerId, awardType, registrationId:reg.id,
        playerId:pid, playerName:pid?reg.playerNames[pid]:(reg.teamName||Object.values(reg.playerNames||{}).join(" / ")||"Unnamed"),
        notes:null,
      }});
    });
    Outbox.drain();
  };

  const advanceTournamentBracket = async(divisionId,completedMatchId,winnerRegistrationId,loserRegistrationId,format,tournamentId,organizerId)=>{
    if(!divisionId||!winnerRegistrationId) return;
    const divMatches=await Cloud.fetchTournamentMatches(divisionId);
    const completed=divMatches.find(m=>m.id===completedMatchId);
    // Shared by every advancement branch below — resolving "who just got placed into a
    // real (non-TBD) match" needs the division's registrations regardless of format.
    const regsForNotify=await Cloud.fetchRegistrations(divisionId);
    // "Player added to a match" notification for a bracket-advancement patch — fires only for
    // the side(s) whose registrationAId/registrationBId slot just went from empty/TBD to a real
    // registration (oldRow may be null for a brand-new team_elimination pair match, which counts
    // as both sides "just filled"). Cloud.sendNotificationOnce (migration 144) makes this safe
    // to call again for the same match+player if this advancement path is ever retried.
    const notifyMatchAssignedFromPatch=(oldRow,patch,matchId)=>{
      const merged={...(oldRow||{}),...patch};
      if(!merged.registrationAId||!merged.registrationBId) return;
      const filledA=patch.registrationAId!=null&&(oldRow?.registrationAId==null);
      const filledB=patch.registrationBId!=null&&(oldRow?.registrationBId==null);
      if(!filledA&&!filledB) return;
      Log.debug("match","Match assigned notification",{matchId,registrationAId:merged.registrationAId,registrationBId:merged.registrationBId});
      const regA=regsForNotify.find(r=>r.id===merged.registrationAId);
      const regB=regsForNotify.find(r=>r.id===merged.registrationBId);
      const nameOfReg=r=>Object.values(r?.playerNames||{}).join(" / ")||"Unnamed";
      const recipients=[];
      const sides=[]; if(filledA) sides.push([regA,regB]); if(filledB) sides.push([regB,regA]);
      sides.forEach(([mine,opp])=>{
        (mine?.linkedAccountIds||[]).forEach(userId=>{
          recipients.push(userId);
          Cloud.sendNotificationOnce({
            userId, type:"match_assigned", title:"🔔 New Match",
            body:"vs "+nameOfReg(opp)+(merged.round?(" · Round "+merged.round):""),
            matchId, actorId:currentUser?.id, actorName:currentUser?.name,
          });
        });
      });
      Log.debug("match","Match assigned recipients",{matchId,recipients});
    };
    if(format==="double_elimination"){
      const patches=advanceDoubleEliminationBracket(divMatches,completedMatchId,winnerRegistrationId,loserRegistrationId);
      // Outboxed — a lost bracket-advancement write leaves the next match stuck
      // showing TBD/TBD forever with no way for the organizer to notice or retry.
      patches.forEach(p=>{
        Outbox.enqueue("updateTournamentMatch",{id:p.matchId,patch:p.patch});
        notifyMatchAssignedFromPatch(divMatches.find(m=>m.id===p.matchId),p.patch,p.matchId);
      });
      // The grand final (bracketSide:"final") never has nextMatchId set, so it produces
      // zero patches above — that absence is exactly the signal this division just
      // crowned a champion.
      if(completed?.bracketSide==="final"){
        writeTournamentAward(divisionId,tournamentId,organizerId,winnerRegistrationId,"champion");
        writeTournamentAward(divisionId,tournamentId,organizerId,loserRegistrationId,"runner_up_1");
      }
      return;
    }
    // Team Elimination: the bracket unit is a TEAM matchup (tournament_team_matchups),
    // not this individual pair match — a completed pair match only ever updates its
    // parent matchup's live win count. The matchup itself is only decided (winner +
    // "completed" status) once EVERY one of its individual pair matches is completed —
    // this format plays out a full N x (N-1) cross-rotation schedule per matchup, no
    // early-majority elimination like the old knockout model. No Outbox.drain() call
    // anywhere in this branch, deliberately — it runs fully async (after fetchTeamMatchups/
    // fetchRegistrations resolve), well after endMatch()'s own synchronous drain() call at
    // its call site has already fired. Draining again here raced that earlier drain() over
    // the SAME still-queued items (e.g. upsertMatch), producing a duplicate concurrent write
    // where the second arrival hit RLS as an UPDATE against a row the first had just
    // INSERTed (403). The 10s periodic sync poll (App.jsx's guardedSync) already drains
    // whatever this branch enqueues, same as every other branch in this function.
    if(format==="team_elimination"){
      if(!completed?.teamMatchupId) return; // defensive — every team_elimination pair match must carry one
      const divMatchups=await Cloud.fetchTeamMatchups(divisionId);
      const matchup=divMatchups.find(m=>m.id===completed.teamMatchupId);
      if(!matchup) return;

      const regs=regsForNotify;
      const winnerTeamId=regs.find(r=>r.id===winnerRegistrationId)?.teamId;
      if(!winnerTeamId) return;

      // Round-robin stage: the bracket unit is a TEAM matchup — a completed pair
      // match only updates its parent matchup's live win count, and the matchup
      // itself is only decided once EVERY one of its individual pair matches
      // (a full N x (N-1) cross-rotation) is completed. Semifinal/Bronze/Final
      // (below) are each a single pair-vs-pair match instead — see the CRITICAL
      // RULE: TEAMS are a grouping device only, individual PAIRS qualify.
      if(matchup.stage==="round_robin"){
        // Live win-count tally — updates immediately on every completed pair match,
        // independent of whether the matchup itself is fully decided yet.
        const isA=winnerTeamId===matchup.teamAId;
        const teamAWins=matchup.teamAWins+(isA?1:0), teamBWins=matchup.teamBWins+(isA?0:1);
        Outbox.enqueue("updateTeamMatchup",{id:matchup.id,patch:{teamAWins,teamBWins}});

        // The just-completed match's own "completed" write was only just enqueued above
        // this call (in endMatch), not necessarily drained to Supabase yet — patch it into
        // our local view explicitly rather than trusting the fetch to already reflect it,
        // same defensive pattern this codebase already uses for the matchup-level patch below.
        const patchedPairMatches=divMatches.map(m=>m.id===completedMatchId
          ?{...m,status:"completed",winner:m.registrationAId===winnerRegistrationId?"A":"B"}:m);
        const result=finalizeCrossTeamMatchup({...matchup,teamAWins,teamBWins},patchedPairMatches);
        if(!result) return; // still in progress — not every pair match in this matchup is completed yet

        const {winnerTeamId:matchupWinnerId}=result;
        Outbox.enqueue("updateTeamMatchup",{id:matchup.id,patch:{status:"completed",winnerTeamId:matchupWinnerId}});

        // Once EVERY round-robin-stage matchup in the division has been played, rank
        // every INDIVIDUAL PAIR from both teams (no team quota) by its own accumulated
        // record and dynamically generate the Top-4 Semifinal/Bronze/Final shell — mirrors
        // tournamentPoolPlay.js's generateKnockoutFromPools, which likewise only builds
        // its knockout stage once pool play concludes and real advancers are known.
        const patchedMatchups=divMatchups.map(m=>m.id===matchup.id?{...m,status:"completed",winnerTeamId:matchupWinnerId}:m);
        if(isTeamRoundRobinComplete(patchedMatchups)){
          const teamGroups=await Cloud.fetchTeams(divisionId);
          const grouped=groupRegistrationsByTeam(regs.filter(r=>r.status!=="withdrawn"),teamGroups);
          if(grouped.ok){
            const ranked=rankIndividualPairsForSemifinals(grouped.teams,patchedMatchups,patchedPairMatches);
            const division=await Cloud.fetchDivision(divisionId);
            // "manual" is the one mode that never auto-generates — the organizer picks
            // qualifiers explicitly via ManualQualifierPickerModal once round robin ends.
            const mode=division&&["top_x_per_team","manual"].includes(division.eliminationParticipantMode)?division.eliminationParticipantMode:"top_x";
            if(mode!=="manual"){
              // Clamp Top X Per Team's count against the ACTUAL per-team pair count (teams
              // are already validated equal-sized by groupRegistrationsByTeam), not just
              // whatever was configured at Division Editor time — never an unsatisfiable count.
              const perTeamCount=grouped.teams[0]?.pairs.length||1;
              const count=mode==="top_x_per_team"?Math.max(1,Math.min(division.eliminationParticipantCount||1,perTeamCount)):4;
              const qualifiers=selectQualifiers(ranked,mode,count);
              if(qualifiers.length>=2){
                const startRound=Math.max(0,...patchedMatchups.filter(m=>m.stage==="round_robin").map(m=>m.round))+1;
                const {teamMatchups:shellMatchups,pairMatches:shellPairs}=generateQualifierBracketShell(qualifiers,{
                  makeId:()=>"ttm_"+Math.random().toString(36).slice(2,10), startRound,
                  sameTeamPolicy:division?.sameTeamMatchupPolicy||"allow_anywhere",
                });
                if(shellMatchups.length){
                  const stampedMatchups=shellMatchups.map(m=>({...m,tournamentId,divisionId,organizerId}));
                  const stampedPairs=shellPairs.map(m=>({...m,tournamentId,divisionId,organizerId}));
                  Outbox.enqueue("bulkCreateTeamMatchups",{rows:stampedMatchups});
                  if(stampedPairs.length){
                    Outbox.enqueue("bulkCreateTournamentMatches",{rows:stampedPairs});
                    stampedPairs.forEach(row=>notifyMatchAssignedFromPatch(null,{registrationAId:row.registrationAId,registrationBId:row.registrationBId,round:row.round},row.id));
                  }
                }
              }
            }
          }
        }
        return;
      }

      // Knockout/Semifinal/Bronze/Final: pairsPerMatchup is always 1 for these
      // stages (generateQualifierBracketShell) — the single pair match that just
      // completed IS the matchup decision, no tally/finalizeCrossTeamMatchup
      // needed. winnerRegistrationId/loserRegistrationId (the qualified PAIRS,
      // not teams) are already in scope.
      const loserTeamId=regs.find(r=>r.id===loserRegistrationId)?.teamId||null;
      Outbox.enqueue("updateTeamMatchup",{id:matchup.id,patch:{status:"completed",winnerTeamId}});

      // "knockout" covers every pre-semifinal round (Quarterfinal, Round of 16, ...) —
      // advanceIndividualMatchup/advanceBronzeIndividualMatchup are pure pointer-followers
      // that already work at any round depth; only the true semifinal round ever carries
      // loserNextMatchupId (bronze routing), so advanceBronzeIndividualMatchup safely no-ops
      // for every earlier knockout round.
      if(matchup.stage==="semifinal"||matchup.stage==="knockout"){
        const winPatch=advanceIndividualMatchup(divMatchups,matchup.id,winnerRegistrationId,winnerTeamId);
        if(winPatch){
          pendingTeamMatchupPatches.set(winPatch.matchupId,{...(pendingTeamMatchupPatches.get(winPatch.matchupId)||{}),...winPatch.patch});
          Outbox.enqueue("updateTeamMatchup",{id:winPatch.matchupId,patch:winPatch.patch});
        }
        const bronzePatch=advanceBronzeIndividualMatchup(divMatchups,matchup.id,loserRegistrationId,loserTeamId);
        if(bronzePatch){
          pendingTeamMatchupPatches.set(bronzePatch.matchupId,{...(pendingTeamMatchupPatches.get(bronzePatch.matchupId)||{}),...bronzePatch.patch});
          Outbox.enqueue("updateTeamMatchup",{id:bronzePatch.matchupId,patch:bronzePatch.patch});
        }

        // Final/Bronze were generated as TBD-vs-TBD shells — once a patch above just
        // filled BOTH of a shell's pair slots, its single child match can finally be
        // built (the qualified pairs weren't knowable at shell-generation time).
        // Merge in-memory patches from the OTHER semifinal (which may not have
        // drained to Supabase yet) so the second SF can still see pairA+pairB.
        for(const p of [winPatch,bronzePatch].filter(Boolean)){
          const target=divMatchups.find(m=>m.id===p.matchupId);
          const patched={...target,...(pendingTeamMatchupPatches.get(p.matchupId)||{}),...p.patch};
          if(patched.pairAId&&patched.pairBId){
            const row={
              id:"tm_"+Math.random().toString(36).slice(2,10),
              round:patched.round, bracketPosition:patched.bracketPosition,
              registrationAId:patched.pairAId, registrationBId:patched.pairBId,
              status:"pending", winner:null, teamMatchupId:patched.id, pairSlot:1,
              tournamentId, divisionId, organizerId,
            };
            Outbox.enqueue("bulkCreateTournamentMatches",{rows:[row]});
            notifyMatchAssignedFromPatch(null,{registrationAId:row.registrationAId,registrationBId:row.registrationBId,round:row.round},row.id);
          }
        }
        return;
      }

      if(matchup.stage==="bronze"){
        writeTournamentAward(divisionId,tournamentId,organizerId,winnerRegistrationId,"runner_up_2");
        return;
      }

      if(matchup.stage==="final"){
        writeTournamentAward(divisionId,tournamentId,organizerId,winnerRegistrationId,"champion");
        writeTournamentAward(divisionId,tournamentId,organizerId,loserRegistrationId,"runner_up_1");
        return;
      }
      return;
    }
    const patch=advanceBracket(divMatches,completedMatchId,winnerRegistrationId);
    if(patch){
      Outbox.enqueue("updateTournamentMatch",{id:patch.matchId,patch:patch.patch});
      notifyMatchAssignedFromPatch(divMatches.find(m=>m.id===patch.matchId),patch.patch,patch.matchId);
    }
    // No-op unless this division was generated with bronzeMatch:true (only the two
    // semifinal matches ever carry loserNextMatchId in that case).
    if(loserRegistrationId){
      const bronzePatch=advanceBronzeMatchSlot(divMatches,completedMatchId,loserRegistrationId);
      if(bronzePatch){
        Outbox.enqueue("updateTournamentMatch",{id:bronzePatch.matchId,patch:bronzePatch.patch});
        notifyMatchAssignedFromPatch(divMatches.find(m=>m.id===bronzePatch.matchId),bronzePatch.patch,bronzePatch.matchId);
      }
    }
    // Round Robin + Top 4 Playoffs: once every Elimination Round match is complete,
    // auto-fill the two Semifinal shells from the division's own standings — 1v4,
    // 2v3, never random. Signalled purely by bracketSide:"winners" rows existing
    // among divMatches (only ever true when top4Playoffs was on at Generate Schedule
    // time) — no extra division fetch needed. computeSemifinalFillPatches is itself
    // idempotent (returns [] once the semis are already filled), so this is safe to
    // run on every round-robin match completion in a playoffs-enabled division.
    if(format==="round_robin"){
      const semis=divMatches.filter(m=>m.bracketSide==="winners");
      if(semis.length===2){
        const eliminationMatches=divMatches.filter(m=>!m.bracketSide);
        // divMatches is a fresh Cloud fetch taken at the top of this function — it races the
        // Outbox item (enqueued but not yet drained) that writes completedMatchId's own
        // "completed" status, so that one match still reads its pre-completion status here.
        // We already know it just completed (that's the only reason this function runs), so
        // treat it as done regardless of what this stale snapshot shows — otherwise "allDone"
        // can never go true on the very completion that should trigger it.
        const allDone=eliminationMatches.length>0&&eliminationMatches.every(m=>m.id===completedMatchId||m.status==="completed"||m.status==="bye"||m.status==="cancelled");
        if(allDone){
          const regs=regsForNotify;
          // Rank against every completed elimination-round match (including one played
          // against a since-withdrawn opponent — that credit is real and must count),
          // then drop withdrawn registrations from ELIGIBILITY only, after ranking.
          const standings=buildTournamentStandings(regs,eliminationMatches);
          const eligible=standings.filter(s=>regs.find(r=>r.id===s.registrationId)?.status!=="withdrawn");
          const fillPatches=computeSemifinalFillPatches(eligible,semis);
          fillPatches.forEach(p=>{
            Outbox.enqueue("updateTournamentMatch",{id:p.matchId,patch:p.patch});
            notifyMatchAssignedFromPatch(divMatches.find(m=>m.id===p.matchId),p.patch,p.matchId);
          });
        }
      }
    }
    // Champion/Runner-up/2nd-Runner-up: fires for a standalone Single Elimination
    // division or Pool-to-Knockout's resolved knockout phase (a match with no
    // nextMatchId that isn't the bronze match — see startTournamentMatch's
    // tournamentFormat comment), OR for a Round Robin + Top 4 Playoffs division's
    // Final/Bronze specifically (bracketSide "final"/"bronze" — every plain
    // Elimination Round match also lacks nextMatchId, so bracketSide is what keeps
    // this from firing on every ordinary round-robin match completion).
    const isKnockoutFinale=format==="single_elimination"&&completed&&!completed.nextMatchId;
    const isPlayoffFinale=format==="round_robin"&&completed&&(completed.bracketSide==="final"||completed.bracketSide==="bronze");
    if(isKnockoutFinale||isPlayoffFinale){
      if(completed.bracketSide==="bronze"){
        writeTournamentAward(divisionId,tournamentId,organizerId,winnerRegistrationId,"runner_up_2");
      } else {
        writeTournamentAward(divisionId,tournamentId,organizerId,winnerRegistrationId,"champion");
        if(loserRegistrationId) writeTournamentAward(divisionId,tournamentId,organizerId,loserRegistrationId,"runner_up_1");
      }
    }
  };

  // Distribute a batch of generated matches across the free courts and queue the
  // overflow. When a court later frees up (endMatch), the next queued match is
  // auto-started on it. Courts already running an in-progress match are skipped.
  const startMixSession = (setups,base={},courtLimit)=>{
    if(!setups||!setups.length){ notify("Nothing to start","err"); return; }
    const activeCourts=courts.filter(c=>c.active).slice(0,courtLimit);
    if(!activeCourts.length){ notify("No active courts","err"); return; }
    // Live Match Board: a follow-up round if this organizer already has a live/paused match
    // right now — a brand-new session (nothing running yet) stays at Round 1.
    const isFollowUpRound=matches.some(m=>m.status==="in_progress"||m.status==="paused");
    const nextRound=isFollowUpRound?liveRound+1:liveRound;
    if(isFollowUpRound) setLiveRound(nextRound);
    const busy=new Set(matches.filter(m=>m.status==="in_progress"||m.status==="paused").map(m=>m.courtId));
    const freeCourts=activeCourts.filter(c=>!busy.has(c.id));
    const started=[]; const queued=[];
    setups.forEach((s,i)=>{
      const setup={...base,...s};
      if(i<freeCourts.length){
        const court=freeCourts[i];
        const startedMatch=startMatch({...setup,courtId:court.id,courtName:court.name},{navigate:false});
        if(startedMatch) started.push(startedMatch);
      } else {
        queued.push({...setup, qid:uid()});
      }
    });
    const newQueue=queued.length?[...matchQueue,...queued]:matchQueue;
    if(queued.length) setMatchQueue(newQueue);
    const allIds=setups.flatMap(s=>[...(s.teamA||[]),...(s.teamB||[])]);
    syncLiveSession({round:nextRound, queue:newQueue, playerNames:Object.fromEntries(allIds.map(id=>[id,nameOf(players,id)]))});
    closePanel();
    setScreen("courts");
    notify(started.length+" on court"+(started.length!==1?"s":"")+(queued.length?" · "+queued.length+" queued":""));
  };

  const sendPoint = (matchId,team)=>{
    if(!canControlMatchNow(matches.find(x=>x.id===matchId))){ notify("You don't have permission to do that","err"); return; }
    const key=matchId+team;
    if(cooldown.current[key])return;
    cooldown.current[key]=true;
    setTimeout(()=>{cooldown.current[key]=false;},350);
    setLiveStates(prev=>{
      const cur=prev[matchId];
      if(!cur||cur.status!=="in_progress") return prev; // ignore points on paused/completed/missing matches
      const ns=applyPoint(cur,team);
      setMatches(pm=>pm.map(m=>m.id===matchId?{...m,scoreA:ns.scoreA,scoreB:ns.scoreB,status:ns.status,winner:ns.winner}:m));
      const m=matchesRef.current.find(x=>x.id===matchId);
      if(ns.status==="completed"){
        notify(`🏆 ${ns.winner==="A"?teamLabel(players,m?.teamA):teamLabel(players,m?.teamB)} wins!`,"win");
        pushLive(m,ns);          // completed: push immediately so viewers see the result
      } else {
        pushLiveDebounced(m,ns); // in progress: debounce the stream
      }
      return {...prev,[matchId]:ns};
    });
  };
  const sendUndo = matchId=>{
    if(!canControlMatchNow(matches.find(x=>x.id===matchId))){ notify("You don't have permission to do that","err"); return; }
    setLiveStates(prev=>{
      const ns=undoPoint(prev[matchId]);
      setMatches(pm=>pm.map(m=>m.id===matchId?{...m,scoreA:ns.scoreA,scoreB:ns.scoreB,status:"in_progress",winner:null}:m));
      pushLiveDebounced(matchesRef.current.find(x=>x.id===matchId),ns);
      return {...prev,[matchId]:ns};
    });
  };
  // Manual score correction, alongside (never replacing) the +1/Undo point buttons above.
  // Clamps both inputs to non-negative integers server-side (not just at the input), then
  // re-runs the exact same win-condition test applyPoint() uses so a manual edit can also mark
  // a match won/un-won correctly. Deliberately leaves `history` (the point-by-point Undo stack)
  // and `server`/`servingTeam` untouched — a manual edit isn't a discrete "point event" to hook
  // serve rotation to, so the serving indicator simply keeps whatever it last was. Works at any
  // point up to endMatch() (including after the score already hit the win condition but before
  // "Save Result" is tapped), so a mis-tap can still be fixed before ratings are finalized.
  const editScore = (matchId,newScoreA,newScoreB)=>{
    if(!canControlMatchNow(matches.find(x=>x.id===matchId))){ notify("You don't have permission to do that","err"); return; }
    const a=Math.max(0,Math.floor(+newScoreA)||0);
    const b=Math.max(0,Math.floor(+newScoreB)||0);
    setLiveStates(prev=>{
      const cur=prev[matchId];
      if(!cur) return prev;
      const ns=applyEditedScore(cur,a,b);
      setMatches(pm=>pm.map(m=>m.id===matchId?{...m,scoreA:ns.scoreA,scoreB:ns.scoreB,status:ns.status,winner:ns.winner}:m));
      const m=matchesRef.current.find(x=>x.id===matchId);
      if(ns.status==="completed") pushLive(m,ns); else pushLiveDebounced(m,ns);
      logMatchAudit(m,"score_corrected",{scoreA:a,scoreB:b});
      return {...prev,[matchId]:ns};
    });
    Log.event("match","Score manually edited",{actor:currentUser?.name,matchId,scoreA:a,scoreB:b});
  };

  // Freeze a live match's scoreboard without ending it — score/server/history are untouched,
  // point-scoring and Undo are disabled in the UI until resumed. Never touches RatingEngine.
  const pauseMatch = matchId=>{
    const cur=liveStates[matchId];
    if(!cur||cur.status!=="in_progress") return;
    const m=matches.find(x=>x.id===matchId);
    if(!canControlMatchNow(m)){ notify("You don't have permission to do that","err"); return; }
    const ns={...cur,status:"paused"};
    setLiveStates(prev=>({...prev,[matchId]:ns}));
    setMatches(pm=>pm.map(x=>x.id===matchId?{...x,status:"paused"}:x));
    pushLiveDebounced(m,ns);
    logMatchAudit(m,"paused");
    Log.event("match","Match paused",{actor:currentUser?.name,court:m?.courtName});
    notify("Match paused");
  };
  const resumeMatch = matchId=>{
    const cur=liveStates[matchId];
    if(!cur||cur.status!=="paused") return;
    const m=matches.find(x=>x.id===matchId);
    if(!canControlMatchNow(m)){ notify("You don't have permission to do that","err"); return; }
    const ns={...cur,status:"in_progress"};
    setLiveStates(prev=>({...prev,[matchId]:ns}));
    setMatches(pm=>pm.map(x=>x.id===matchId?{...x,status:"in_progress"}:x));
    pushLiveDebounced(m,ns);
    logMatchAudit(m,"resumed");
    Log.event("match","Match resumed",{actor:currentUser?.name,court:m?.courtName});
    notify("Match resumed");
  };
  // Timeouts don't touch the elapsed-time clock, score, or serve rotation — just a
  // used-count + a dismissible banner, same canControlMatchNow gate as pause/resume.
  const sendTimeout = (matchId,team)=>{
    const cur=liveStates[matchId];
    if(!cur||cur.status!=="in_progress") return;
    const m=matches.find(x=>x.id===matchId);
    if(!canControlMatchNow(m)){ notify("You don't have permission to do that","err"); return; }
    const ns=callTimeout(cur,team);
    if(ns===cur) return; // no timeouts left for that team
    setLiveStates(prev=>({...prev,[matchId]:ns}));
    pushLiveDebounced(m,ns);
    Log.event("match","Timeout called",{actor:currentUser?.name,court:m?.courtName,team});
  };
  const dismissTimeoutBanner = matchId=>{
    const cur=liveStates[matchId];
    if(!cur||!cur.timeoutTeam) return;
    const m=matches.find(x=>x.id===matchId);
    if(!canControlMatchNow(m)){ notify("You don't have permission to do that","err"); return; }
    const ns=clearTimeoutBanner(cur);
    setLiveStates(prev=>({...prev,[matchId]:ns}));
    pushLiveDebounced(m,ns);
  };
  // Pull a live/paused match off its court without ending it — unlike Pause, the court itself
  // becomes free for another match. The match's full score/history/teams stay exactly as they
  // are (the same liveStates entry is kept, only its status flips), so resuming it later via
  // resumeHeldMatch continues from the exact same score. Never touches RatingEngine/history.
  const holdMatch = matchId=>{
    const cur=liveStates[matchId];
    if(!cur||(cur.status!=="in_progress"&&cur.status!=="paused")) return;
    const m=matches.find(x=>x.id===matchId);
    if(!canControlMatchNow(m)){ notify("You don't have permission to do that","err"); return; }
    const ns={...cur,status:"held"};
    setLiveStates(prev=>({...prev,[matchId]:ns}));
    setMatches(pm=>pm.map(x=>x.id===matchId?{...x,status:"held"}:x));
    if(liveWriteTimers.current[matchId]){ clearTimeout(liveWriteTimers.current[matchId]); liveWriteTimers.current[matchId]=null; }
    Outbox.enqueue("deleteLiveMatch",{id:matchId}); // court is no longer occupied — same cleanup cancelMatch does
    if(m.tournamentMatchId){
      Outbox.enqueue("updateTournamentMatch",{id:m.tournamentMatchId,patch:{liveMatchId:null}});
    }
    Outbox.drain();
    if(activeMatchId===matchId){ setActiveMatchId(null); setScreen("courts"); }
    logMatchAudit(m,"held");
    Log.event("match","Match held",{actor:currentUser?.name,court:m?.courtName});
    notify("Match on hold — court is now open");
  };
  // Reassigns a held match to an admin-chosen court and flips it back to in_progress. Never
  // resets the score — it's the same liveStates entry Hold left untouched. Mirrors
  // startQueuedNow's explicit (matchId, courtId) shape: never guesses a court itself.
  const resumeHeldMatch = (matchId, courtId)=>{
    // Pre-existing gap, unrelated to umpire assignment (this function had no permission
    // check of any kind before) — closed here as a drive-by fix while every other
    // live-match mutator in this file is already being touched for that feature.
    if(!canControlMatchNow(matches.find(x=>x.id===matchId))){ notify("You don't have permission to do that","err"); return; }
    const cur=liveStates[matchId];
    if(!cur||cur.status!=="held"){ notify("That match is no longer on hold","err"); return; }
    const court=courts.find(c=>c.id===courtId && c.active);
    if(!court){ notify("Pick an active court","err"); return; }
    const busy=matches.some(m=>m.id!==matchId && m.courtId===courtId && (m.status==="in_progress"||m.status==="paused"));
    if(busy){ notify("That court is occupied","err"); return; }
    const ns={...cur,status:"in_progress"};
    setLiveStates(prev=>({...prev,[matchId]:ns}));
    setMatches(pm=>pm.map(x=>x.id===matchId?{...x,status:"in_progress",courtId:court.id,courtName:court.name}:x));
    const held=matches.find(x=>x.id===matchId);
    pushLive({...held,courtId:court.id,courtName:court.name}, ns);
    if(held?.tournamentMatchId){
      Outbox.enqueue("updateTournamentMatch",{id:held.tournamentMatchId,patch:{status:"in_progress",liveMatchId:matchId,courtId:court.id}});
      Outbox.drain();
    }
    Log.event("match","Held match resumed",{actor:currentUser?.name,court:court.name});
    notify("Match resumed on "+court.name);
  };
  // Abandon a live match without recording any result. The match row is kept (status:"cancelled")
  // as an audit trail but is excluded from liveMatches/doneMatches, so it can never reach
  // RatingEngine, wins/losses, standings, or match history. Mirrors endMatch's court hand-off
  // so a cancelled court still pulls the next queued Mix & Match setup.
  const cancelMatch = matchId=>{
    const match=matches.find(x=>x.id===matchId);
    if(!match) return;
    if(!canControlMatchNow(match)){ notify("You don't have permission to do that","err"); return; }
    setLiveStates(prev=>{ const n={...prev}; delete n[matchId]; return n; });
    setMatches(pm=>pm.map(x=>x.id===matchId?{...x,status:"cancelled"}:x));
    if(liveWriteTimers.current[matchId]){ clearTimeout(liveWriteTimers.current[matchId]); liveWriteTimers.current[matchId]=null; }
    Outbox.enqueue("deleteLiveMatch",{id:matchId});
    // Abandon must release the tournament bracket slot — otherwise the row stays
    // in_progress with a stale liveMatchId and Start Match never returns.
    if(match.tournamentMatchId){
      Outbox.enqueue("updateTournamentMatch",{id:match.tournamentMatchId,patch:{
        status:(match.registrationAId&&match.registrationBId)?"scheduled":"pending",
        liveMatchId:null,
      }});
    }
    Outbox.drain();
    if(activeMatchId===matchId){ setActiveMatchId(null); setScreen(match.tournamentMatchId?"tournaments":"courts"); }
    logMatchAudit(match,"cancelled");
    Log.warn("match","Match cancelled",{actor:currentUser?.name,court:match.courtName});
    notify("Match cancelled");
    // Never pull a Mix & Match queue onto a tournament court.
    if(match.tournamentMatchId) return;
    let remainingQueue=matchQueue;
    if(matchQueue.length){
      const nextUp=matchQueue[0]; remainingQueue=matchQueue.slice(1);
      const setup={...nextUp}; delete setup.qid;
      startMatch({...setup,courtId:match.courtId,courtName:match.courtName},{navigate:false});
      setMatchQueue(remainingQueue);
      notify("Next match started on "+match.courtName);
    } else if(infiniteMM.enabled){
      fillCourtFromInfiniteMode(match.courtId, match.courtName);
    }
    refreshLiveSessionAfter(matchId,remainingQueue);
  };

  // Manual out-of-order queue start: lets the organizer start ANY queued setup (not only the
  // one at the front) on a court they pick, when the front-of-queue players aren't available.
  // Reuses the exact same startMatch() call the automatic queue-advance in endMatch/cancelMatch
  // already makes; only the entry removed from matchQueue and the target court are caller-chosen
  // instead of always being matchQueue[0] + the just-freed court. The rest of the queue keeps
  // its order. Calls syncLiveSession directly (not refreshLiveSessionAfter) since we know for a
  // fact a match is now live — no risk of the stale "no active match" branch deleting the session.
  const startQueuedNow = (qid, courtId)=>{
    const item=globalQueue.find(q=>q.qid===qid);
    if(!item){ notify("That queued match is no longer available","err"); return; }
    const court=courts.find(c=>c.id===courtId && c.active);
    if(!court){ notify("Pick an active court","err"); return; }
    const setup={...item}; delete setup.qid;
    const started=startMatch({...setup,courtId:court.id,courtName:court.name},{navigate:false});
    if(!started) return; // isValidMatchup rejected it (self-match/duplicate) — queue left untouched
    const remainingQueue=globalQueue.filter(q=>q.qid!==qid);
    if(rosterOwnerId===currentUser?.id){
      setMatchQueue(remainingQueue);
      syncLiveSession({queue:remainingQueue});
    } else {
      // Helping on someone else's Event — write straight to the owner's live_sessions row
      // (spread the rest of their session so this doesn't clobber round/sittingOut/etc).
      const ownerSession=(liveBoardSessions||[]).find(s=>s.organizerId===rosterOwnerId);
      Cloud.upsertLiveSession(rosterOwnerId,{...ownerSession,queue:remainingQueue});
    }
    notify("Match started on "+court.name);
  };

  // Bulk-cancels every live/paused match belonging to one Event, and drops every queued setup
  // for that Event too — unlike cancelMatch(), this never advances the queue onto a freed court
  // (there's no single "next match" to advance to when the whole event is being cleared at once).
  // Owner/accepted-organizer only (see canControlEvent). Every live_matches row this deletes, and
  // the trimmed queue this writes back to live_sessions, are both already Realtime-enabled (see
  // supabase_migration_v3_live_board.sql) and read everywhere via the now-realtime `remoteLive`/
  // `globalQueue` (see the liveBoardMatchesForReconcile mirror above and globalQueue below), so
  // every connected device's Courts/Event view clears within ~1s — no manual refresh needed.
  // Cancels every live/paused match belonging to one event and purges its queued setups — shared
  // by deleteAllEventMatches (explicit organizer action) and deleteCloudEvent (deleting the event
  // itself must never leave one of its matches running or a queue entry orphaned under a
  // since-deleted eventId). Returns how many matches were cancelled + dequeued; callers decide
  // what to do with a zero count.
  const cancelAllMatchesForEvent = (eventId, event)=>{
    // Includes "completed but never confirmed" — a match that reached its winning score but
    // whose Owner never tapped "Save Result". endMatch() is the only thing that stamps
    // finalScoreA/finalScoreB (and deletes the live_matches row), so a completed match WITHOUT
    // those fields is exactly the unconfirmed case whose live_matches row still lingers —
    // reload-proof, unlike a liveStates check (the boot initializer at the liveStates useState
    // deliberately drops completed snapshots). Unlike cancelMatch() — which deletes
    // unconditionally — this bulk path used to silently skip these, leaving an orphaned
    // live_matches row forever, which every other connected user then kept re-showing as
    // "LIVE". SAVED completed matches (finalScore stamped) are real history and are never
    // touched. Still excludes "held": those rows are already deleted by holdMatch() itself.
    const isUnconfirmedCompleted=m=>m.status==="completed" && m.finalScoreA==null;
    const toCancel=matches.filter(m=>m.eventId===eventId && (m.status==="in_progress"||m.status==="paused"||isUnconfirmedCompleted(m)));
    const ownerId=event?.ownerId;
    const mine=rosterOwnerId===currentUser?.id;
    const currentQueue=mine?matchQueue:((liveBoardSessions||[]).find(s=>s.organizerId===ownerId)?.queue||[]);
    const queuedForEvent=currentQueue.filter(q=>q.eventId===eventId);
    if(!toCancel.length && !queuedForEvent.length) return 0;

    const cancelIds=new Set(toCancel.map(m=>m.id));
    setLiveStates(prev=>{ const n={...prev}; toCancel.forEach(m=>delete n[m.id]); return n; });
    setMatches(pm=>pm.map(x=>cancelIds.has(x.id)?{...x,status:"cancelled"}:x));
    toCancel.forEach(m=>{
      if(liveWriteTimers.current[m.id]){ clearTimeout(liveWriteTimers.current[m.id]); liveWriteTimers.current[m.id]=null; }
      Outbox.enqueue("deleteLiveMatch",{id:m.id});
    });
    if(toCancel.length) Outbox.drain();
    if(activeMatchId && toCancel.some(m=>m.id===activeMatchId)){ setActiveMatchId(null); setScreen("courts"); }

    const remainingQueue=currentQueue.filter(q=>q.eventId!==eventId);
    if(mine){
      setMatchQueue(remainingQueue);
      syncLiveSession({queue:remainingQueue});
    } else {
      const ownerSession=(liveBoardSessions||[]).find(s=>s.organizerId===ownerId);
      Cloud.upsertLiveSession(ownerId,{...ownerSession,queue:remainingQueue});
    }

    return toCancel.length+queuedForEvent.length;
  };
  const deleteAllEventMatches = (eventId)=>{
    const event=cloudEvents.find(e=>e.id===eventId);
    if(!canControlEvent(event,currentUser)){ notify("You don't have permission to do that","err"); return; }
    const total=cancelAllMatchesForEvent(eventId,event);
    if(!total){ notify("No matches to delete"); return; }
    Log.warn("match","All matches deleted for event",{actor:currentUser?.name,eventId,count:total});
    notify("Deleted "+total+" match"+(total!==1?"es":""));
  };

  // = Infinite Match Making — a thin orchestration layer over the SAME primitives every other
  // match-creation path already uses (buildMixRound, eligibleForRound, startMatch,
  // startMixSession). It never rewrites the matchmaking core; it only decides WHEN to generate
  // (a court just freed up and nothing is already queued for it — the existing queue always
  // takes priority) and WHICH pool to draw from (Master List or a single category). =

  // Deduped {id,rating} pool for a given launcher config's player source.
  const infinitePoolFor = (cfg)=>{
    const source=cfg.source;
    const filtered=players.filter(p=>!p.banned && (source==="master" || (p.categories||[]).includes(source)));
    return [...new Map(filtered.map(p=>[p.id,p])).values()].map(p=>({id:p.id,rating:+p.singlesRating||3}));
  };

  // Generates exactly one fair match from cfg's pool, honoring cfg.restInterval, and advances
  // infiniteRestRef so the interval is respected across repeated calls. Returns {teamA,teamB} or
  // null if there currently aren't enough eligible players.
  const generateInfiniteMatch = (cfg)=>{
    const mode=cfg.isDoubles?"doubles":"singles";
    const min=mode==="singles"?2:4;
    const pool=infinitePoolFor(cfg);
    if(pool.length<min) return null;
    const eligible=eligibleForRound(pool, infiniteRestRef.current, cfg.restInterval, min);
    const orderedIds=[...eligible]
      .sort((a,b)=>(infiniteRestRef.current[b.id]??Infinity)-(infiniteRestRef.current[a.id]??Infinity))
      .slice(0,min).map(p=>p.id);
    if(orderedIds.length<min) return null;
    const roundPool=pool.filter(p=>orderedIds.includes(p.id));
    const {matches:generated}=buildMixRound(roundPool, mode, infiniteHistRef.current, orderedIds);
    const m=generated[0];
    if(!m) return null;
    const playedIds=new Set([...m.teamA,...m.teamB]);
    // Everyone just drawn into this round resets to fully-rested (0); everyone else considered
    // for it but not picked ages by one match, so the interval is measured in matches-in-this-
    // pool, not wall-clock time.
    pool.forEach(p=>{ infiniteRestRef.current[p.id]=playedIds.has(p.id)?0:((infiniteRestRef.current[p.id]??0)+1); });
    return {teamA:m.teamA, teamB:m.teamB};
  };

  // Called from endMatch/cancelMatch when a court frees up and the existing queue is empty for
  // it. Single-flight guarded so a freed-court event and a near-simultaneous cloud sync tick can
  // never double-generate for the same court.
  const fillCourtFromInfiniteMode = (courtId, courtName)=>{
    if(!infiniteMM.enabled || infiniteGenLock.current) return;
    infiniteGenLock.current=true;
    try{
      const m=generateInfiniteMatch(infiniteMM);
      if(!m){ notify("Infinite Match Making: not enough eligible players right now","err"); return; }
      const ownerId=infiniteMM.organizerId||currentUser?.id;
      // Organizer access rides the session's Event (see resolveOrCreateSessionEvent /
      // toggleInfiniteMode below) — its accepted-organizer roster is what startMatch() seeds
      // every new match with, so there's no per-match invite to send here any more.
      startMatch({teamA:m.teamA,teamB:m.teamB,courtId,courtName,isDoubles:infiniteMM.isDoubles,winTo:infiniteMM.winTo,
        category:infiniteMM.source==="master"?null:infiniteMM.source,
        organizerId:ownerId,organizerName:infiniteMM.organizerName||currentUser?.name,
        date:infiniteMM.date||today(),location:infiniteMM.location||null,eventId:infiniteMM.eventId||null},{navigate:false});
      infiniteRoundsPlayedRef.current+=1;
      if(infiniteMM.roundsMode==="fixed" && infiniteRoundsPlayedRef.current>=(infiniteMM.roundsCount||1)){
        setInfiniteMM(prev=>({...prev,enabled:false}));
        notify("Infinite Match Making stopped — reached "+(infiniteMM.roundsCount||1)+" rounds");
      }
    } finally { infiniteGenLock.current=false; }
  };

  // Turning Infinite Match Making on does one initial fill of every currently-open court (reusing
  // startMixSession — the exact batch-start call Mix & Match's "Start All Matches" already makes).
  // Turning it off just stops future auto-generation; in-flight matches finish normally through
  // the untouched endMatch flow.
  const toggleInfiniteMode = (patch)=>{
    // Enabling requires an Event Name (mirrors Manual/Auto) — validated before any state change
    // so a missing name just leaves the form open rather than flipping the toggle on and stalling.
    if(patch.enabled && !infiniteMM.enabled && !(infiniteMM.eventName||"").trim()){
      notify("Enter an event name","err"); return;
    }
    const next={...infiniteMM,...patch};
    setInfiniteMM(next);
    if(patch.enabled && !infiniteMM.enabled){
      infiniteRoundsPlayedRef.current=0;
      const ownerId=next.organizerId||currentUser?.id;
      // Resolved ONCE for this whole enabled session — persisted into infiniteMM.eventId so
      // fillCourtFromInfiniteMode (which fires later, asynchronously, per freed court) reuses it
      // without re-resolving or creating a second Event.
      const eventId=resolveOrCreateSessionEvent({eventName:next.eventName,eventDate:next.date,eventLocation:next.location,
        organizerIds:next.organizerIds||[],organizerNames:next.organizerNames||{}});
      setInfiniteMM(prev=>({...prev,eventId}));
      const min=next.isDoubles?4:2;
      const busy=new Set(matches.filter(m=>m.status==="in_progress"||m.status==="paused").map(m=>m.courtId));
      const freeCourts=courts.filter(c=>c.active && !busy.has(c.id));
      if(!freeCourts.length){ notify("Infinite Match Making is on — it'll fill the next court to free up"); return; }
      const pool=infinitePoolFor(next);
      if(pool.length<min){ notify("Need "+min+"+ eligible players to start Infinite Match Making","err"); return; }
      const setups=[];
      const cap=next.roundsMode==="fixed" ? Math.min(freeCourts.length, Math.max(1,next.roundsCount||1)) : freeCourts.length;
      for(let i=0;i<cap;i++){
        const gm=generateInfiniteMatch(next);
        if(!gm) break;
        setups.push({teamA:gm.teamA,teamB:gm.teamB,isDoubles:next.isDoubles,winTo:next.winTo,category:next.source==="master"?null:next.source,
          organizerId:ownerId,organizerName:next.organizerName||currentUser?.name,
          date:next.date||today(),location:next.location||null,eventId});
      }
      infiniteRoundsPlayedRef.current=setups.length;
      if(setups.length) startMixSession(setups, {isDoubles:next.isDoubles,winTo:next.winTo}, setups.length);
      if(next.roundsMode==="fixed" && infiniteRoundsPlayedRef.current>=(next.roundsCount||1)){
        setInfiniteMM(prev=>({...prev,enabled:false}));
        notify("Infinite Match Making stopped — reached "+(next.roundsCount||1)+" rounds");
      }
    }
  };

  const endMatch = matchId=>{
    const st=liveStates[matchId];if(!st||st.status!=="completed")return;
    const match=matches.find(m=>m.id===matchId);if(!match)return;
    if(!canControlMatchNow(match)){ notify("You don't have permission to do that","err"); return; }

    // = Apply rating changes (RatingEngine v2 — same engine for registered AND guest players,
    //   since both live in this one `players[]` array and this is the only automatic mutator) =
    const isDoubles=match.isDoubles;
    const rA=isDoubles
      ? RatingEngine.teamRating(players,match.teamA)
      : (players.find(p=>p.id===match.teamA[0])?.singlesRating||RatingEngine.BASE);
    const rB=isDoubles
      ? RatingEngine.teamRating(players,match.teamB)
      : (players.find(p=>p.id===match.teamB[0])?.singlesRating||RatingEngine.BASE);
    const confA=RatingEngine.teamConfidence(players,match.teamA);
    const confB=RatingEngine.teamConfidence(players,match.teamB);

    const {newA,newB,deltaA,deltaB}=RatingEngine.compute({
      ratingA:rA,ratingB:rB,scoreA:st.scoreA,scoreB:st.scoreB,
      type:isDoubles?"doubles":"singles",confidenceA:confA,confidenceB:confB,
    });

    const ratingField=isDoubles?"doublesRating":"singlesRating";
    const ratingType=isDoubles?"doubles":"singles";
    const winTeam=st.winner==="A"?match.teamA:match.teamB;
    const loseTeam=st.winner==="A"?match.teamB:match.teamA;
    const nowIso=new Date().toISOString();

    setPlayers(prev=>prev.map(p=>{
      if(match.teamA.includes(p.id)){
        const wins=p.wins+(st.winner==="A"?1:0), losses=p.losses+(st.winner==="B"?1:0);
        const entry={ts:nowIso,matchId,type:ratingType,before:p[ratingField],after:newA,delta:deltaA,
          confidenceBefore:confA,confidenceAfter:RatingEngine.confidenceFor(wins+losses)};
        return {...p,[ratingField]:newA,wins,losses,ratingHistory:[...(p.ratingHistory||[]),entry].slice(-100)};
      }
      if(match.teamB.includes(p.id)){
        const wins=p.wins+(st.winner==="B"?1:0), losses=p.losses+(st.winner==="A"?1:0);
        const entry={ts:nowIso,matchId,type:ratingType,before:p[ratingField],after:newB,delta:deltaB,
          confidenceBefore:confB,confidenceAfter:RatingEngine.confidenceFor(wins+losses)};
        return {...p,[ratingField]:newB,wins,losses,ratingHistory:[...(p.ratingHistory||[]),entry].slice(-100)};
      }
      return p;
    }));
    // Push each affected player's updated rating + win/loss counters back to Supabase so
    // they don't drift across devices/reloads (Standings itself derives from doneMatches,
    // not these cached fields, but other screens/exports read the cached counters too).
    // Also record a rating-history row per affected player (best-effort, never blocks the UI).
    const affectedIds=new Set([...match.teamA,...match.teamB]);
    players.filter(p=>affectedIds.has(p.id)).forEach(p=>{
      const inA=match.teamA.includes(p.id);
      const newRating=inA?newA:newB, delta=inA?deltaA:deltaB, confBefore=inA?confA:confB;
      const wins=p.wins+((inA?st.winner==="A":st.winner==="B")?1:0);
      const losses=p.losses+((inA?st.winner==="B":st.winner==="A")?1:0);
      // Outboxed (not called directly) so a network failure right after the match ends can't
      // silently lose this write — see Outbox above and OUTBOX_HANDLERS below.
      Outbox.enqueue("upsertMixPlayer",{player:{...p,[ratingField]:newRating,wins,losses},organizerId:currentUser?.id});
      Outbox.enqueue("recordRatingHistory",{row:{
        playerId:p.id, organizerId:currentUser?.id, matchId, ratingType,
        ratingBefore:p[ratingField], ratingAfter:newRating, delta,
        confidenceBefore:confBefore, confidenceAfter:RatingEngine.confidenceFor(wins+losses),
      }});
    });

    setMatches(pm=>pm.map(m=>m.id===matchId?{
      ...m,status:"completed",
      ratingDeltaA:deltaA,ratingDeltaB:deltaB,
      finalScoreA:st.scoreA,finalScoreB:st.scoreB,
    }:m));
    setLiveStates(prev=>{const n={...prev};delete n[matchId];return n;});
    // Publish the completed match to shared history (visible on any device)
    const syncedMatch={
      ...match,status:"completed",
      ratingDeltaA:deltaA,ratingDeltaB:deltaB,finalScoreA:st.scoreA,finalScoreB:st.scoreB,
      winner:st.winner,
      // Per-game score history (best-of-N matches) — see submit-match/index.ts +
      // matchMapper.ts, which map this into DUPR's game1..game5 team fields.
      // Absent/empty for a single-game match, same as bestOf below.
      games:(st.games||[]).map(g=>({scoreA:g.scoreA,scoreB:g.scoreB})),
      teamALabel:teamLabel(players,match.teamA),teamBLabel:teamLabel(players,match.teamB),
      participants:[...(match.teamA||[]),...(match.teamB||[])],
    };
    Outbox.enqueue("upsertMatch",{match:syncedMatch});
    // Auto-submit to DUPR. Tournament matches always attempt — submit-match's own
    // server-side check against tournament_divisions.dupr_rated is the real gate
    // (not_rated matches never actually reach DUPR, just get marked as such), so
    // marking a division "DUPR Rated" is sufficient on its own, independent of the
    // organizer's global toggle below. Casual/Open Play matches are unaffected —
    // still opt-in only via that toggle (Admin → Ratings tab), manual submission
    // otherwise happens from History's Submit button — see src/lib/dupr.js.
    if(match.tournamentDivisionId) Outbox.enqueue("submitDuprMatch",{matchId});
    else if(ratingConfig?.duprAutoSubmit) Outbox.enqueue("submitDuprMatch",{matchId});
    // This match is no longer live — remove its live row (history now holds the result).
    if(liveWriteTimers.current[matchId]){ clearTimeout(liveWriteTimers.current[matchId]); liveWriteTimers.current[matchId]=null; }
    Outbox.enqueue("deleteLiveMatch",{id:matchId});
    // Tournament bridge — write the result back onto its tournament_matches row and, for single
    // elimination, advance the winner into the next round. No-op for every non-tournament match.
    if(match.tournamentMatchId){
      // Outboxed — a lost completion write leaves this match's own row stuck showing
      // "pending" (and a stale "Start Match" button) forever, with no retry, since a
      // direct fire-and-forget Cloud call has no durability if the request fails.
      Outbox.enqueue("updateTournamentMatch",{id:match.tournamentMatchId,patch:{
        status:"completed", winner:st.winner,
        // Strip each game's per-point history before persisting — it's only needed
        // in-memory so Undo can step back across a game boundary; nothing reads it
        // once the match is complete (StandingsPanel only reads scoreA/scoreB/winner).
        score:{scoreA:st.scoreA,scoreB:st.scoreB,gamesWonA:st.gamesWonA||0,gamesWonB:st.gamesWonB||0,
          games:(st.games||[]).map(g=>({scoreA:g.scoreA,scoreB:g.scoreB,winner:g.winner}))},
        completedMatchId:matchId, liveMatchId:null,
      }});
      advanceTournamentBracket(match.tournamentDivisionId, match.tournamentMatchId,
        st.winner==="A"?match.registrationAId:match.registrationBId,
        st.winner==="A"?match.registrationBId:match.registrationAId,
        match.tournamentFormat, match.tournamentId, match.organizerId);
    }
    // Attempt all four writes now — on a healthy connection they clear within this tick; any
    // that fail (or a reload/crash before this resolves) stay durably queued for the next drain.
    Outbox.drain();
    logMatchAudit(match,"submitted",{scoreA:st.scoreA,scoreB:st.scoreB,winner:st.winner});
    Log.success("match","Match completed · ratings updated",{
      actor:currentUser?.name,court:match.courtName,
      type:isDoubles?"doubles":"singles",
      winner:teamLabel(players,winTeam),loser:teamLabel(players,loseTeam),
      score:`${st.scoreA}-${st.scoreB}`,deltaA,deltaB,
    });
    // Auto-advance: a court just freed up — pull the next queued match onto it, or (if nothing
    // is queued and Infinite Match Making is on) generate a fresh fair match for it.
    let remainingQueue=matchQueue;
    if(matchQueue.length){
      const nextUp=matchQueue[0];
      remainingQueue=matchQueue.slice(1);
      const setup={...nextUp}; delete setup.qid; // reassign to the freed court below
      startMatch({...setup,courtId:match.courtId,courtName:match.courtName},{navigate:false});
      setMatchQueue(remainingQueue);
      notify("Next match started on "+match.courtName);
    } else if(infiniteMM.enabled){
      fillCourtFromInfiniteMode(match.courtId, match.courtName);
    }
    refreshLiveSessionAfter(matchId,remainingQueue);
    setScreen("history");
    notify("Match saved · Ratings updated");
  };

  // = Friendships =
  const sendFriendReq = (fromId,toId)=>{
    if(friends.find(f=>(f.from===fromId&&f.to===toId)||(f.from===toId&&f.to===fromId)))return;
    const req={id:uid(),from:fromId,to:toId,status:"pending",date:today(),remote:Cloud.enabled};
    setFriends(f=>[...f,req]);
    Cloud.sendFriendRequest(req);
    Log.event("friend","Friend request sent",{actor:nameOf(players,fromId),target:nameOf(directory.concat(players),toId)});
    notify("Friend request sent");
  };
  const acceptFriend  = id=>{setFriends(f=>f.map(x=>x.id===id?{...x,status:"accepted"}:x));Cloud.updateFriendRequest(id,"accepted");Log.event("friend","Friend request accepted",{actor:currentUser?.name});notify("Friend accepted");};
  const declineFriend = id=>{setFriends(f=>f.filter(x=>x.id!==id));Cloud.removeFriendRequest(id);Log.event("friend","Friend request declined",{actor:currentUser?.name});};
  const removeFriend  = id=>{setFriends(f=>f.filter(x=>x.id!==id));Cloud.removeFriendRequest(id);Log.event("friend","Friend removed",{actor:currentUser?.name});notify("Friend removed");};

  // = Shared clubs (cloud) =
  const syncClub = (club)=>{ if(club) Cloud.upsertClub(club); };
  const removeCloudClub = (id)=>{ Cloud.deleteClub(id); };

  // = Shared events (cloud calendar) =
  const createCloudEvent = (ev)=>{
    const row={...ev,id:ev.id||("ev_"+uid()),ownerId:currentUser.id,ownerName:currentUser?.name,remote:Cloud.enabled};
    setCloudEvents(prev=>[row,...prev.filter(e=>e.id!==row.id)]);
    setEventAtt(prev=>[...prev.filter(a=>!(a.eventId===row.id&&a.userId===currentUser.id)),
      {id:row.id+"_"+currentUser.id,eventId:row.id,userId:currentUser.id,userName:currentUser?.name,status:"going"}]);
    // Outboxed (not called directly) so a network/RLS failure right after creating can't
    // silently lose this write — same reasoning as the post-match rating update below.
    Outbox.enqueue("createEvent",{event:row});
    Log.event("club","Event created",{actor:currentUser?.name,title:row.title,date:row.date});
    notify("Event published 📅");
    return row;
  };
  // Resolves the Event a "New Match" session belongs to — reuses the organizer's currently
  // active session's Event (activeEventId) if one exists and its date matches the wizard's
  // chosen date; otherwise creates a brand-new Event via the existing createCloudEvent and
  // remembers it as the new active session. The single choke point that makes every match
  // created from the wizard belong to exactly one Event: called ONCE per session (Manual Start,
  // Mix & Match "Start All", enabling Infinite Mode) — never once per generated match, so
  // Infinite Mode / multi-round Mix & Match never floods the calendar with one Event each.
  // Always attributes the Event to whoever is actually logged in (createCloudEvent's existing,
  // unchanged behavior) even if a different account was picked as the match's own Owner field —
  // creating an Event "as someone else" isn't something this app supports anywhere today.
  const resolveOrCreateSessionEvent = ({eventName,eventDate,eventLocation,organizerIds=[],organizerNames={}})=>{
    const dateKey=eventDate||today();
    const existing=activeEventId?cloudEvents.find(e=>e.id===activeEventId):null;
    if(existing && existing.date===dateKey) return existing.id;
    const row=createCloudEvent({
      title:(eventName||"").trim()||((currentUser?.name||"Organizer")+"'s Session"),
      date:dateKey, location:eventLocation||"",
    });
    setActiveEventId(row.id);
    if(organizerIds.length) inviteEventOrganizers(row,organizerIds,organizerNames);
    return row.id;
  };
  // Invites co-organizers to a newly-created session Event — reuses the exact same Outbox +
  // notification pipeline built for per-match invites, just keyed by event_id instead of
  // match_id (see Cloud.createMatchOrganizerInvite/syncEventOrganizersFromInvites). Called once
  // per session, at event-creation time, never once per generated match.
  const inviteEventOrganizers = (eventRow,organizerIds,organizerNames)=>{
    const eventSummary=fmtDate(eventRow.date)+(eventRow.location?" · "+eventRow.location:"");
    organizerIds.forEach(inviteeId=>{
      const inviteeName=(organizerNames||{})[inviteeId]||"Player";
      const invite={id:"moi_"+uid(),eventId:eventRow.id,ownerId:eventRow.ownerId,ownerName:eventRow.ownerName,
        inviteeId,inviteeName,courtName:eventRow.location||null,matchSummary:eventSummary};
      Outbox.enqueue("createMatchOrganizerInvite",{invite});
      Cloud.sendNotification({
        userId:inviteeId, type:"match_organizer_invite",
        title:"You've been invited to co-organize an event",
        body:(eventRow.ownerName||"Someone")+" · "+(eventRow.title||"Event")+" · "+eventSummary,
        inviteId:invite.id, eventId:eventRow.id, actorId:currentUser?.id, actorName:currentUser?.name,
      });
    });
    Log.event("club","Event organizer invites sent",{actor:currentUser?.name,event:eventRow.title,count:organizerIds.length});
    Outbox.drain();
  };
  // Owner-only edit of an existing Event's own metadata (title/date/time/location/description).
  // Syncs to everyone via the existing 10s fetchEvents() poll — infrequent enough that the
  // already-realtime live_matches channel (which carries all the latency-sensitive activity:
  // scores, roster, new matches) doesn't need to be touched for this.
  const updateEventDetails = (eventId,patch)=>{
    setCloudEvents(prev=>prev.map(e=>e.id===eventId?{...e,...patch}:e));
    Cloud.updateEvent(eventId,patch);
    Log.event("club","Event updated",{actor:currentUser?.name,eventId,fields:Object.keys(patch||{})});
    notify("Event updated");
  };
  const requestJoinEvent = (eventId)=>{
    if(eventAtt.find(a=>a.eventId===eventId&&a.userId===currentUser.id))return;
    const row={id:eventId+"_"+currentUser.id,eventId,userId:currentUser.id,userName:currentUser?.name,status:"pending"};
    setEventAtt(prev=>[...prev,row]);
    Cloud.joinEvent(row);
    Log.event("club","Requested to join event",{actor:currentUser?.name,eventId});
    notify("Join request sent");
  };
  const acceptEventAttendee = (eventId,userId)=>{
    setEventAtt(prev=>prev.map(a=>(a.eventId===eventId&&a.userId===userId)?{...a,status:"going",playStatus:a.playStatus||"confirmed"}:a));
    Cloud.updateAttendee(eventId,userId,{status:"going",playStatus:"confirmed"});
    Log.event("club","Event join approved",{actor:currentUser?.name,eventId,userId});
    notify("Player approved ✓");
  };
  // Host management: roles, play status (confirmed/waitlist/onhold), team, court, payment
  const updateAttendee = (eventId,userId,patch)=>{
    setEventAtt(prev=>prev.map(a=>(a.eventId===eventId&&a.userId===userId)?{...a,...patch}:a));
    Cloud.updateAttendee(eventId,userId,patch);
    if(patch.playStatus) Log.event("club","Attendee status updated",{actor:currentUser?.name,eventId,userId,status:patch.playStatus});
  };
  // Host approves a request/waitlisted player → confirmed if there's room, otherwise waitlisted (in order)
  const makeParticipant = (eventId,userId)=>{
    const ev=cloudEvents.find(e=>e.id===eventId);
    const cap=ev?ev.capacity:Infinity;
    const confirmed=eventAtt.filter(a=>a.eventId===eventId&&a.status==="going"&&(a.playStatus||"confirmed")==="confirmed"&&a.userId!==userId).length;
    const full=cap!==Infinity&&cap!=null&&confirmed>=cap;
    const playStatus=full?"waitlist":"confirmed";
    setEventAtt(prev=>prev.map(a=>(a.eventId===eventId&&a.userId===userId)?{...a,status:"going",playStatus}:a));
    Cloud.updateAttendee(eventId,userId,{status:"going",playStatus});
    Log.event("club",full?"Player waitlisted (event full)":"Player confirmed to play",{actor:currentUser?.name,eventId,userId});
    notify(full?"Event full — added to waitlist":"Confirmed to play ✓");
  };
  const declineEventAttendee = (eventId,userId)=>{
    setEventAtt(prev=>prev.filter(a=>!(a.eventId===eventId&&a.userId===userId)));
    Cloud.removeAttendee(eventId,userId);
    notify("Request declined");
  };
  const leaveCloudEvent = (eventId)=>{
    setEventAtt(prev=>prev.filter(a=>!(a.eventId===eventId&&a.userId===currentUser.id)));
    Cloud.removeAttendee(eventId,currentUser.id);
    notify("Left the event");
  };
  const deleteCloudEvent = (eventId)=>{
    // Deleting the Event itself must never orphan a still-running match or a queued setup under
    // this now-deleted eventId — reuses the exact same cancellation the explicit "Delete All
    // Matches" action uses (see cancelAllMatchesForEvent above).
    cancelAllMatchesForEvent(eventId, cloudEvents.find(e=>e.id===eventId));
    setCloudEvents(prev=>prev.filter(e=>e.id!==eventId));
    setEventAtt(prev=>prev.filter(a=>a.eventId!==eventId));
    Cloud.deleteEvent(eventId);
    Log.warn("club","Event deleted",{actor:currentUser?.name,eventId});
    notify("Event deleted");
  };
  // Add/remove a co-organizer on an event. The invited organizer gets full control of the
  // event (same isOwner-gated UI, via canControlEvent) except deleting it or transferring
  // ownership. Owner-only in practice — enforced at the UI call site (the "Add Organizer"
  // control is only rendered for the true owner), same trust model as every other event
  // handler here. Never creates a second copy of the event — this only appends to the one
  // shared row, which every organizer's client already polls every 10s.
  const addEventOrganizer = (eventId, accountId, accountName)=>{
    const ev=cloudEvents.find(e=>e.id===eventId);
    if(!ev||ev.ownerId===accountId||(ev.organizerIds||[]).includes(accountId)) return;
    const organizerIds=[...(ev.organizerIds||[]),accountId];
    const organizerNames={...(ev.organizerNames||{}),[accountId]:accountName};
    setCloudEvents(prev=>prev.map(e=>e.id===eventId?{...e,organizerIds,organizerNames}:e));
    Cloud.updateEventOrganizers(eventId,organizerIds,organizerNames);
    Cloud.sendNotification({
      userId:accountId, type:"event_organizer_added",
      title:"You were added as an organizer", body:ev.title,
      eventId, actorId:currentUser?.id, actorName:currentUser?.name,
    });
    Log.event("club","Organizer added to event",{actor:currentUser?.name,eventId,target:accountName});
    notify(accountName+" added as organizer");
  };
  const removeEventOrganizer = (eventId, accountId)=>{
    const ev=cloudEvents.find(e=>e.id===eventId);
    if(!ev) return;
    const organizerIds=(ev.organizerIds||[]).filter(id=>id!==accountId);
    const organizerNames={...(ev.organizerNames||{})}; delete organizerNames[accountId];
    setCloudEvents(prev=>prev.map(e=>e.id===eventId?{...e,organizerIds,organizerNames}:e));
    Cloud.updateEventOrganizers(eventId,organizerIds,organizerNames);
    Log.event("club","Organizer removed from event",{actor:currentUser?.name,eventId,target:accountId});
    notify("Organizer removed");
  };
  const markNotificationRead = (id)=>{
    setNotifications(prev=>prev.map(n=>n.id===id?{...n,read:true}:n));
    Cloud.markNotificationRead(id);
  };
  // Match Organizer Invites: Accept/Decline, driven straight off the notification row (it
  // already carries inviteId/matchId, see startMatch()'s invite-creation block — no extra fetch
  // needed). Direct calls, not outboxed, matching the existing acceptFriend/declineFriend
  // precedent for the same shape of person-to-person state-changing action.
  const acceptOrganizerInvite = async (notif)=>{
    if(!notif?.inviteId) return;
    const r = await Cloud.respondMatchOrganizerInvite(notif.inviteId,"accepted");
    if(!r.ok){ notify("Couldn't accept the invite. Please try again.","err"); return; }
    markNotificationRead(notif.id);
    // Deliberately NOT calling Cloud.syncMatchOrganizersFromInvites here: under this table's
    // strict RLS I (the invitee) can only see MY OWN invite row, not any other co-organizer's
    // already-accepted row for the same match — recomputing from here could wipe out someone
    // else's earlier acceptance. Only the match owner (who can see every row for their own
    // match) is allowed to run that recompute — see subscribeMyOwnedMatchInvites, which fires
    // the moment the update below lands. This match will appear on my Courts screen within a
    // few seconds once the owner's device pushes the refreshed roster.
    if(r.invite?.ownerId) Cloud.sendNotification({
      userId:r.invite.ownerId, type:"match_organizer_accepted",
      title:(currentUser?.name||"Someone")+" accepted your organizer invite",
      body:r.invite.courtName||"", matchId:r.invite.matchId, eventId:r.invite.eventId, actorId:currentUser?.id, actorName:currentUser?.name,
    });
    Log.event("match","Organizer invite accepted",{actor:currentUser?.name,matchId:notif.matchId,eventId:r.invite?.eventId});
    // The event-scoped path (the common case now that New Match always belongs to an Event)
    // reaches Courts/Calendar via the owner's device — see subscribeMyOwnedMatchInvites, which
    // fires the moment the update below lands and runs syncEventOrganizersFromInvites (or, for
    // the legacy standalone-match path, syncMatchOrganizersFromInvites). Deliberately not run
    // from here: under this table's strict RLS I (the invitee) can only see MY OWN invite row,
    // not any other co-organizer's already-accepted row for the same event/match — recomputing
    // from here could wipe out someone else's earlier acceptance.
    // Anchor MY OWN session onto this event right away — the same activeEventId pointer the
    // owner's own session already runs on, so rosterOwnerId (players/categories/teams/courts),
    // the global Courts tab, and "+ Add Match" all immediately treat this as the shared event
    // instead of only working after manually opening Calendar → the event.
    if(r.invite?.eventId) setActiveEventId(r.invite.eventId);
    notify(r.invite?.eventId
      ? "You're now a co-organizer of that event – it'll appear on your Calendar shortly"
      : "You're now a co-organizer of that match – it'll appear on Courts shortly");
  };
  const declineOrganizerInvite = async (notif)=>{
    if(!notif?.inviteId) return;
    const r = await Cloud.respondMatchOrganizerInvite(notif.inviteId,"declined");
    if(!r.ok){ notify("Couldn't decline the invite. Please try again.","err"); return; }
    markNotificationRead(notif.id);
    if(r.invite?.ownerId) Cloud.sendNotification({
      userId:r.invite.ownerId, type:"match_organizer_declined",
      title:(currentUser?.name||"Someone")+" declined your organizer invite",
      body:r.invite.courtName||"", matchId:r.invite.matchId, eventId:r.invite.eventId, actorId:currentUser?.id, actorName:currentUser?.name,
    });
    Log.event("match","Organizer invite declined",{actor:currentUser?.name,matchId:notif.matchId,eventId:r.invite?.eventId});
    notify("Invite declined");
  };
  // Accepted attendees can request a +1 guest (host approves like any join request)
  const requestGuestEvent = (eventId,guestName)=>{
    const gid=currentUser.id+":g:"+Date.now().toString(36);
    const row={id:eventId+"_"+gid,eventId,userId:gid,userName:(guestName||"Guest").trim()||"Guest",
      status:"pending",isGuest:true,guestOf:currentUser.id};
    setEventAtt(prev=>[...prev,row]);
    Cloud.joinEvent(row);
    Log.event("club","+1 guest requested",{actor:currentUser?.name,eventId,guest:row.userName});
    notify("+1 request sent to the host");
  };
  // Shared chat for events and clubs (scope: "event" | "club")
  const sendChat = (scope,scopeId,text)=>{
    const t=(text||"").trim(); if(!t||!scopeId) return;
    const msg={id:"msg_"+uid(),scope,scopeId,userId:currentUser.id,userName:currentUser?.name,text:t,ts:new Date().toISOString()};
    setChatMsgs(prev=>[...prev,msg]);
    Cloud.sendMessage(msg);
  };
  // Feed: news / announcements everyone can post & see
  const createPost = ({text,image,clubId,clubName})=>{
    const t=(text||"").trim(); if(!t&&!image) return;
    const post={id:"post_"+uid(),authorId:currentUser.id,authorName:currentUser?.name,authorPhoto:currentUser?.photo||null,
      clubId:clubId||null,clubName:clubName||null,text:t,image:image||null,likes:[],ts:new Date().toISOString(),remote:Cloud.enabled};
    setFeedPosts(prev=>[post,...prev]);
    Cloud.createPost(post);
    Log.event("system","Feed post created",{actor:currentUser?.name});
    notify("Posted to the feed 🎉");
  };
  const likePost = (postId)=>{
    // Optimistic local toggle for instant feedback; toggle_post_like() computes the
    // authoritative result server-side (avoids a lost-update race between two concurrent likers)
    // and we reconcile once it resolves.
    setFeedPosts(prev=>prev.map(p=>{
      if(p.id!==postId) return p;
      const liked=(p.likes||[]).includes(currentUser.id);
      const likes=liked?p.likes.filter(x=>x!==currentUser.id):[...(p.likes||[]),currentUser.id];
      return {...p,likes};
    }));
    Cloud.likePost(postId).then(serverLikes=>{
      if(!serverLikes) return;
      setFeedPosts(prev=>prev.map(p=>p.id===postId?{...p,likes:serverLikes}:p));
    });
  };
  const deletePost = (postId)=>{
    setFeedPosts(prev=>prev.filter(p=>p.id!==postId));
    Cloud.deletePost(postId);
    notify("Post deleted");
  };

  // Hides a completed match's card from Home's "Today" list. Purely a local display filter —
  // never touches `matches`, ratings, standings, or Supabase.
  const dismissFromHome = matchId=>{
    setDismissedHomeIds(prev=>new Set(prev).add(matchId));
  };

  // = Computed =
  const liveMatches  = matches.filter(m=>m.status==="in_progress"||m.status==="paused");
  const heldMatches  = matches.filter(m=>m.status==="held");
  const doneMatches  = matches.filter(m=>m.status==="completed"); // cancelled matches never appear here
  const viewPlayer   = players.find(p=>p.id===viewPlayerId)||directory.find(p=>p.id===viewPlayerId)||null;
  const tl           = pl=>teamLabel(players,pl);
  // Registered-accounts-only list for the Network screen's "Nearby Players" tab: real
  // Supabase accounts (cloud directory) plus any roster entries explicitly added FROM the
  // directory (source:"registered") — excludes manual/imported temporary event players,
  // who have no real account and therefore can't be friended.
  const nearbyMap=new Map();
  directory.forEach(d=>{ if(d.id!==currentUser?.id) nearbyMap.set(d.id,d); });
  // Only roster rows added via "Find Registered" (where id===linkedUserId by construction) count
  // as a distinct discoverable account here — a soft-linked guest row keeps its own old id, and
  // that person is already represented above by their real directory entry.
  players.forEach(p=>{ if(p.source==="registered"&&p.id===p.linkedUserId&&p.id!==currentUser?.id&&!nearbyMap.has(p.id)) nearbyMap.set(p.id,p); });
  const nearbyPlayers=[...nearbyMap.values()].sort((a,b)=>((b.singlesRating||0)-(a.singlesRating||0)));
  // Every id that resolves to "me": my own account, plus any guest roster rows linked to me.
  const myIds = currentUser ? [currentUser.id, ...players.filter(p=>p.linkedUserId===currentUser.id).map(p=>p.id)] : [];

  // = Show loading intro on launch =
  if(booting) return <SplashScreen/>;

  // = Password recovery (opened from the Supabase reset email) =
  if(recovery) return (
    <ResetPasswordScreen
      onSubmit={completePasswordReset}
      initialError={recoveryErr}
      onDone={()=>{
        recoveryRef.current=false; setRecovery(false); setRecoveryErr("");
        setAuthScreen("login");
        try{ if(window.history&&window.history.replaceState) window.history.replaceState({},"", SITE_URL_PATH()); }catch{ /* best-effort, safe to ignore */ }
      }}/>
  );

  // = Show Auth if not logged in =
  if(!currentUser) return(
    <AuthGate
      authScreen={authScreen} setAuthScreen={setAuthScreen}
      onSignUp={signUp} onLogIn={logIn} onForgotPassword={sendPasswordReset}/>
  );

  return(
    <BackHandlerContext.Provider value={backHandlerCtx}>
    <div className="app-shell" style={{color:D.white,position:"relative"}}>

      {/* Sidebar nav (Electron desktop only — BottomNav covers web/Android/mobile) */}
      {hasElectron && <SideNav screen={screen} setScreen={setScreen}/>}

      <div className="app-content-col">

      {/* Update banner (Electron only, no-op on web/Android) */}
      <UpdateBanner/>

      {/* Offline banner (all platforms) */}
      <OfflineBanner/>

      {/* Toast — absolute (not fixed) so it centers within .app-content-col rather than the
          whole window: under the Electron sidebar shell, "fixed + left:50%" would center
          across the sidebar too and land off-center from the content the user is looking at. */}
      {toast&&(
        <div style={{position:"absolute",top:64,left:"50%",transform:"translateX(-50%)",zIndex:9999,
          background:toast.type==="win"?D.amber:toast.type==="err"?D.red:D.green,
          color:D.bg,padding:"10px 20px",borderRadius:100,fontWeight:700,fontSize:13,
          whiteSpace:"nowrap",boxShadow:"0 8px 32px rgba(0,0,0,.8)",animation:"toastIn .2s ease",pointerEvents:"none"}}>
          {toast.msg}
        </div>
      )}

      {/* App Header */}
      <AppHeader liveCount={liveMatches.length}
        adminMode={adminMode} onAdmin={()=>openPanel("admin")} onNewMatch={()=>setScreen("tournaments")}
        currentUser={currentUser} onProfile={()=>openPanel("myProfile")} onOpenLiveBoard={()=>setScreen("liveboard")}
        notifCount={notifications.filter(n=>!n.read).length} onOpenNotifications={()=>openPanel("notifications")}/>

      {/* Pull-to-refresh indicator */}
      {(pullY>0||refreshing)&&(
        <div style={{position:"absolute",top:56,left:0,right:0,display:"flex",justifyContent:"center",zIndex:50,pointerEvents:"none"}}>
          <div style={{marginTop:refreshing?20:Math.min(pullY,80)-30,width:32,height:32,borderRadius:16,background:D.surface,boxShadow:"0 2px 10px rgba(0,0,0,.15)",display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{width:16,height:16,border:"2px solid "+D.border,borderTopColor:D.accent,borderRadius:"50%",
              transform:refreshing?"none":`rotate(${pullY*3}deg)`,animation:refreshing?"spin .7s linear infinite":"none"}}/>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div style={{flex:1,overflowY:"auto",overflowX:"hidden"}}
        onTouchStart={e=>{
          const el=e.currentTarget, t=e.touches[0];
          el._sy=(el.scrollTop<=0)?t.clientY:null;   // pull-to-refresh anchor (unchanged)
          el._sx=t.clientX; el._sxy=t.clientY;        // swipe-nav anchor
          el._swipeBlocked=isInsideHorizontalScroller(e.target);
          el._dx=0; el._dy=0;
        }}
        onTouchMove={e=>{
          const el=e.currentTarget, t=e.touches[0];
          if(el._sy!=null){ const dy=t.clientY-el._sy; if(dy>0&&el.scrollTop<=0){ setPullY(Math.min(dy,110)); } }
          el._dx=t.clientX-el._sx; el._dy=t.clientY-el._sxy;
        }}
        onTouchEnd={e=>{
          if(pullY>70){ setRefreshing(true); setPullY(0); Promise.resolve(syncRef.current()).catch(()=>{}).finally(()=>{ setRefreshing(false); }); } else setPullY(0);
          const el=e.currentTarget, dx=el._dx||0, dy=el._dy||0;
          const SWIPE_MIN_DX=60, SWIPE_MAX_VERT_RATIO=0.5;
          if(!el._swipeBlocked && Math.abs(dx)>SWIPE_MIN_DX && Math.abs(dy)<Math.abs(dx)*SWIPE_MAX_VERT_RATIO){
            if(dx>0) gestureBack(); else gestureForward();
          }
        }}>
        {visitedScreens.has("home") && <div style={{display:screen==="home"?"contents":"none"}}>
          <HomeScreen players={players} liveMatches={liveMatches} doneMatches={doneMatches}
            liveStates={liveStates} teamLabel={tl} onNewMatch={()=>setScreen("tournaments")}
            onOpenMatch={id=>{setActiveMatchId(id);setScreen("scoring");}} setScreen={setScreen}
            courts={courts} friends={friends} notify={notify} currentUser={currentUser}
            cloudEvents={cloudEvents} eventAtt={eventAtt} clubs={clubs} directory={directory} myIds={myIds}
            dismissedHomeIds={dismissedHomeIds} onDismissFromHome={dismissFromHome} umpireAssignments={umpireAssignments}
            onOpenUmpireAssignment={id=>{setUmpireDeepLinkMatchId(id);setScreen("tournaments");}}/>
        </div>}
        {visitedScreens.has("courts") && <div style={{display:screen==="courts"?"contents":"none"}}>
          <CourtsScreen matches={liveMatches} liveStates={liveStates} courts={courts}
            players={players} sendPoint={sendPoint} sendUndo={sendUndo} endMatch={endMatch}
            pauseMatch={pauseMatch} resumeMatch={resumeMatch} holdMatch={holdMatch} cancelMatch={cancelMatch}
            onManage={()=>openPanel("courtMgr")} onNewMatch={()=>setScreen("tournaments")}
            teamLabel={tl} setActiveMatchId={setActiveMatchId} setScreen={setScreen}
            queue={globalQueue} heldMatches={heldMatches} remoteLive={remoteLive} currentUser={currentUser} categories={categories}
            onClearQueue={()=>{
              if(rosterOwnerId===currentUser?.id){ setMatchQueue([]); syncLiveSession({queue:[]}); }
              else { const ownerSession=(liveBoardSessions||[]).find(s=>s.organizerId===rosterOwnerId); Cloud.upsertLiveSession(rosterOwnerId,{...ownerSession,queue:[]}); }
              notify("Queue cleared");
            }} onStartQueuedNow={startQueuedNow} onResumeHeld={resumeHeldMatch}
            infiniteMM={infiniteMM} onManualAssign={openManualAssign} cloudEvents={cloudEvents}/>
        </div>}
        {visitedScreens.has("scoring") && <div style={{display:screen==="scoring"?"contents":"none"}}>
          <ScoringScreen
            match={matches.find(m=>m.id===activeMatchId)||null}
            state={liveStates[activeMatchId]||null} teamLabel={tl}
            onPoint={t=>sendPoint(activeMatchId,t)} onUndo={()=>sendUndo(activeMatchId)}
            onEnd={()=>endMatch(activeMatchId)} onBack={()=>setScreen("courts")}
            onPause={()=>pauseMatch(activeMatchId)} onResume={()=>resumeMatch(activeMatchId)}
            onTimeout={t=>sendTimeout(activeMatchId,t)} onDismissTimeout={()=>dismissTimeoutBanner(activeMatchId)}
            onHold={()=>holdMatch(activeMatchId)}
            onCancel={()=>cancelMatch(activeMatchId)}
            onEditScore={(a,b)=>editScore(activeMatchId,a,b)}
            shareToken={shareTokens[activeMatchId]||null} currentUser={currentUser} cloudEvents={cloudEvents} players={players}/>
        </div>}
        {visitedScreens.has("players") && <div style={{display:screen==="players"?"contents":"none"}}>
          <PlayersScreen nearby={nearbyPlayers} doneMatches={doneMatches}
            onView={id=>{setViewPlayerId(id);openPanel("playerProfile");}}
            friends={friends} onFriendReq={sendFriendReq}
            currentUser={currentUser} onAccept={acceptFriend} onDecline={declineFriend} onRemove={removeFriend}/>
        </div>}
        {visitedScreens.has("tournaments") && <div style={{display:screen==="tournaments"?"contents":"none"}}>
          <ErrorBoundary>
            <TournamentsListScreen currentUser={currentUser} directory={players} accountsDirectory={directory} courts={courts}
              onStartMatch={startTournamentMatch} notify={notify} umpireAssignments={umpireAssignments}
              onOpenLiveMatch={id=>{setActiveMatchId(id);setScreen("scoring");}}
              deepLinkUmpireMatchId={umpireDeepLinkMatchId}
              onConsumeUmpireDeepLink={()=>setUmpireDeepLinkMatchId(null)}
              deepLinkTournamentId={matchAssignedDeepLink?.tournamentId||null}
              deepLinkDivisionId={matchAssignedDeepLink?.divisionId||null}
              onConsumeMatchAssignedDeepLink={()=>setMatchAssignedDeepLink(null)}/>
          </ErrorBoundary>
        </div>}
        {visitedScreens.has("liveboard") && <div style={{display:screen==="liveboard"?"contents":"none"}}>
          <LiveBoardScreen currentUser={currentUser} directory={directory} categories={categories}/>
        </div>}
        {visitedScreens.has("settings") && <div style={{display:screen==="settings"?"contents":"none"}}>
          <SettingsScreen currentUser={currentUser} onUpdate={updateProfile} onLogOut={logOut} onDeleteAccount={deleteAccount} notify={notify}
            onChangePassword={changePassword} theme={theme} onChangeTheme={setTheme}/>
        </div>}
      </div>

      {/* Bottom Nav (web/Android/mobile — Electron desktop uses SideNav above instead) */}
      {!hasElectron && <BottomNav screen={screen} setScreen={setScreen}/>}

      </div>

      {/* Panels */}
      {panel==="courtMgr"    && <CourtMgrModal courts={courts} onAdd={addCourt} onRename={renameCourt} onRecolor={recolorCourt} onToggleActive={toggleCourtActive} onDelete={deleteCourt} onClose={closePanel} notify={notify}/>}
      {panel==="playerProfile"&&viewPlayer && <PlayerProfilePanel player={viewPlayer} doneMatches={doneMatches} players={players} teamLabel={tl} friends={friends} currentUser={currentUser}
          onFriendReq={sendFriendReq} onAccept={acceptFriend} onDecline={declineFriend} onRemove={removeFriend} onClose={closePanel}/>}
      {panel==="admin" && currentUser?.role==="admin" && <AdminPanel players={players} matches={doneMatches}
          setAdminMode={setAdminMode}
          onBan={banPlayer} onUnban={unbanPlayer} onDelete={delPlayer} onClose={closePanel} notify={notify}
          ratingConfig={ratingConfig} onSetRatingConfig={updateRatingConfig}/>}
      {panel==="myProfile"   && <MyProfilePanel currentUser={currentUser} doneMatches={doneMatches}
          players={players} teamLabel={tl} onUpdate={updateProfile} onLogOut={logOut} onClose={closePanel} notify={notify} myIds={myIds}/>}
      {panel==="notifications" && <NotificationInboxPanel notifications={notifications} onMarkRead={markNotificationRead}
          onOpenEvent={()=>{closePanel();setScreen("tournaments");}} onClose={closePanel}
          onOpenUmpireMatch={(matchId)=>{closePanel();setUmpireDeepLinkMatchId(matchId);setScreen("tournaments");}}
          // "You've been added to a match" tap — resolve the match (not preloaded anywhere for
          // an arbitrary player) then jump straight into live scoring if it's already started,
          // otherwise deep-link to its tournament/division via matchAssignedDeepLink (consumed
          // by TournamentsListScreen -> TournamentDetailPanel), mirroring the umpire deep-link
          // pattern above but resolved async since the target isn't already in local state.
          onOpenMatch={async(matchId)=>{
            closePanel();
            const m=await Cloud.fetchTournamentMatch(matchId);
            if(!m){ setScreen("tournaments"); return; }
            if(m.status==="in_progress"&&m.liveMatchId){
              setActiveMatchId(m.liveMatchId); setScreen("scoring"); return;
            }
            setMatchAssignedDeepLink({tournamentId:m.tournamentId,divisionId:m.divisionId});
            setScreen("tournaments");
          }}
          onAcceptOrganizerInvite={acceptOrganizerInvite} onDeclineOrganizerInvite={declineOrganizerInvite}/>}

    </div>
    </BackHandlerContext.Provider>
  );
}
