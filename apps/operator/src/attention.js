// Pure grouping/classification logic behind the Dashboard's "Attention needed"
// panel (see AttentionPanel.jsx) — kept dependency-free so it's cheap to test
// without rendering anything. Deliberately scoped to what the dashboard's
// existing lightweight per-refresh queries already know (tournament/match
// status, court-device status) rather than fetching per-match participant/
// court-assignment detail for every tournament on every focus refresh.
export function computeAttentionItems({ tournaments, matches, courtDevices }) {
  const byTournament = new Map();
  function bucket(tournamentId) {
    if (!byTournament.has(tournamentId)) {
      const t = (tournaments || []).find((x) => x.id === tournamentId);
      byTournament.set(tournamentId, {
        tournamentId,
        tournamentName: t?.name || "Tournament",
        live: 0,
        held: 0,
        courtsNeedRepairing: 0,
      });
    }
    return byTournament.get(tournamentId);
  }

  for (const m of matches || []) {
    if (m.status === "in_progress") bucket(m.tournament_id).live++;
    else if (m.status === "postponed") bucket(m.tournament_id).held++;
  }

  // A court "needs re-pairing" when its most recent device was revoked and no
  // active device has replaced it yet — the same concept CourtsPanel already
  // shows per-court, aggregated here per-tournament for the dashboard.
  const activeCourtIds = new Set((courtDevices || []).filter((d) => d.status === "active").map((d) => d.court_id));
  const flaggedCourtIds = new Set();
  for (const d of courtDevices || []) {
    if (d.status !== "revoked") continue;
    if (activeCourtIds.has(d.court_id)) continue;
    if (flaggedCourtIds.has(d.court_id)) continue;
    flaggedCourtIds.add(d.court_id);
    bucket(d.tournament_id).courtsNeedRepairing++;
  }

  return [...byTournament.values()]
    .filter((item) => item.live || item.held || item.courtsNeedRepairing)
    .sort((a, b) => (b.live - a.live) || (b.held - a.held) || (b.courtsNeedRepairing - a.courtsNeedRepairing));
}
