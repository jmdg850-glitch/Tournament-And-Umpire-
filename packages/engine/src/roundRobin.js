// Round-robin scheduling — circle method. Pure, no DB, no court assignment.

export function generateRoundRobinSchedule(registrations){
  const ids = registrations.map(r=>r.id);
  let seats = [...ids];
  if (seats.length % 2 !== 0) seats.push(null);
  const n = seats.length;
  if (n < 2) return { rounds: [] };

  const rounds = [];
  for (let r=0; r<n-1; r++){
    const matches = [];
    for (let i=0; i<n/2; i++){
      const a = seats[i], b = seats[n-1-i];
      matches.push({ registrationAId:a, registrationBId:b, isBye: a==null || b==null });
    }
    rounds.push({ round:r+1, matches });
    seats = [seats[0], seats[n-1], ...seats.slice(1,n-1)];
  }
  return { rounds };
}

export function assignCourtsToRoundRobinSchedule(matches, courtIds){
  if (!courtIds?.length) return [];
  const byRound = new Map();
  matches.forEach(m=>{
    if (!byRound.has(m.round)) byRound.set(m.round, []);
    byRound.get(m.round).push(m);
  });
  const patches=[];
  for (const roundMatches of byRound.values()){
    let ci=0;
    for (const m of roundMatches){
      if (m.courtId) continue;
      patches.push({ matchId:m.id, patch:{ courtId: courtIds[ci % courtIds.length] } });
      ci++;
    }
  }
  return patches;
}
