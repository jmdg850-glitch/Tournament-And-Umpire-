import { rankIndividualPairsForSemifinals } from "@tournament/engine";
import { Badge, Card, EmptyState, StatusBadge, Table } from "@tournament/ui";
import { courtFor, isTeamMatchup, resultFor, scoreLine, sideOf, stageTitle, umpireFor } from "./lib.js";

function MatchChip({ match, data }) {
  const a = sideOf(match.id, "A", data);
  const b = sideOf(match.id, "B", data);
  const result = resultFor(match, data.results);
  const court = courtFor(match, data);
  const ump = umpireFor(match, data);
  const score = scoreLine(match, result);
  return (
    <div className="match-chip" data-status={match.status}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <StatusBadge status={match.status} />
        {match.stage_label ? <Badge>{stageTitle(match.stage_label)}</Badge> : null}
      </div>
      <div className={`side ${match.winner === "A" ? "won" : ""}`}>
        <span>{a.name}</span>
        <span className="mono">{match.winner === "A" || match.status === "in_progress" || match.status === "completed" ? (result?.score_a ?? match.score_state?.scoreA ?? "") : ""}</span>
      </div>
      <div className={`side ${match.winner === "B" ? "won" : ""}`}>
        <span>{b.name}</span>
        <span className="mono">{match.winner === "B" || match.status === "in_progress" || match.status === "completed" ? (result?.score_b ?? match.score_state?.scoreB ?? "") : ""}</span>
      </div>
      <div className="muted" style={{ fontSize: "0.78rem" }}>
        {court ? court.name : "No court"}
        {ump ? ` · ${ump.name}` : ""}
        {match.status === "completed" ? ` · ${score}` : ""}
      </div>
    </div>
  );
}

function RoundColumn({ title, matches, data }) {
  return (
    <div className="round">
      <h3>{title}</h3>
      {matches.length === 0 ? <div className="muted">—</div> : matches.map((m) => <MatchChip key={m.id} match={m} data={data} />)}
    </div>
  );
}

function teStandings(division, data) {
  const teams = data.teams
    .filter((t) => t.division_id === division.id)
    .map((t) => ({
      teamId: t.id,
      teamName: t.name,
      pairs: data.participants.filter((p) => p.team_id === t.id).map((p) => ({ id: p.id })),
    }));
  const parents = data.matches.filter((m) => m.division_id === division.id && !m.parent_match_id);
  const teamMatchups = parents.map((m) => ({
    id: m.id,
    stage: m.stage_label === "round_robin" || m.bracket_side === "round_robin" ? "round_robin" : m.stage_label,
    status: m.status,
  }));
  const pairMatches = data.matches
    .filter((m) => m.division_id === division.id && m.parent_match_id)
    .map((m) => {
      const a = data.matchParticipants.find((p) => p.match_id === m.id && p.slot === "A");
      const b = data.matchParticipants.find((p) => p.match_id === m.id && p.slot === "B");
      const result = resultFor(m, data.results);
      return {
        id: m.id,
        teamMatchupId: m.parent_match_id,
        status: m.status,
        winner: m.winner,
        registrationAId: a?.participant_id,
        registrationBId: b?.participant_id,
        score: {
          scoreA: result?.score_a ?? m.score_state?.scoreA ?? 0,
          scoreB: result?.score_b ?? m.score_state?.scoreB ?? 0,
        },
      };
    });
  try {
    return rankIndividualPairsForSemifinals(teams, teamMatchups, pairMatches);
  } catch {
    return [];
  }
}

function TeamEliminationBoard({ division, data }) {
  const parents = data.matches.filter((m) => m.division_id === division.id && isTeamMatchup(m));
  const qualParents = parents.filter((m) => m.stage_label === "round_robin" || m.bracket_side === "round_robin");
  const semis = parents.filter((m) => m.stage_label === "semifinal");
  const bronze = parents.filter((m) => m.stage_label === "bronze");
  const finals = parents.filter((m) => m.stage_label === "final");
  const kidsOf = (list) => data.matches.filter((m) => list.some((p) => p.id === m.parent_match_id));
  const standings = teStandings(division, data);
  const playoffsExist = semis.length + bronze.length + finals.length > 0;
  const qualified = playoffsExist ? standings.slice(0, 4) : [];

  return (
    <div className="stack">
      <div className="flow">
        <span className={qualParents.length ? "here" : ""}>Qualification</span>
        <span className="sep">→</span>
        <span className={standings.length ? "here" : ""}>Standings</span>
        <span className="sep">→</span>
        <span className={qualified.length ? "here" : ""}>Qualified</span>
        <span className="sep">→</span>
        <span className={semis.length ? "here" : ""}>Semifinals</span>
        <span className="sep">→</span>
        <span className={bronze.length || finals.length ? "here" : ""}>Bronze / Final</span>
      </div>

      {qualParents.length === 0 ? (
        <EmptyState title="No qualification matches yet">Generate qualification from Divisions after teams and players are registered.</EmptyState>
      ) : (
        <div className="bracket">
          <RoundColumn title="Qualification" matches={kidsOf(qualParents)} data={data} />
        </div>
      )}

      {standings.length > 0 && (
        <Table
          columns={[
            { key: "rank", header: "Rank" },
            {
              key: "pair",
              header: "Pair",
              render: (row) => data.participants.find((p) => p.id === row.registrationId)?.display_name || row.registrationId,
            },
            { key: "teamName", header: "Team" },
            { key: "wins", header: "W" },
            { key: "losses", header: "L" },
            { key: "pointDiff", header: "+/−" },
          ]}
          rows={standings.map((row) => ({ id: row.registrationId, ...row }))}
        />
      )}

      {qualified.length > 0 && (
        <div>
          <h3>Qualified</h3>
          <ol>
            {qualified.map((row) => {
              const part = data.participants.find((p) => p.id === row.registrationId);
              return <li key={row.registrationId}>{part?.display_name || row.registrationId} · {row.teamName}</li>;
            })}
          </ol>
        </div>
      )}

      {(semis.length > 0 || bronze.length > 0 || finals.length > 0) && (
        <div className="bracket">
          <RoundColumn title="Semifinals" matches={[...semis, ...kidsOf(semis)]} data={data} />
          <RoundColumn title="Bronze" matches={[...bronze, ...kidsOf(bronze)]} data={data} />
          <RoundColumn title="Final" matches={[...finals, ...kidsOf(finals)]} data={data} />
        </div>
      )}
    </div>
  );
}

function SingleElimBoard({ division, data }) {
  const matches = data.matches
    .filter((m) => m.division_id === division.id && !isTeamMatchup(m))
    .sort((a, b) => (a.round - b.round) || (a.bracket_position - b.bracket_position));
  if (!matches.length) {
    return <EmptyState title="No bracket yet">Generate a bracket from Divisions once players are registered.</EmptyState>;
  }
  const rounds = [...new Set(matches.map((m) => m.round))];
  return (
    <div className="bracket">
      {rounds.map((round) => (
        <RoundColumn
          key={round}
          title={
            matches.some((m) => m.round === round && m.stage_label === "bronze")
              ? "Bronze"
              : matches.some((m) => m.round === round && m.stage_label === "final")
                ? "Final"
                : `Round ${round}`
          }
          matches={matches.filter((m) => m.round === round)}
          data={data}
        />
      ))}
    </div>
  );
}

export function BracketsPanel({ data }) {
  if (!data.divisions.length) {
    return <EmptyState title="No divisions">Create a division before generating a bracket.</EmptyState>;
  }
  return (
    <div className="stack">
      {data.divisions.map((d) => (
        <Card className="stack" key={d.id}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>{d.name}</h2>
            <Badge>{d.format === "team_elimination" ? "Team elimination" : d.format === "single_elim" ? "Single elimination" : "Round robin"}</Badge>
          </div>
          {d.format === "team_elimination" ? (
            <TeamEliminationBoard division={d} data={data} />
          ) : (
            <SingleElimBoard division={d} data={data} />
          )}
        </Card>
      ))}
    </div>
  );
}
