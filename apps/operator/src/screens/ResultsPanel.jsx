import { useState } from "react";
import { Button, Card, EmptyState, SectionHeader, Select, StandingsTable, StatusBadge, Table } from "@tournament/ui";
import { placementsForDivision, resultFor, scoreLine, sideOf, teamEliminationStandings, teamStandings, unresolvedTieGroups } from "../lib.js";

function PodiumCard({ division, placements }) {
  if (!placements.champion) {
    return (
      <Card className="stack">
        <h2>{division.name}</h2>
        <p className="muted" style={{ margin: 0 }}>No final result yet — standings appear here once the final is complete.</p>
      </Card>
    );
  }
  return (
    <Card className="stack">
      <h2>{division.name}</h2>
      <div className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span><span className="rank-medal" aria-hidden="true">🥇</span> Champion</span>
          <strong>{placements.champion}</strong>
        </div>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span><span className="rank-medal" aria-hidden="true">🥈</span> Runner-up</span>
          <span>{placements.runnerUp}</span>
        </div>
        {placements.third && (
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span><span className="rank-medal" aria-hidden="true">🥉</span> Third place</span>
            <span>{placements.third}</span>
          </div>
        )}
      </div>
    </Card>
  );
}

export function ResultsPanel({ data }) {
  const [divisionFilter, setDivisionFilter] = useState("all");
  const completedAll = data.matches.filter((m) => m.status === "completed" || m.status === "bye");
  const completed = divisionFilter === "all" ? completedAll : completedAll.filter((m) => m.division_id === divisionFilter);
  const shownDivisions = divisionFilter === "all" ? data.divisions : data.divisions.filter((d) => d.id === divisionFilter);

  async function exportReport() {
    const { buildTournamentReportWorkbook, downloadWorkbook, safeFileNamePart } = await import("../excelImportExport.js");
    const wb = buildTournamentReportWorkbook(data);
    downloadWorkbook(wb, `${safeFileNamePart(data.tournament?.name)}_Tournament_Report.xlsx`);
  }

  if (!data.divisions.length) {
    return (
      <div className="stack">
        <SectionHeader title="Results" description="Final standings, podiums, and the completed-match log." />
        <EmptyState title="No divisions yet">Results appear here once a division has matches and completed play.</EmptyState>
      </div>
    );
  }

  return (
    <div className="stack">
      <SectionHeader
        title="Results"
        description="Final standings, podiums, and the completed-match log."
        actions={<Button type="button" variant="secondary" onClick={exportReport}>Export Tournament Report</Button>}
      />
      {data.divisions.length > 1 && (
        <Select label="Division" hideLabel value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
          <option value="all">All divisions</option>
          {data.divisions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      )}
      <div className="grid2">
        {shownDivisions.map((d) => (
          <PodiumCard key={d.id} division={d} placements={placementsForDivision(d, data)} />
        ))}
      </div>

      {shownDivisions.filter((d) => d.format === "team_elimination").map((d) => {
        const teamRows = teamStandings(d, data);
        if (!teamRows.length) return null;
        return (
          <div key={d.id}>
            <h3>{d.name} — team standings</h3>
            <p className="muted" style={{ marginTop: 0 }}>Round-robin qualification stage only — semifinal, bronze, and final results aren't included here.</p>
            <StandingsTable
              nameHeader="Team"
              rows={teamRows.map((row) => ({
                id: row.teamId,
                rank: row.rank,
                name: row.teamName,
                wins: row.wins,
                losses: row.losses,
                pointDiff: row.pointDiff,
              }))}
              extraColumns={[
                { key: "matchesPlayed", header: "MP" },
                { key: "pointsFor", header: "PF" },
                { key: "pointsAgainst", header: "PA" },
              ]}
            />
          </div>
        );
      })}

      {shownDivisions.filter((d) => d.format === "team_elimination").map((d) => {
        const standings = teamEliminationStandings(d, data);
        if (!standings.length) return null;
        return (
          <div key={d.id}>
            <h3>{d.name} — qualification standings</h3>
            <StandingsTable
              rows={standings.map((row) => ({
                id: row.registrationId,
                rank: row.rank,
                name: data.participants.find((p) => p.id === row.registrationId)?.display_name || row.registrationId,
                team: row.teamName,
                wins: row.wins,
                losses: row.losses,
                pointDiff: row.pointDiff,
              }))}
            />
            {unresolvedTieGroups(standings, data).map((names) => (
              <p key={names.join("|")} className="muted" style={{ margin: 0 }}>
                Unresolved tie: {names.join(" and ")} are level on W, L, +/- and PF — their order is set by a fixed fallback, not a tie-break rule.
              </p>
            ))}
          </div>
        );
      })}

      <div className="section-label" style={{ marginTop: "var(--space-3)" }}>Match results</div>
      {!completed.length ? (
        <EmptyState title="No completed matches yet">Results appear here after an umpire completes a match.</EmptyState>
      ) : (
        <Table
          responsive
          columns={[
            {
              key: "match",
              header: "Match",
              render: (m) => (
                <span>
                  <span style={{ fontWeight: m.winner === "A" ? 700 : 400 }}>{sideOf(m.id, "A", data).name}</span>
                  {" vs "}
                  <span style={{ fontWeight: m.winner === "B" ? 700 : 400 }}>{sideOf(m.id, "B", data).name}</span>
                </span>
              ),
            },
            { key: "status", header: "Status", render: (m) => <StatusBadge status={m.status} /> },
            { key: "winner", header: "Winner", render: (m) => m.winner ? sideOf(m.id, m.winner, data).name : "—" },
            { key: "score", header: "Score", render: (m) => scoreLine(m, resultFor(m, data.results)) },
          ]}
          rows={completed}
        />
      )}
    </div>
  );
}
