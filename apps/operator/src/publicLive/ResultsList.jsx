import { Card, EmptyState } from "@tournament/ui";
import { courtFor, resultFor, scoreLine, sideOf, stageTitle } from "../lib.js";

export default function ResultsList({ matches, data, divisionName }) {
  if (!matches.length) {
    return <EmptyState title="No results yet">Completed matches will show up here.</EmptyState>;
  }
  const sorted = [...matches].sort((a, b) => new Date(b.completed_at || 0) - new Date(a.completed_at || 0));
  return (
    <div className="stack" style={{ gap: 10 }}>
      {sorted.map((m) => {
        const a = sideOf(m.id, "A", data);
        const b = sideOf(m.id, "B", data);
        const court = courtFor(m, data);
        const result = resultFor(m, data.results);
        return (
          <Card key={m.id} className="stack spectator-result-row" style={{ gap: 4 }}>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <strong>{court ? court.name : "Court TBD"}</strong>
              <span className="muted spectator-subline">
                {divisionName(m.division_id)}
                {m.stage_label ? ` · ${stageTitle(m.stage_label)}` : ""}
              </span>
            </div>
            <div className={`row spectator-matchup ${m.winner === "A" ? "won" : ""}`}>
              <span>{a.name}</span>
            </div>
            <div className={`row spectator-matchup ${m.winner === "B" ? "won" : ""}`}>
              <span>{b.name}</span>
            </div>
            <div className="muted">Final: {scoreLine(m, result)}</div>
          </Card>
        );
      })}
    </div>
  );
}
