import { useRef, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, SectionHeader, StandingsTable, StatusBadge, useToast } from "@tournament/ui";
import { ExternalLink } from "lucide-react";
import { courtFor, isTeamMatchup, membersOfParticipant, personLabel, resultFor, scoreLine, sideOf, stageTitle, teamEliminationStandings, umpireFor, unresolvedTieGroups } from "./lib.js";
import BracketImportModal from "./BracketImportModal.jsx";
import { openBracketWindow } from "./useRealtimeChannel.js";

// A pair's `name` (from sideOf) is a single flat string, e.g. "Alice Smith /
// Bob Jones" — shows the individual members on a small muted sub-line below
// it, the same treatment already proven in PlayersPanel's Division Entries
// table, so a long pair name never reads as ambiguous with a single long name.
function SideName({ side, data }) {
  const members = side.participant ? membersOfParticipant(side.participant.id, data.participantMembers) : [];
  if (members.length < 2) return <span>{side.name}</span>;
  return (
    <span>
      <span>{side.name}</span>
      <div className="muted" style={{ fontSize: "0.7rem", lineHeight: 1.3 }}>
        {members.map((m) => personLabel(m.person_id, data.persons)).join(" · ")}
      </div>
    </span>
  );
}

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
        <SideName side={a} data={data} />
        <span className="mono">{match.winner === "A" || match.status === "in_progress" || match.status === "completed" ? (result?.score_a ?? match.score_state?.scoreA ?? "") : ""}</span>
      </div>
      <div className={`side ${match.winner === "B" ? "won" : ""}`}>
        <SideName side={b} data={data} />
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

function TeamEliminationBoard({ division, data }) {
  const parents = data.matches.filter((m) => m.division_id === division.id && isTeamMatchup(m));
  const qualParents = parents.filter((m) => m.stage_label === "round_robin" || m.bracket_side === "round_robin");
  const semis = parents.filter((m) => m.stage_label === "semifinal");
  const bronze = parents.filter((m) => m.stage_label === "bronze");
  const finals = parents.filter((m) => m.stage_label === "final");
  const kidsOf = (list) => data.matches.filter((m) => list.some((p) => p.id === m.parent_match_id));
  const standings = teamEliminationStandings(division, data);
  const playoffsExist = semis.length + bronze.length + finals.length > 0;
  // The pairs the server actually placed into the knockout stage — not a
  // slice of the overall ranking (per-team qualification picks per team).
  const knockoutIds = new Set(parents.filter((m) => !qualParents.includes(m)).map((m) => m.id));
  const placedIds = new Set((data.matchParticipants || [])
    .filter((mp) => knockoutIds.has(mp.match_id) && mp.participant_id)
    .map((mp) => mp.participant_id));
  const qualified = playoffsExist ? standings.filter((row) => placedIds.has(row.registrationId)) : [];
  const tieGroups = unresolvedTieGroups(standings, data);

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
      )}
      {tieGroups.map((names) => (
        <p key={names.join("|")} className="muted" style={{ margin: 0 }}>
          Unresolved tie: {names.join(" and ")} are level on W, L, +/- and PF — their order is set by a fixed fallback, not a tie-break rule.
        </p>
      ))}

      {qualified.length > 0 && (
        <div>
          <h3>Qualified for playoffs</h3>
          <div className="row">
            {qualified.map((row) => {
              const part = data.participants.find((p) => p.id === row.registrationId);
              return (
                <Badge key={row.registrationId} tone={row.rank <= 3 ? `rank-${row.rank}` : "ok"}>
                  #{row.rank} {part?.display_name || row.registrationId} · {row.teamName}
                </Badge>
              );
            })}
          </div>
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

// The read-only per-division board — extracted so both the Brackets tab
// (BracketsPanel below) and the standalone BracketWindow display (opened in
// its own window/monitor, see useRealtimeChannel.js's openBracketWindow) show
// the exact same bracket rendering/data logic. Never duplicate this.
export function DivisionBracketCard({ division, data }) {
  return (
    <Card className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2>{division.name}</h2>
        <Badge>{division.format === "team_elimination" ? "Team elimination" : division.format === "single_elim" ? "Single elimination" : "Round robin"}</Badge>
      </div>
      {division.format === "team_elimination" ? (
        <TeamEliminationBoard division={division} data={data} />
      ) : (
        <SingleElimBoard division={division} data={data} />
      )}
    </Card>
  );
}

export function BracketsPanel({ data, command, load }) {
  const fileInputRef = useRef(null);
  const [importAnalysis, setImportAnalysis] = useState(null);
  const [importError, setImportError] = useState("");
  const toast = useToast();

  async function exportBracket() {
    const { buildBracketExportWorkbook, downloadWorkbook, safeFileNamePart } = await import("./excelImportExport.js");
    const wb = buildBracketExportWorkbook(data);
    downloadWorkbook(wb, `${safeFileNamePart(data.tournament?.name)}_Bracket.xlsx`);
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setImportError("");
    try {
      const buffer = await file.arrayBuffer();
      const { parseBracketWorkbook, analyzeBracketRows } = await import("./excelImportExport.js");
      const { headerErrors, rows } = parseBracketWorkbook(buffer);
      if (headerErrors.length) {
        setImportError(headerErrors.join("; "));
        return;
      }
      if (!rows.length) {
        setImportError("The file has no data rows.");
        return;
      }
      setImportAnalysis(analyzeBracketRows(rows, data));
    } catch (err) {
      setImportError(`Could not read this file: ${err.message || err}`);
    }
  }

  if (!data.divisions.length) {
    return <EmptyState title="No divisions">Create a division before generating a bracket.</EmptyState>;
  }
  return (
    <div className="stack">
      <SectionHeader
        title="Brackets"
        description="Export to Excel, edit players manually, then import the changes back."
        actions={(
          <>
            <Button type="button" variant="secondary" onClick={() => openBracketWindow(data.tournament?.id)}>
              Open Bracket Window <ExternalLink size={15} aria-hidden="true" />
            </Button>
            {command ? (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  style={{ display: "none" }}
                  onChange={handleImportFile}
                />
                <Button type="button" variant="secondary" onClick={exportBracket}>Export Bracket</Button>
                <Button type="button" variant="secondary" onClick={() => fileInputRef.current?.click()}>Import Bracket</Button>
              </>
            ) : null}
          </>
        )}
      />
      {importError && <Alert>{importError}</Alert>}
      {importAnalysis && (
        <BracketImportModal
          analysis={importAnalysis}
          command={command}
          tournamentId={data.tournament?.id}
          onClose={() => setImportAnalysis(null)}
          onImported={async () => {
            await load();
            toast("Bracket import applied");
          }}
        />
      )}
      {data.divisions.map((d) => (
        <DivisionBracketCard key={d.id} division={d} data={data} />
      ))}
    </div>
  );
}
