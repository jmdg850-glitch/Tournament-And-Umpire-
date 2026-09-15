import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, EmptyState, LoadingState, StatusBadge } from "@tournament/ui";
import { ClipboardList } from "lucide-react";
import { applyDeskRealtime, divisionDisplayChannelName, removeById, upsertById } from "@tournament/engine";
import { useRealtimeChannel } from "./useRealtimeChannel.js";
import { courtFor, loadDeskData, resultFor, scoreLine, sideOf, stageTitle, umpireFor } from "./lib.js";

// A read-only, division-scoped match display — see useRealtimeChannel.js's
// openMatchDisplayWindow. Every division can have its own one of these open at
// once (Matches tab → "Open Match Window" per division); each window is keyed
// and addressed purely by `divisionId` in its own hash route
// (#/matches-display/<tournamentId>/<divisionId>, see
// packages/engine/src/liveSync.js), so two open windows for two different
// divisions can never repoint into each other — see liveSync.test.js's
// "two divisions never resolve to the same route or channel" coverage.
export default function MatchDisplayWindow({ supabase, session, tournamentId, divisionId }) {
  const [division, setDivision] = useState(null);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data: next, error: err } = await loadDeskData(supabase, tournamentId);
    if (err) {
      setError(err.message);
      return;
    }
    const found = (next.divisions || []).find((d) => d.id === divisionId);
    if (!found) {
      // Handles both "never existed for this tournament" and "was deleted
      // since this window was opened" identically — a clear message instead
      // of a stale or crashed display (see Feature B: a deleted division
      // must not keep appearing, even in an already-open display window).
      setError("This division is no longer available in this tournament.");
      setDivision(null);
      return;
    }
    setError("");
    setDivision(found);
    setData(next);
  }, [supabase, tournamentId, divisionId]);

  useRealtimeChannel({
    supabase,
    name: divisionDisplayChannelName(divisionId),
    enabled: Boolean(session && divisionId),
    specs: [
      { event: "*", schema: "public", table: "matches", filter: `division_id=eq.${divisionId}` },
      { event: "*", schema: "public", table: "court_assignments" },
    ],
    onPayload: (payload) => {
      if (payload.table === "matches") {
        const row = payload.new || payload.old;
        const eventType = payload.eventType || payload.event;
        setData((cur) => {
          if (!cur) return cur;
          if (eventType === "DELETE") return { ...cur, matches: removeById(cur.matches, row?.id) };
          if (!row) return cur;
          return { ...cur, matches: upsertById(cur.matches, row) };
        });
        return;
      }
      setData((cur) => {
        if (!cur) return cur;
        const next = applyDeskRealtime(
          { tournament: cur.tournament, matches: cur.matches, results: cur.results, courtAssignments: cur.courtAssignments },
          "court_assignments",
          payload.eventType || payload.event,
          payload.new,
          payload.old,
        );
        return { ...cur, courtAssignments: next.courtAssignments };
      });
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

  if (!session) {
    return (
      <div className="live-window">
        <Alert>Sign in on the organizer desk to view this match display.</Alert>
      </div>
    );
  }
  if (error && !division) {
    return (
      <div className="live-window">
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (!division || !data) {
    return (
      <div className="live-window">
        <LoadingState label="Loading matches" />
      </div>
    );
  }

  const matches = data.matches.filter((m) => m.division_id === divisionId);
  const live = matches.filter((m) => m.status === "in_progress");
  const upcoming = matches.filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const held = matches.filter((m) => m.status === "postponed");
  const completed = matches.filter((m) => m.status === "completed" || m.status === "bye");

  return (
    <div className="live-window" data-readonly="true">
      <header className="live-window-top">
        <div className="kicker" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <ClipboardList size={13} aria-hidden="true" /> {data.tournament?.name}
        </div>
        <h1>{division.name}</h1>
        {live.length > 0 ? <Badge tone="live">{live.length} live</Badge> : null}
      </header>
      {error ? <Alert>{error}</Alert> : null}

      {matches.length === 0 ? (
        <EmptyState title="No matches yet">Generate a bracket for this division to see matches here.</EmptyState>
      ) : (
        <div className="stack display-match-groups">
          {live.length > 0 && (
            <DisplayMatchGroup title="Live now" tone="live" matches={live} data={data} />
          )}
          {held.length > 0 && (
            <DisplayMatchGroup title="On hold" tone="warn" matches={held} data={data} />
          )}
          <DisplayMatchGroup title="Upcoming" matches={upcoming} data={data} empty="Nothing queued right now." />
          <DisplayMatchGroup title="Completed" matches={completed} data={data} empty="No completed matches yet." collapsedByDefault />
        </div>
      )}
    </div>
  );
}

function DisplayMatchGroup({ title, tone, matches, data, empty, collapsedByDefault }) {
  const [open, setOpen] = useState(!collapsedByDefault);
  return (
    <section className="display-match-group">
      <button
        type="button"
        className="display-match-group-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`section-label${tone ? ` tone-${tone}` : ""}`} style={{ margin: 0 }}>{title} ({matches.length})</span>
      </button>
      {open && (
        matches.length === 0 ? (
          empty ? <p className="muted display-match-empty">{empty}</p> : null
        ) : (
          <div className="stack display-match-rows">
            {matches.map((m) => (
              <DisplayMatchRow key={m.id} match={m} data={data} />
            ))}
          </div>
        )
      )}
    </section>
  );
}

function DisplayMatchRow({ match, data }) {
  const a = sideOf(match.id, "A", data);
  const b = sideOf(match.id, "B", data);
  const court = courtFor(match, data);
  const ump = umpireFor(match, data);
  const result = resultFor(match, data.results);
  const isLive = match.status === "in_progress";
  const score = isLive ? `${match.score_state?.scoreA ?? 0} – ${match.score_state?.scoreB ?? 0}` : scoreLine(match, result);
  return (
    <div className="display-match-row" data-live={isLive ? "true" : undefined}>
      <div className="display-match-row-main">
        <div className="display-match-names">
          <span className={match.winner === "A" ? "won" : undefined}>{a.name}</span>
          <span className="muted"> vs </span>
          <span className={match.winner === "B" ? "won" : undefined}>{b.name}</span>
        </div>
        <div className="muted display-match-meta">
          {court ? court.name : "No court"}
          {ump ? ` · ${ump.name}` : ""}
          {match.stage_label ? ` · ${stageTitle(match.stage_label)}` : ` · Round ${match.round}`}
        </div>
      </div>
      <div className="display-match-row-side">
        <span className="display-match-score">{score}</span>
        <StatusBadge status={match.status} />
      </div>
    </div>
  );
}
