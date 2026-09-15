// Pure grouping/classification logic behind the Dashboard's "Attention needed"
// panel (see AttentionPanel.jsx) — kept dependency-free so it's cheap to test
// without rendering anything. Deliberately scoped to what the dashboard's
// existing lightweight per-refresh queries already know (tournament/match
// status, court-device status) rather than fetching per-match participant/
// court-assignment detail for every tournament on every focus refresh.
export function computeAttentionItems({ tournaments, matches, courtDevices }) {
  const tournamentById = new Map((tournaments || []).map((t) => [t.id, t]));
  // A tournament that's been removed from the active dashboard (transition_tournament
  // → "cancelled"/"archived", the only "delete this event" action the dashboard
  // exposes — see App.jsx's archiveSelectedTournaments/visibleTournaments) still has
  // its own row and any pre-existing matches/court_devices rows: nothing cascades or
  // deletes them. Without this check, a live/held match or a revoked court device left
  // over from before the removal would keep generating an attention item forever, on
  // every refresh, since the underlying rows never disappear. Only skip when the
  // tournament is actually known and removed — an id absent from `tournaments`
  // (not-yet-loaded case) still falls back to the generic name below.
  function isRemovedFromDashboard(tournamentId) {
    const t = tournamentById.get(tournamentId);
    return t != null && (t.status === "cancelled" || t.status === "archived");
  }

  const byTournament = new Map();
  function bucket(tournamentId) {
    if (!byTournament.has(tournamentId)) {
      const t = tournamentById.get(tournamentId);
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
    if (isRemovedFromDashboard(m.tournament_id)) continue;
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
    if (isRemovedFromDashboard(d.tournament_id)) continue;
    if (activeCourtIds.has(d.court_id)) continue;
    if (flaggedCourtIds.has(d.court_id)) continue;
    flaggedCourtIds.add(d.court_id);
    bucket(d.tournament_id).courtsNeedRepairing++;
  }

  return [...byTournament.values()]
    .filter((item) => item.live || item.held || item.courtsNeedRepairing)
    .sort((a, b) => (b.live - a.live) || (b.held - a.held) || (b.courtsNeedRepairing - a.courtsNeedRepairing));
}
