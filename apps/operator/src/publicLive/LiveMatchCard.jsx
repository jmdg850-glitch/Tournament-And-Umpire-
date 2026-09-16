import { Badge, Card, Scoreboard, ServeIndicator, StatusBadge } from "@tournament/ui";
import { courtFor, sideOf, stageTitle } from "../lib.js";

export default function LiveMatchCard({ match, data, divisionName }) {
  const a = sideOf(match.id, "A", data);
  const b = sideOf(match.id, "B", data);
  const court = courtFor(match, data);
  return (
    <Card className="stack spectator-live-card">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
        <strong className="spectator-court">{court ? court.name : "Court TBD"}</strong>
        <StatusBadge status={match.status} />
      </div>
      <div className="muted spectator-subline">
        {divisionName}
        {match.stage_label ? ` · ${stageTitle(match.stage_label)}` : ""}
        {match.round ? ` · Round ${match.round}` : ""}
      </div>
      <Scoreboard
        nameA={a.name}
        nameB={b.name}
        scoreA={match.score_state?.scoreA ?? 0}
        scoreB={match.score_state?.scoreB ?? 0}
        center={<Badge tone="live">LIVE</Badge>}
      />
      <ServeIndicator state={match.score_state} />
    </Card>
  );
}
