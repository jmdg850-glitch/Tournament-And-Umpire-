import { useCallback, useEffect, useMemo, useState } from "react";
import { createSpectatorClient, envConfig } from "@tournament/client";
import { applyDeskRealtime } from "@tournament/engine";
import { Alert, Badge, EmptyState, LoadingState, SplashScreen, StatusBadge, Tabs } from "@tournament/ui";
import { useRealtimeChannel } from "../useRealtimeChannel.js";
import { loadPublicTournamentData } from "./data.js";
import { playableMatches } from "../lib.js";
import LiveMatchCard from "./LiveMatchCard.jsx";
import UpNextList from "./UpNextList.jsx";
import ResultsList from "./ResultsList.jsx";
import PublicBracketTab from "./PublicBracketTab.jsx";
import PublicStandingsTab from "./PublicStandingsTab.jsx";
import FindMyTeam from "./FindMyTeam.jsx";

const TABS = [
  ["live", "Live"],
  ["upnext", "Up Next"],
  ["results", "Results"],
  ["bracket", "Bracket"],
  ["standings", "Standings"],
  ["search", "Find my team"],
];

// The public, read-only, no-login spectator page for one tournament —
// /live/<slug-or-id> (see route.js). Uses a dedicated anon-role client
// (createSpectatorClient — no session persistence/restore, unlike the rest
// of this app) and a trimmed, public-safe data loader (data.js), but reuses
// every existing display primitive it can: DivisionBracketCard for the
// bracket tab, teamEliminationStandings for standings, useRealtimeChannel +
// applyDeskRealtime for live updates — the same mechanism BracketWindow.jsx
// already uses for the authenticated equivalent.
export default function LiveTournamentPage({ slugOrId }) {
  const supabase = useMemo(() => {
    const cfg = envConfig();
    return createSpectatorClient(cfg.url, cfg.publishableKey);
  }, []);
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | not_found | error | ready
  const [error, setError] = useState("");
  const [tab, setTab] = useState("live");
  const [connected, setConnected] = useState(true);

  const load = useCallback(async () => {
    const { data: next, error: err } = await loadPublicTournamentData(supabase, slugOrId);
    if (err) {
      setStatus("error");
      setError(err.message);
      return;
    }
    if (!next) {
      setStatus("not_found");
      return;
    }
    setStatus("ready");
    setError("");
    setData(next);
  }, [supabase, slugOrId]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtimeChannel({
    supabase,
    name: `public-live:${data?.tournament?.id || slugOrId}`,
    enabled: Boolean(data?.tournament?.id),
    specs: [
      { event: "*", schema: "public", table: "matches", filter: `tournament_id=eq.${data?.tournament?.id}` },
      { event: "*", schema: "public", table: "match_results" },
      { event: "*", schema: "public", table: "court_assignments" },
    ],
    onPayload: (payload) => {
      const table = payload.table;
      const eventType = payload.eventType || payload.event;
      setData((prev) => (prev ? applyDeskRealtime(prev, table, eventType, payload.new, payload.old) : prev));
    },
    onSubscribed: () => {
      setConnected(true);
      return load();
    },
  });

  useEffect(() => {
    function onVis() {
      if (document.visibilityState === "visible") load();
    }
    function onOffline() { setConnected(false); }
    function onOnline() { setConnected(true); load(); }
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, [load]);

  if (status === "loading") {
    return <SplashScreen brand="Tournament" tagline="Live" status="Loading tournament…" />;
  }
  if (status === "not_found") {
    return (
      <div className="spectator-page">
        <div className="spectator-header">
          <EmptyState title="Tournament not found">This live page isn't available. Check the link and try again.</EmptyState>
        </div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="spectator-page">
        <div className="spectator-header">
          <Alert>Something went wrong loading this tournament. Please try again.</Alert>
        </div>
      </div>
    );
  }

  const divisionName = (divisionId) => data.divisions.find((d) => d.id === divisionId)?.name || "Division";
  const playable = playableMatches(data.matches);
  const live = playable.filter((m) => m.status === "in_progress");
  const upNext = playable.filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const results = playable.filter((m) => m.status === "completed");

  return (
    <div className="spectator-page">
      <header className="spectator-header">
        <div className="kicker">Live Tournament</div>
        <h1>{data.tournament.name}</h1>
        <div className="row spectator-header-meta">
          <StatusBadge status={data.tournament.status} kind="tournament" />
          {!connected ? <Badge tone="warn">Live connection interrupted — Reconnecting…</Badge> : null}
        </div>
      </header>

      <nav className="spectator-tabs">
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
      </nav>

      <main className="spectator-body">
        {tab === "live" && (
          live.length === 0 ? (
            <EmptyState title="No matches are live right now">Check Up Next for the next matches.</EmptyState>
          ) : (
            <div className="spectator-live-grid">
              {live.map((m) => (
                <LiveMatchCard key={m.id} match={m} data={data} divisionName={divisionName(m.division_id)} />
              ))}
            </div>
          )
        )}
        {tab === "upnext" && <UpNextList matches={upNext} data={data} divisionName={divisionName} />}
        {tab === "results" && <ResultsList matches={results} data={data} divisionName={divisionName} />}
        {tab === "bracket" && <PublicBracketTab data={data} />}
        {tab === "standings" && <PublicStandingsTab data={data} />}
        {tab === "search" && <FindMyTeam data={data} />}
      </main>
    </div>
  );
}
