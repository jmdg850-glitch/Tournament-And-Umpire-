import { Card, EmptyState, StandingsTable } from "@tournament/ui";
import { teamEliminationStandings } from "../lib.js";

// Standings only have a defined meaning for team-elimination divisions today
// (round-robin qualification pods feeding semifinal seeding) — see
// lib.js's teamEliminationStandings, the same source the authenticated
// Brackets tab uses. Other formats show their progress via the Bracket tab
// instead, which is why this tab quietly omits them rather than inventing a
// second standings calculation.
export default function PublicStandingsTab({ data }) {
  const teamDivisions = data.divisions.filter((d) => d.format === "team_elimination");
  const sections = teamDivisions
    .map((division) => ({ division, rows: teamEliminationStandings(division, data) }))
    .filter((s) => s.rows.length > 0);

  if (!sections.length) {
    return <EmptyState title="No standings yet">Standings appear once qualification matches are complete.</EmptyState>;
  }

  return (
    <div className="stack">
      {sections.map(({ division, rows }) => (
        <Card key={division.id} className="stack">
          <h2>{division.name}</h2>
          <StandingsTable
            rows={rows.map((row) => ({
              id: row.registrationId,
              rank: row.rank,
              name: data.participants.find((p) => p.id === row.registrationId)?.display_name || row.registrationId,
              team: row.teamName,
              wins: row.wins,
              losses: row.losses,
              pointDiff: row.pointDiff,
            }))}
          />
        </Card>
      ))}
    </div>
  );
}
