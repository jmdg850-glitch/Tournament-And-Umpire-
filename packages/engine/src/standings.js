// Tournament standings — pure, compute-on-read from completed matches.

const emptyRow = registrationId => ({
  registrationId, wins:0, losses:0, gamesWon:0, gamesLost:0,
  pointsFor:0, pointsAgainst:0, pointDiff:0, winPct:0, matchesPlayed:0,
});

function stableRandomTiebreak(idA, idB){
  const hash = s => { let h=0; for (let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))|0; return h; };
  const pairSeed = [idA,idB].sort().join("|");
  const parity = hash(pairSeed) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}

export function buildTournamentStandings(registrations, matches){
  const rows = new Map(registrations.map(r => [r.id, emptyRow(r.id)]));
  const completed = matches.filter(m => m.status === "completed" && m.registrationAId && m.registrationBId);

  for (const m of completed){
    const a = rows.get(m.registrationAId), b = rows.get(m.registrationBId);
    if (!a || !b) continue;
    const score = m.score || {};
    const gamesWonA = score.gamesWonA ?? (m.winner === "A" ? 1 : 0);
    const gamesWonB = score.gamesWonB ?? (m.winner === "B" ? 1 : 0);
    const ptsA = score.scoreA ?? 0, ptsB = score.scoreB ?? 0;

    a.matchesPlayed++; b.matchesPlayed++;
    a.gamesWon += gamesWonA; a.gamesLost += gamesWonB;
    b.gamesWon += gamesWonB; b.gamesLost += gamesWonA;
    a.pointsFor += ptsA; a.pointsAgainst += ptsB;
    b.pointsFor += ptsB; b.pointsAgainst += ptsA;
    if (m.winner === "A"){ a.wins++; b.losses++; } else if (m.winner === "B"){ b.wins++; a.losses++; }
  }

  for (const r of rows.values()){
    r.pointDiff = r.pointsFor - r.pointsAgainst;
    r.winPct = r.matchesPlayed ? r.wins / r.matchesPlayed : 0;
  }

  const headToHeadWinner = (idA, idB) => {
    const m = completed.find(x =>
      (x.registrationAId===idA && x.registrationBId===idB) || (x.registrationAId===idB && x.registrationBId===idA));
    if (!m) return 0;
    const aWon = (m.winner==="A" && m.registrationAId===idA) || (m.winner==="B" && m.registrationBId===idA);
    return aWon ? -1 : 1;
  };

  const sorted = [...rows.values()].sort((x,y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (y.winPct !== x.winPct) return y.winPct - x.winPct;
    if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
    const h2h = headToHeadWinner(x.registrationId, y.registrationId);
    if (h2h) return h2h;
    if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
    return stableRandomTiebreak(x.registrationId, y.registrationId);
  });

  return sorted.map((r, i) => ({ ...r, rank: i+1, averageScore: r.matchesPlayed ? +(r.pointsFor / r.matchesPlayed).toFixed(1) : 0 }));
}
