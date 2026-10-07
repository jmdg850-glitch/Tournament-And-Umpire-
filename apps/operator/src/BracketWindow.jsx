import { useEffect } from "react";
import { Alert, EmptyState, LoadingState } from "@tournament/ui";
import { Trophy } from "lucide-react";
import { applyDeskRealtime, deskLiveChannelName } from "@tournament/engine";
import { useRealtimeChannel } from "./useRealtimeChannel.js";
import { useSavedDeskData } from "./useSavedDeskData.js";
import OfflineStatusBanner from "./OfflineStatusBanner.jsx";
import { DivisionBracketCard } from "./brackets.jsx";
import { ExpandCollapseAll, useCollapsedSections } from "./CollapsibleSection.jsx";
import { playableMatches } from "./lib.js";

// A read-only, display-first bracket view opened in its own window (see
// useRealtimeChannel.js's openBracketWindow and TournamentDesk's Live window
// for the established precedent this follows) — suitable for a second
// monitor or TV. It reuses the exact same data loading (loadDeskData) and
// bracket rendering (DivisionBracketCard/brackets.jsx) as the operator's own
// Brackets tab: there is no second copy of bracket business logic here, and
// this window never sends a command — it only ever reads.
export default function BracketWindow({ supabase, session, repository, tournamentId }) {
  // Falls back to this computer's saved copy of the tournament when offline.
  const { data, setData, error, load, verified, identityMode, bannerLoad, settled } = useSavedDeskData({ supabase, session, repository, tournamentId });

  useRealtimeChannel({
    supabase,
    name: deskLiveChannelName(tournamentId),
    enabled: Boolean(session && tournamentId) && verified,
    specs: [
      { event: "*", schema: "public", table: "matches", filter: `tournament_id=eq.${tournamentId}` },
      { event: "*", schema: "public", table: "match_results" },
      { event: "*", schema: "public", table: "court_assignments" },
    ],
    onPayload: (payload) => {
      const table = payload.table;
      const eventType = payload.eventType || payload.event;
      setData((prev) => (prev ? applyDeskRealtime(prev, table, eventType, payload.new, payload.old) : prev));
    },
    onSubscribed: load,
  });

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

  // Divisions can be collapsed to their header so a large tournament doesn't
  // mean scrolling past every bracket to reach the next division.
  const sections = useCollapsedSections(`resetiq:collapsed:bracket-window:${tournamentId}`);
  const tournamentName = data?.tournament?.name;
  useEffect(() => {
    document.title = tournamentName ? `Bracket · ${tournamentName}` : "Bracket";
  }, [tournamentName]);

  if (!session) {
    return (
      <div className="live-window">
        <Alert>Sign in on the organizer desk to view this bracket.</Alert>
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="live-window">
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="live-window">
        {settled ? <OfflineStatusBanner load={bannerLoad} identityMode={identityMode} onRetry={load} /> : <LoadingState label="Loading bracket" />}
      </div>
    );
  }
  if (!data.tournament) {
    return (
      <div className="live-window">
        <Alert>This tournament is not available. It may have been removed, or you're no longer a member.</Alert>
      </div>
    );
  }

  const divisionIds = data.divisions.map((d) => d.id);
  const liveCount = playableMatches(data.matches).filter((m) => m.status === "in_progress").length;
  const summary = [
    `${data.divisions.length} ${data.divisions.length === 1 ? "division" : "divisions"}`,
    liveCount ? `${liveCount} live` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="live-window" data-readonly="true" data-view="bracket">
      <header className="live-window-top display-window-header">
        <div className="display-window-heading">
          <div className="kicker" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Trophy size={13} aria-hidden="true" /> Bracket
          </div>
          <h1>{data.tournament.name}</h1>
          <p className="display-window-summary">{summary}</p>
        </div>
        <ExpandCollapseAll ids={divisionIds} sections={sections} />
      </header>
      <OfflineStatusBanner load={bannerLoad} identityMode={identityMode} onRetry={load} />
      {error ? <Alert>{error}</Alert> : null}
      {data.divisions.length === 0 ? (
        <EmptyState title="No divisions yet" />
      ) : (
        <div className="stack">
          {data.divisions.map((d) => (
            <DivisionBracketCard key={d.id} division={d} data={data} open={sections.isOpen(d.id)} onToggle={() => sections.toggle(d.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
