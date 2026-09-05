// Single-elimination bracket generation + advancement — pure, no DB.
// Pre-generates the full bracket (every round, TBD placeholders) rather than
// creating rounds lazily, so the bracket UI can render future rounds and
// next_match_id/next_match_slot only need computing once, deterministically.

// Standard seed-mirroring order: round 1 pairs guarantee top seeds can't meet
// early (seed 1 vs 8, 4 vs 5, 2 vs 7, 3 vs 6 for size 8, etc). Exported so
// tournamentDoubleElimination.js can reuse the exact same seeding instead of
// duplicating it — pure function, zero risk to export.
export function seedOrder(size){
  let order = [1];
  while (order.length < size){
    const k = order.length;
    order = order.flatMap(s => [s, 2*k + 1 - s]);
  }
  return order;
}

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

// registrations: ordered by seed ascending (registrations[0] = seed 1).
// Returns a flat array of match shells (round 1 first), ready for bulk insert
// into tournament_matches. Non-power-of-2 fields get phantom high seeds, which
// the mirror algorithm always pairs against top seeds first — round-1 byes
// resolve automatically, no special-casing needed.
export function generateBracket(registrations, { makeId, bronzeMatch } = {}){
  const genId = makeId || defaultId;
  const n = registrations.length;
  if (n < 2) return [];

  let size = 1; while (size < n) size *= 2;
  const totalRounds = Math.log2(size);
  const order = seedOrder(size);
  const seedReg = s => s <= n ? registrations[s-1] : null; // null = phantom bye seed
  const slots = order.map(seedReg);

  const rounds = [];
  let roundSize = size / 2;
  for (let r=0; r<totalRounds; r++){
    const shells = [];
    for (let i=0; i<roundSize; i++){
      shells.push({
        id: genId(), round: r+1, bracketPosition: i,
        registrationAId: null, registrationBId: null,
        status: "pending", winner: null,
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

  // Bronze match (3rd place): only meaningful once there's an actual
  // semifinal round to draw losers from (totalRounds>=2, i.e. n>2). Wired via
  // loserNextMatchId/loserNextMatchSlot on the two semifinal matches, kept
  // entirely separate from nextMatchId/nextMatchSlot so the normal winner-only
  // advanceBracket() below needs zero changes.
  if (bronzeMatch && totalRounds >= 2){
    const semis = rounds[totalRounds - 2];
    const bronze = {
      id: genId(), round: totalRounds, bracketPosition: 1,
      registrationAId: null, registrationBId: null,
      status: "pending", winner: null, bracketSide: "bronze",
    };
    semis[0].loserNextMatchId = bronze.id; semis[0].loserNextMatchSlot = "A";
    semis[1].loserNextMatchId = bronze.id; semis[1].loserNextMatchSlot = "B";
    bracketMatches.push(bronze);
  }

  return bracketMatches;
}

// Pure patch-generator for when a tournament_match completes. `matches` is any
// array of objects with {id, nextMatchId, nextMatchSlot}. Returns the single
// row-patch to apply to the next match, or null if this was the final.
export function advanceBracket(matches, completedMatchId, winnerRegistrationId){
  const completed = matches.find(m => m.id === completedMatchId);
  if (!completed?.nextMatchId) return null;
  const next = matches.find(m => m.id === completed.nextMatchId);
  if (!next) return null;

  const slotKey = completed.nextMatchSlot === "A" ? "registrationAId" : "registrationBId";
  const otherFilled = completed.nextMatchSlot === "A" ? next.registrationBId : next.registrationAId;
  return {
    matchId: next.id,
    patch: { [slotKey]: winnerRegistrationId, status: otherFilled ? "scheduled" : "pending" },
  };
}

// Sibling to advanceBracket: fills the bronze match's slot when a semifinal
// match (the only matches ever carrying loserNextMatchId) completes. No-op
// (returns null) for every match without loserNextMatchId set, i.e. every
// match in a bracket generated without bronzeMatch:true.
export function advanceBronzeMatchSlot(matches, completedMatchId, loserRegistrationId){
  const completed = matches.find(m => m.id === completedMatchId);
  if (!completed?.loserNextMatchId) return null;
  const bronze = matches.find(m => m.id === completed.loserNextMatchId);
  if (!bronze) return null;

  const slotKey = completed.loserNextMatchSlot === "A" ? "registrationAId" : "registrationBId";
  const otherFilled = completed.loserNextMatchSlot === "A" ? bronze.registrationBId : bronze.registrationAId;
  return {
    matchId: bronze.id,
    patch: { [slotKey]: loserRegistrationId, status: otherFilled ? "scheduled" : "pending" },
  };
}

// Round Robin + Top 4 Playoffs — pre-generates the Semifinal(x2)/Final/Bronze
// shell as TBD-vs-TBD placeholders, all at once, at "Generate Schedule" time
// (before any round-robin match has even been played, let alone the top 4
// known). Reuses generateBracket's exact seed-mirroring/nextMatchId/
// loserNextMatchId wiring via 4 placeholder "registrations" (id:null) rather
// than duplicating that logic — every registrationAId/BId this produces comes
// out null (a?.id??null resolves to null for {id:null} inputs, and {id:null}
// is truthy so the round-1 bye-detection branch never fires, so no shell match
// is ever mistakenly marked a bye). bracketSide tags are added here since
// generateBracket itself only tags the bronze match — these tags are what let
// every other consumer (DivisionDetailPanel's tab routing, BracketView's
// rendering, the round-robin-completion detector, Standings filtering) tell a
// playoff-shell row apart from a plain Elimination Round row, which never
// sets bracketSide at all.
export function generateTop4PlayoffShell({ makeId } = {}){
  const dummy = [{ id: null }, { id: null }, { id: null }, { id: null }];
  const shells = generateBracket(dummy, { makeId, bronzeMatch: true });
  const totalRounds = Math.max(...shells.map(m => m.round));
  return shells.map(m => ({
    ...m, registrationAId: null, registrationBId: null,
    bracketSide: m.bracketSide || (m.round < totalRounds ? "winners" : "final"),
  }));
}

// Sibling to advanceBracket/advanceBronzeMatchSlot: given the round-robin
// division's own final standings (already ranked/tie-broken by
// buildTournamentStandings) and the two Semifinal shells (bracketSide:
// "winners"), returns the patches that seed them. bracketPosition:0 is always
// the seed1-vs-seed4 slot and bracketPosition:1 is always seed2-vs-seed3 — the
// exact same deterministic mapping generateBracket's own seedOrder(4)=[1,4,2,3]
// already encodes for a 4-entrant bracket — so this never needs to store or
// look up which seed rank belongs where, just trust bracketPosition. Returns
// [] (no-op) if fewer than 4 standings rows are eligible, or if the semis
// aren't exactly the expected pair, or if they're already filled (the
// idempotency guard — this is safe to call more than once).
export function computeSemifinalFillPatches(standings, semis){
  if (standings.length < 4) return [];
  const bySlot = [...semis].sort((a,b) => a.bracketPosition - b.bracketPosition);
  if (bySlot.length !== 2) return [];
  if (bySlot[0].registrationAId != null || bySlot[0].registrationBId != null) return [];
  const [s1, s2, s3, s4] = standings;
  return [
    { matchId: bySlot[0].id, patch: { registrationAId: s1.registrationId, registrationBId: s4.registrationId, status: "pending" } },
    { matchId: bySlot[1].id, patch: { registrationAId: s2.registrationId, registrationBId: s3.registrationId, status: "pending" } },
  ];
}
