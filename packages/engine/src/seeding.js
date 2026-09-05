// Tournament seeding methods — each returns registrations reordered, seed 1 first. Pure, no DB.

function seedShuffle(a){
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export function seedManual(registrations) {
  return [...(registrations || [])];
}

export function seedRandom(registrations) {
  const ids = seedShuffle((registrations || []).map(r => r.id));
  return ids.map(id => registrations.find(r => r.id === id));
}

export function seedByDuprRating(registrations) {
  const avgDupr = r => {
    const vals = Object.values(r.playerDuprRatings || {}).map(Number).filter(v => !isNaN(v) && v > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  return [...(registrations || [])].sort((a, b) => {
    const da = avgDupr(a), db = avgDupr(b);
    if (da == null && db == null) return 0;
    if (da == null) return 1;
    if (db == null) return -1;
    return db - da;
  });
}

function pairAverageRating(r, roster, isDoubles, baseRating) {
  const ratingOf = pid => {
    const acct = (roster || []).find(p => p.id === pid);
    if (!acct) return baseRating;
    const v = isDoubles ? acct.doublesRating : acct.singlesRating;
    return typeof v === "number" ? v : baseRating;
  };
  const ids = r.playerIds || [];
  return ids.length ? ids.reduce((sum, id) => sum + ratingOf(id), 0) / ids.length : baseRating;
}

export function seedByInternalRanking(registrations, roster, isDoubles, baseRating = 3) {
  return [...(registrations || [])].sort((a, b) => pairAverageRating(b, roster, isDoubles, baseRating) - pairAverageRating(a, roster, isDoubles, baseRating));
}

export function seedByTeamRanking(registrations, roster, isDoubles, baseRating = 3) {
  const list = registrations || [];
  const byTeam = new Map();
  for (const r of list) {
    const key = r.teamId || r.id;
    if (!byTeam.has(key)) byTeam.set(key, []);
    byTeam.get(key).push(pairAverageRating(r, roster, isDoubles, baseRating));
  }
  const teamAvg = key => {
    const vals = byTeam.get(key) || [];
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : baseRating;
  };
  return [...list].sort((a, b) => {
    const ta = teamAvg(a.teamId || a.id), tb = teamAvg(b.teamId || b.id);
    if (ta !== tb) return tb - ta;
    return pairAverageRating(b, roster, isDoubles, baseRating) - pairAverageRating(a, roster, isDoubles, baseRating);
  });
}

export function seedByPreviousResults(registrations, historyMap) {
  const bestRankFor = r => {
    const ids = [...(r.linkedAccountIds || []), ...(r.playerIds || [])];
    const ranks = ids.map(id => historyMap?.[id]).filter(v => typeof v === "number");
    return ranks.length ? Math.min(...ranks) : null;
  };
  return [...(registrations || [])].sort((a, b) => {
    const ra = bestRankFor(a), rb = bestRankFor(b);
    if (ra == null && rb == null) return 0;
    if (ra == null) return 1;
    if (rb == null) return -1;
    return ra - rb;
  });
}
