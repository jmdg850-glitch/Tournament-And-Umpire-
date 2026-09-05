// TOURNAMENT STATISTICS — compute-on-read, same philosophy as tournamentStandings.js
// (no stored/cached table). Player-level W/L/points/win-rate and court usage are derived
// purely from already-fetched tournament_matches + tournament_registrations. Duration
// stats (longest/fastest/average match time) need the underlying `matches` table rows
// instead — that's the only place a real start/completion timestamp pair exists
// (data.createdAt = when the live match started, the row's own created_at = when
// endMatch() recorded it complete) — the caller fetches those via
// Cloud.fetchMatchesByIds and passes them in here; this file stays pure/no-fetch like
// every other lib/tournament*.js module.

/** Per-player (not per-registration) aggregate — a doubles registration's 2 players each
 * get their own row, sharing that registration's W/L/points for every completed match. */
export function buildPlayerStatistics(matches, registrations) {
  const completed = matches.filter(m => m.status === "completed" && m.registrationAId && m.registrationBId);
  const regById = new Map(registrations.map(r => [r.id, r]));
  const byPlayer = new Map();
  const ensure = (pid, name) => {
    if (!byPlayer.has(pid)) byPlayer.set(pid, { playerId: pid, name, matchesPlayed: 0, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });
    return byPlayer.get(pid);
  };

  for (const m of completed) {
    const regA = regById.get(m.registrationAId), regB = regById.get(m.registrationBId);
    if (!regA || !regB) continue;
    const score = m.score || {};
    const ptsA = score.scoreA ?? 0, ptsB = score.scoreB ?? 0;
    (regA.playerIds || []).forEach(pid => {
      const row = ensure(pid, regA.playerNames?.[pid] || "Player");
      row.matchesPlayed++; row.pointsFor += ptsA; row.pointsAgainst += ptsB;
      if (m.winner === "A") row.wins++; else if (m.winner === "B") row.losses++;
    });
    (regB.playerIds || []).forEach(pid => {
      const row = ensure(pid, regB.playerNames?.[pid] || "Player");
      row.matchesPlayed++; row.pointsFor += ptsB; row.pointsAgainst += ptsA;
      if (m.winner === "B") row.wins++; else if (m.winner === "A") row.losses++;
    });
  }

  return [...byPlayer.values()]
    .map(r => ({ ...r, pointDiff: r.pointsFor - r.pointsAgainst, winRate: r.matchesPlayed ? +(r.wins / r.matchesPlayed * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.wins - a.wins);
}

/** Completed-match count per court, sorted busiest first. */
export function buildCourtUsage(matches, courts) {
  const completed = matches.filter(m => m.status === "completed" && m.courtId);
  const counts = new Map();
  completed.forEach(m => counts.set(m.courtId, (counts.get(m.courtId) || 0) + 1));
  return (courts || []).map(c => ({ courtId: c.id, courtName: c.name, matchesPlayed: counts.get(c.id) || 0 }))
    .sort((a, b) => b.matchesPlayed - a.matchesPlayed);
}

/** The player appearing in the most completed matches, from an already-built stats array. */
export function mostActivePlayer(playerStats) {
  if (!playerStats.length) return null;
  return [...playerStats].sort((a, b) => b.matchesPlayed - a.matchesPlayed)[0];
}

/** @param {{id:string,data:object,createdAt:string}[]} matchRows from Cloud.fetchMatchesByIds */
export function buildDurationStats(matchRows) {
  const durations = (matchRows || []).map(r => {
    const startedAt = r.data?.createdAt ? new Date(r.data.createdAt).getTime() : null;
    const completedAt = r.createdAt ? new Date(r.createdAt).getTime() : null;
    if (!startedAt || !completedAt || completedAt <= startedAt) return null;
    return completedAt - startedAt;
  }).filter(v => v != null);
  if (!durations.length) return { longestMs: null, fastestMs: null, averageMs: null, count: 0 };
  return {
    longestMs: Math.max(...durations), fastestMs: Math.min(...durations),
    averageMs: Math.round(durations.reduce((a, b) => a + b, 0) / durations.length), count: durations.length,
  };
}
