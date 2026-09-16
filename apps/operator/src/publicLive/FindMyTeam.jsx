import { useMemo, useState } from "react";
import { Badge, Card, Input } from "@tournament/ui";
import { courtFor, resultFor, scoreLine } from "../lib.js";

// { match, slot } pairs for every match this participant/team played in —
// `slot` (A/B) is needed to say "Won"/"Lost" rather than just the raw score.
function matchSlotsFor(participantId, teamId, data) {
  return data.matchParticipants
    .filter((mp) => (participantId && mp.participant_id === participantId) || (teamId && mp.team_id === teamId))
    .map((mp) => ({ match: data.matches.find((m) => m.id === mp.match_id), slot: mp.slot }))
    .filter((x) => x.match);
}

function statusFor(matchSlots, data) {
  const live = matchSlots.find((x) => x.match.status === "in_progress");
  if (live) {
    const court = courtFor(live.match, data);
    return { label: "LIVE NOW", detail: court ? court.name : "On court", tone: "live" };
  }
  const upNext = matchSlots
    .filter((x) => ["scheduled", "ready", "assigned"].includes(x.match.status))
    .sort((a, b) => (a.match.round || 0) - (b.match.round || 0))[0];
  if (upNext) {
    const court = courtFor(upNext.match, data);
    return { label: "UP NEXT", detail: court ? court.name : "Court TBD", tone: "muted" };
  }
  const completed = matchSlots
    .filter((x) => x.match.status === "completed")
    .sort((a, b) => new Date(b.match.completed_at || 0) - new Date(a.match.completed_at || 0))[0];
  if (completed) {
    const result = resultFor(completed.match, data.results);
    const score = scoreLine(completed.match, result);
    const outcome = completed.match.winner ? (completed.match.winner === completed.slot ? "Won" : "Lost") : "Final";
    return { label: "RESULT", detail: `${outcome} ${score}`, tone: "muted" };
  }
  return { label: "NO MATCHES YET", detail: "", tone: "muted" };
}

export default function FindMyTeam({ data }) {
  const [query, setQuery] = useState("");

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const personHitIds = new Set(
      data.persons.filter((p) => p.display_name.toLowerCase().includes(q)).map((p) => p.id)
    );
    const personParticipantIds = new Set(
      data.participantMembers.filter((pm) => personHitIds.has(pm.person_id)).map((pm) => pm.participant_id)
    );
    const participantById = new Map();
    for (const p of data.participants) {
      if (p.display_name.toLowerCase().includes(q) || personParticipantIds.has(p.id)) participantById.set(p.id, p);
    }
    const teamHits = data.teams.filter((t) => t.name.toLowerCase().includes(q));

    const participantRows = [...participantById.values()].map((participant) => ({
      key: `p:${participant.id}`,
      name: participant.display_name,
      ...statusFor(matchSlotsFor(participant.id, null, data), data),
    }));
    const teamRows = teamHits.map((team) => ({
      key: `t:${team.id}`,
      name: team.name,
      ...statusFor(matchSlotsFor(null, team.id, data), data),
    }));
    return [...participantRows, ...teamRows];
  }, [query, data]);

  return (
    <div className="stack">
      <Input
        label="Find my team"
        placeholder="Search player or team…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {query.trim() && results.length === 0 ? (
        <p className="muted">No player or team matches "{query.trim()}".</p>
      ) : null}
      <div className="stack" style={{ gap: 8 }}>
        {results.map((r) => (
          <Card key={r.key} className="row spectator-find-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <strong>{r.name}</strong>
            <Badge tone={r.tone}>{r.label}{r.detail ? ` · ${r.detail}` : ""}</Badge>
          </Card>
        ))}
      </div>
    </div>
  );
}
