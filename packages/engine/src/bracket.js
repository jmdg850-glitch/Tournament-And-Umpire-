// Single-elimination bracket generation + advancement — pure, no DB.
// Playable shells use status "scheduled". Bye shells keep status "bye".

export function seedOrder(size){
  let order = [1];
  while (order.length < size){
    const k = order.length;
    order = order.flatMap(s => [s, 2*k + 1 - s]);
  }
  return order;
}

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

export function generateBracket(registrations, { makeId, bronzeMatch } = {}){
  const genId = makeId || defaultId;
  const n = registrations.length;
  if (n < 2) return [];

  let size = 1; while (size < n) size *= 2;
  const totalRounds = Math.log2(size);
  const order = seedOrder(size);
  const seedReg = s => s <= n ? registrations[s-1] : null;
  const slots = order.map(seedReg);

  const rounds = [];
  let roundSize = size / 2;
  for (let r=0; r<totalRounds; r++){
    const shells = [];
    for (let i=0; i<roundSize; i++){
      shells.push({
        id: genId(), round: r+1, bracketPosition: i,
        registrationAId: null, registrationBId: null,
        status: "scheduled", winner: null,
      });
    }
    rounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize/2));
  }

  for (let i=0; i<rounds[0].length; i++){
    const a = slots[i*2], b = slots[i*2+1];
    const m = rounds[0][i];
    m.registrationAId = a?.id ?? null;
    m.registrationBId = b?.id ?? null;
    if (!a || !b){ m.status = "bye"; m.winner = a ? "A" : "B"; }
  }

  for (let r=0; r<rounds.length-1; r++){
    for (let i=0; i<rounds[r].length; i++){
      const m = rounds[r][i];
      const next = rounds[r+1][Math.floor(i/2)];
      m.nextMatchId = next.id;
      m.nextMatchSlot = i % 2 === 0 ? "A" : "B";
      if (m.status === "bye" && m.winner){
        const winnerId = m.winner === "A" ? m.registrationAId : m.registrationBId;
        if (m.nextMatchSlot === "A") next.registrationAId = winnerId;
        else next.registrationBId = winnerId;
      }
    }
  }

  const bracketMatches = rounds.flat();

  if (bronzeMatch && totalRounds >= 2){
    const semis = rounds[totalRounds - 2];
    const bronze = {
      id: genId(), round: totalRounds, bracketPosition: 1,
      registrationAId: null, registrationBId: null,
      status: "scheduled", winner: null, bracketSide: "bronze",
    };
    semis[0].loserNextMatchId = bronze.id; semis[0].loserNextMatchSlot = "A";
    semis[1].loserNextMatchId = bronze.id; semis[1].loserNextMatchSlot = "B";
    bracketMatches.push(bronze);
  }

  return bracketMatches;
}

export function advanceBracket(matches, completedMatchId, winnerRegistrationId){
  const completed = matches.find(m => m.id === completedMatchId);
  if (!completed?.nextMatchId) return null;
  const next = matches.find(m => m.id === completed.nextMatchId);
  if (!next) return null;

  const slotKey = completed.nextMatchSlot === "A" ? "registrationAId" : "registrationBId";
  return {
    matchId: next.id,
    patch: { [slotKey]: winnerRegistrationId, status: "scheduled" },
  };
}

export function advanceBronzeMatchSlot(matches, completedMatchId, loserRegistrationId){
  const completed = matches.find(m => m.id === completedMatchId);
  if (!completed?.loserNextMatchId) return null;
  const bronze = matches.find(m => m.id === completed.loserNextMatchId);
  if (!bronze) return null;

  const slotKey = completed.loserNextMatchSlot === "A" ? "registrationAId" : "registrationBId";
  return {
    matchId: bronze.id,
    patch: { [slotKey]: loserRegistrationId, status: "scheduled" },
  };
}

export function generateTop4PlayoffShell({ makeId } = {}){
  const dummy = [{ id: null }, { id: null }, { id: null }, { id: null }];
  const shells = generateBracket(dummy, { makeId, bronzeMatch: true });
  const totalRounds = Math.max(...shells.map(m => m.round));
  return shells.map(m => ({
    ...m, registrationAId: null, registrationBId: null,
    bracketSide: m.bracketSide || (m.round < totalRounds ? "winners" : "final"),
  }));
}

export function computeSemifinalFillPatches(standings, semis){
  if (standings.length < 4) return [];
  const bySlot = [...semis].sort((a,b) => a.bracketPosition - b.bracketPosition);
  if (bySlot.length !== 2) return [];
  if (bySlot[0].registrationAId != null || bySlot[0].registrationBId != null) return [];
  const [s1, s2, s3, s4] = standings;
  return [
    { matchId: bySlot[0].id, patch: { registrationAId: s1.registrationId, registrationBId: s4.registrationId, status: "scheduled" } },
    { matchId: bySlot[1].id, patch: { registrationAId: s2.registrationId, registrationBId: s3.registrationId, status: "scheduled" } },
  ];
}
