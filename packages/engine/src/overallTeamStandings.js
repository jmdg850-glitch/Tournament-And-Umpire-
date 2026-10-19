// Overall Team Standings: one table across every team-elimination division of
// a tournament. Pure — callers pass already-official results.
//
// Aggregation policy (shown to organizers in the Operator caption too):
//   - Grouping: teams are stored per division, so the same club in two
//     divisions is two team rows. Rows are combined by team NAME (trimmed,
//     inner whitespace collapsed, case-insensitive). The displayed name is the
//     first one seen in division order.
//   - Counted: every COMPLETED pair match of a team-elimination division, in
//     every stage (qualification round robin, quarterfinals, semifinals, bronze,
//     final). Callers exclude cancelled, abandoned, unplayed and bye matches.
//     Each match counts once (deduplicated by match id).
//   - Win by default: one win for the winner, one loss for the other side.
//     Points come from the recorded administrative score, or 0–0 if none.
//   - Columns: matches played, wins, losses, points for/against, point
//     difference, and a per-division breakdown. Teams with different numbers
//     of matches are shown as they are (MP column), never normalized.
//   - Ranking: wins (high) → point difference (high) → points for (high).
//     Teams still level on all three share a rank and are listed by name.

export function normalizeTeamNameKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

const emptyLine = () => ({ played: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });

function addResult(line, won, pf, pa) {
  line.played += 1;
  if (won) line.wins += 1; else line.losses += 1;
  line.pointsFor += pf;
  line.pointsAgainst += pa;
}

const points = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

/**
 * @param {object} input
 * @param {{id:string,name:string,divisionId:string}[]} input.teams
 * @param {{id:string,name:string}[]} [input.divisions] order = display order
 * @param {{matchId:string,divisionId:string,teamAId:string,teamBId:string,winnerSlot:"A"|"B",scoreA:number,scoreB:number}[]} input.pairResults
 */
export function buildOverallTeamStandings({ teams = [], divisions = [], pairResults = [] } = {}) {
  const divisionOrder = new Map(divisions.map((d, i) => [d.id, i]));
  const divisionName = new Map(divisions.map((d) => [d.id, d.name]));
  const orderedTeams = [...teams].sort((x, y) => {
    const dx = divisionOrder.get(x.divisionId) ?? Number.MAX_SAFE_INTEGER;
    const dy = divisionOrder.get(y.divisionId) ?? Number.MAX_SAFE_INTEGER;
    return dx - dy;
  });

  const rows = new Map(); // key → row
  const teamKey = new Map(); // team id → key
  for (const t of orderedTeams) {
    const key = normalizeTeamNameKey(t.name);
    if (!key) continue;
    teamKey.set(t.id, key);
    if (!rows.has(key)) rows.set(key, { key, name: String(t.name).trim().replace(/\s+/g, " "), teamIds: [], ...emptyLine(), divisions: new Map() });
    const row = rows.get(key);
    row.teamIds.push(t.id);
    if (!row.divisions.has(t.divisionId)) {
      row.divisions.set(t.divisionId, { divisionId: t.divisionId, divisionName: divisionName.get(t.divisionId) ?? null, ...emptyLine() });
    }
  }

  const seen = new Set();
  for (const r of pairResults) {
    if (!r || seen.has(r.matchId)) continue;
    if (r.winnerSlot !== "A" && r.winnerSlot !== "B") continue;
    seen.add(r.matchId);
    const a = points(r.scoreA);
    const b = points(r.scoreB);
    for (const [slot, tid, pf, pa] of [["A", r.teamAId, a, b], ["B", r.teamBId, b, a]]) {
      const row = rows.get(teamKey.get(tid));
      if (!row) continue;
      const won = r.winnerSlot === slot;
      addResult(row, won, pf, pa);
      if (!row.divisions.has(r.divisionId)) {
        row.divisions.set(r.divisionId, { divisionId: r.divisionId, divisionName: divisionName.get(r.divisionId) ?? null, ...emptyLine() });
      }
      addResult(row.divisions.get(r.divisionId), won, pf, pa);
    }
  }

  const list = [...rows.values()].map((row) => ({
    key: row.key,
    name: row.name,
    teamIds: row.teamIds,
    played: row.played,
    wins: row.wins,
    losses: row.losses,
    pointsFor: row.pointsFor,
    pointsAgainst: row.pointsAgainst,
    pointDiff: row.pointsFor - row.pointsAgainst,
    divisions: [...row.divisions.values()]
      .map((d) => ({ ...d, pointDiff: d.pointsFor - d.pointsAgainst }))
      .sort((x, y) => (divisionOrder.get(x.divisionId) ?? Number.MAX_SAFE_INTEGER) - (divisionOrder.get(y.divisionId) ?? Number.MAX_SAFE_INTEGER)),
  }));

  const cmp = (x, y) => (y.wins - x.wins) || (y.pointDiff - x.pointDiff) || (y.pointsFor - x.pointsFor);
  list.sort((x, y) => cmp(x, y) || x.key.localeCompare(y.key));
  let rank = 0;
  list.forEach((row, i) => {
    if (i === 0 || cmp(list[i - 1], row) !== 0) rank = i + 1;
    row.rank = rank;
  });
  return list;
}
