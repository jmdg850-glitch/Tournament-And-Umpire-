// Round-robin scheduling — circle method. Pure, no DB, no court assignment
// (court assignment stays manual everywhere in this app).
//
// registrations: [{id, ...}] in the order they should be seated (seed order if
// seeded, otherwise registration order). Returns every round each participant
// plays every other participant exactly once; if the count is odd, one virtual
// "BYE" seat is added so each real participant sits out exactly one round,
// rotated automatically by the algorithm (not special-cased).
export function generateRoundRobinSchedule(registrations){
  const ids = registrations.map(r=>r.id);
  let seats = [...ids];
  if (seats.length % 2 !== 0) seats.push(null); // null = BYE
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
    seats = [seats[0], seats[n-1], ...seats.slice(1,n-1)]; // seats[0] fixed, rest rotate
  }
  return { rounds };
}

// Auto-assigns courts to an already-generated (and persisted) round-robin
// schedule — operates on the flat tournament_matches rows, not the {rounds}
// generator output above. Bye rounds are never persisted as rows in the first
// place (RoundRobinScheduleView filters them out before calling onGenerate),
// so every row here is a real match needing a court. Cycles `courtIds` per
// round (resetting each round, not accumulating across the whole tournament,
// so round 1 and round 2 use courts in the same order) and never touches a
// match that already has a manually-assigned court. Returns
// [{matchId, patch:{courtId}}] ready for Cloud.bulkUpdateTournamentMatches.
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
      if (m.courtId) continue; // never clobber a manual assignment
      patches.push({ matchId:m.id, patch:{ courtId: courtIds[ci % courtIds.length] } });
      ci++;
    }
  }
  return patches;
}
