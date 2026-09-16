import { Card, EmptyState } from "@tournament/ui";
import { courtFor, sideOf, stageTitle } from "../lib.js";

export default function UpNextList({ matches, data, divisionName }) {
  if (!matches.length) {
    return <EmptyState title="Nothing scheduled next">Check back once more matches are set.</EmptyState>;
  }
  const sorted = [...matches].sort((a, b) => (a.round || 0) - (b.round || 0));
  return (
    <div className="stack" style={{ gap: 10 }}>
      {sorted.map((m) => {
        const a = sideOf(m.id, "A", data);
        const b = sideOf(m.id, "B", data);
        const court = courtFor(m, data);
        return (
          <Card key={m.id} className="row spectator-upnext-row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <div>
              <strong>{court ? court.name : "Court TBD"}</strong>
              <div className="muted spectator-subline">
                {divisionName(m.division_id)}
                {m.stage_label ? ` · ${stageTitle(m.stage_label)}` : ""}
              </div>
            </div>
            <div className="spectator-matchup">{a.name} <span className="muted">vs</span> {b.name}</div>
          </Card>
        );
      })}
    </div>
  );
}
