import { useCallback, useEffect, useState } from "react";
import { Alert, LoadingState, Scoreboard, ServeIndicator, StatusBadge } from "@tournament/ui";
import { Radio } from "lucide-react";
import { applyDeskRealtime, applyMatchIfScoped, matchLiveChannelName } from "@tournament/engine";
import { useRealtimeChannel } from "./useRealtimeChannel.js";
import { courtFor, sideOf } from "./lib.js";

export default function LiveMatchWindow({ supabase, session, tournamentId, matchId }) {
  const [match, setMatch] = useState(null);
  const [data, setData] = useState({
    matches: [],
    courts: [],
    courtAssignments: [],
    matchParticipants: [],
    participants: [],
    teams: [],
    persons: [],
  });
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const m = await supabase.from("matches").select("*").eq("id", matchId).maybeSingle();
    if (m.error) {
      setError(m.error.message);
      return;
    }
    if (!m.data || m.data.tournament_id !== tournamentId) {
      setError("This live window is not authorized for that match.");
      setMatch(null);
      return;
    }
    const [sides, courtsA, courts, participants] = await Promise.all([
      supabase.from("match_participants").select("*").eq("match_id", matchId),
      supabase.from("court_assignments").select("*").eq("match_id", matchId),
      supabase.from("courts").select("*").eq("tournament_id", tournamentId),
      supabase.from("participants").select("*").eq("tournament_id", tournamentId),
    ]);
    const first = [sides, courtsA, courts, participants].find((x) => x.error);
    if (first?.error) {
      setError(first.error.message);
      return;
    }
    setError("");
    setMatch(m.data);
    setData({
      matches: [m.data],
      courts: courts.data || [],
      courtAssignments: courtsA.data || [],
      matchParticipants: sides.data || [],
      participants: participants.data || [],
      teams: [],
      persons: [],
    });
  }, [supabase, matchId, tournamentId]);

  useRealtimeChannel({
    supabase,
    name: matchLiveChannelName(matchId),
    enabled: Boolean(session),
    specs: [
      { event: "*", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
      { event: "*", schema: "public", table: "court_assignments", filter: `match_id=eq.${matchId}` },
    ],
    onPayload: (payload) => {
      if (payload.table === "court_assignments") {
        setData((current) => {
          const next = applyDeskRealtime(
            {
              tournament: { id: tournamentId },
              matches: current.matches?.length ? current.matches : [{ id: matchId, tournament_id: tournamentId }],
              results: [],
              courtAssignments: current.courtAssignments || [],
            },
            "court_assignments",
            payload.eventType || payload.event,
            payload.new,
            payload.old,
          );
          return { ...current, courtAssignments: next.courtAssignments };
        });
        return;
      }
      const row = payload.new || payload.old;
      if (!row) return;
      setMatch((current) => applyMatchIfScoped(current, payload.new || row, matchId));
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
        <Alert>Sign in on the organizer desk to view this live match.</Alert>
      </div>
    );
  }
  if (error && !match) {
    return (
      <div className="live-window">
        <Alert>{error}</Alert>
      </div>
    );
  }
  if (!match) {
    return (
      <div className="live-window">
        <LoadingState label="Loading live match" />
      </div>
    );
  }

  const a = sideOf(match.id, "A", data);
  const b = sideOf(match.id, "B", data);
  const court = courtFor(match, data);
  const score = match.score_state || {};

  return (
    <div className="live-window" data-readonly="true">
      <header className="live-window-top">
        <div className="kicker" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Radio size={13} aria-hidden="true" /> Live</div>
        <h1>{court?.name || "Unassigned court"}</h1>
        <StatusBadge status={match.status} />
      </header>
      {error ? <Alert>{error}</Alert> : null}
      <Scoreboard
        nameA={a.name}
        nameB={b.name}
        scoreA={score.scoreA ?? 0}
        scoreB={score.scoreB ?? 0}
        center={(
          <>
            <div className="game">Game {score.gameNumber || 1}</div>
            <div className="muted">{match.stage_label ? String(match.stage_label).replaceAll("_", " ") : `Round ${match.round}`}</div>
          </>
        )}
      />
      <ServeIndicator state={score} className="live-serve-status" />
      <p className="live-window-meta">
        {(score.gamesWonA ?? 0)} – {(score.gamesWonB ?? 0)} games
        {score.servingTeam ? ` · ${score.servingTeam === "A" ? a.name : b.name} serves` : ""}
      </p>
    </div>
  );
}
