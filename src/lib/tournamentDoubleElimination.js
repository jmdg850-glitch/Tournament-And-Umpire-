// Double-elimination bracket generation + advancement — pure, no DB.
// Reuses tournamentBracket.js's seedOrder (same seeding as single elimination)
// and produces the same flat match-shell shape generateBracket does, plus
// bracketSide/loserNextMatchId/loserNextMatchSlot/phantomSlot (see migration
// 114_tournament_double_elimination.sql).
//
// Structure for `n` registrations (size = next power of 2, WR = log2(size)):
//   - Winners bracket: identical to generateBracket (WR rounds, round-1 byes
//     auto-resolved by the mirror seeding).
//   - Losers bracket: 2*(WR-1) rounds, alternating "absorb a just-dropped WB
//     round's losers" (even rounds) and "consolidate pure LB survivors"
//     (odd-round winners feeding straight into the next even round).
//   - A single Grand Final (WB champion vs LB champion) — no bracket-reset
//     match. Avoids dynamically inserting a row mid-tournament, which would
//     break the pre-generate-everything-as-TBD approach this and the
//     single-elim generator both rely on for deterministic advancement.
//
// n===2 is degenerate (no losers bracket at all): the single match's winner
// and loser both route straight into the Grand Final's two slots.
import { seedOrder } from "./tournamentBracket.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

function makeShell(genId, round, bracketPosition, bracketSide){
  return { id:genId(), round, bracketPosition, bracketSide,
    registrationAId:null, registrationBId:null, status:"pending", winner:null,
    nextMatchId:null, nextMatchSlot:null, loserNextMatchId:null, loserNextMatchSlot:null,
    phantomSlot:null };
}

export function generateDoubleEliminationBracket(registrations, { makeId } = {}){
  const genId = makeId || defaultId;
  const n = registrations.length;
  if (n < 2) return [];

  let size = 1; while (size < n) size *= 2;
  const totalWBRounds = Math.log2(size);
  const order = seedOrder(size);
  const seedReg = s => s <= n ? registrations[s-1] : null;
  const slots = order.map(seedReg);

  // ---- Winners bracket: build shells for every WB round ----
  const wbRounds = [];
  let roundSize = size / 2;
  for (let r=0; r<totalWBRounds; r++){
    const shells=[];
    for (let i=0;i<roundSize;i++) shells.push(makeShell(genId, r+1, i, "winners"));
    wbRounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize/2));
  }
  // Round 1 seeding + bye auto-resolution (identical to generateBracket).
  for (let i=0;i<wbRounds[0].length;i++){
    const a=slots[i*2], b=slots[i*2+1];
    const m=wbRounds[0][i];
    m.registrationAId=a?.id??null; m.registrationBId=b?.id??null;
    if (!a||!b){ m.status="bye"; m.winner=a?"A":"B"; }
  }
  // WB-internal advancement wiring (winner path) — identical pattern to generateBracket.
  for (let r=0;r<wbRounds.length-1;r++){
    for (let i=0;i<wbRounds[r].length;i++){
      const m=wbRounds[r][i];
      const next=wbRounds[r+1][Math.floor(i/2)];
      m.nextMatchId=next.id; m.nextMatchSlot=i%2===0?"A":"B";
      if (m.status==="bye"&&m.winner){
        const winnerId=m.winner==="A"?m.registrationAId:m.registrationBId;
        if (m.nextMatchSlot==="A") next.registrationAId=winnerId; else next.registrationBId=winnerId;
      }
    }
  }

  const grandFinal = makeShell(genId, 1, 0, "final");

  // ---- Degenerate case: 2 entrants, one WB match, no losers bracket at all ----
  if (totalWBRounds===1){
    const only=wbRounds[0][0];
    only.nextMatchId=grandFinal.id; only.nextMatchSlot="A";
    only.loserNextMatchId=grandFinal.id; only.loserNextMatchSlot="B";
    return [...wbRounds.flat(), grandFinal];
  }

  // ---- Losers bracket: 2*(totalWBRounds-1) rounds, indexed 0..totalLBRounds-1 ----
  const totalLBRounds = 2*(totalWBRounds-1);
  const lbRounds=[];
  for (let j=1;j<=totalWBRounds-1;j++){
    const count = size / Math.pow(2, j+1);
    const oddShells=[], evenShells=[];
    for (let i=0;i<count;i++){
      oddShells.push(makeShell(genId, 2*j-1, i, "losers"));
      evenShells.push(makeShell(genId, 2*j, i, "losers"));
    }
    lbRounds.push(oddShells, evenShells);
  }

  // WB round 1 losers -> LB round 1 (paired adjacent-match-losers, halving pattern).
  for (let i=0;i<wbRounds[0].length;i++){
    const m=wbRounds[0][i];
    const lbMatch=lbRounds[0][Math.floor(i/2)];
    const slot = i%2===0 ? "A" : "B";
    m.loserNextMatchId=lbMatch.id; m.loserNextMatchSlot=slot;
    if (m.status==="bye") lbMatch.phantomSlot = lbMatch.phantomSlot ? "both" : slot;
  }

  // WB rounds 2..totalWBRounds losers -> LB even rounds (drop-down), slot B.
  // LB odd round j's winner -> same-index LB even round j, slot A (both rounds
  // in a pair always have equal match counts, per the size formula above).
  for (let j=1;j<=totalWBRounds-1;j++){
    const oddRound=lbRounds[2*j-2];
    const evenRound=lbRounds[2*j-1];
    for (let i=0;i<oddRound.length;i++){
      oddRound[i].nextMatchId=evenRound[i].id; oddRound[i].nextMatchSlot="A";
    }
    const wbLosers=wbRounds[j]; // 0-indexed j == WB round (j+1)
    for (let i=0;i<wbLosers.length;i++){
      wbLosers[i].loserNextMatchId=evenRound[i].id; wbLosers[i].loserNextMatchSlot="B";
    }
  }
  // LB even round's winner -> next LB odd round (halving pattern), except the
  // very last LB round (the LB final), which instead feeds the grand final.
  for (let l=0;l<totalLBRounds-1;l++){
    if ((l+1)%2!==0) continue; // only even rounds (1-indexed) advance here
    const cur=lbRounds[l];
    const next=lbRounds[l+1];
    for (let i=0;i<cur.length;i++){
      const nm=next[Math.floor(i/2)];
      cur[i].nextMatchId=nm.id; cur[i].nextMatchSlot=i%2===0?"A":"B";
    }
  }

  // LB final (last round) winner -> grand final slot B; WB final winner -> slot A.
  lbRounds[totalLBRounds-1][0].nextMatchId=grandFinal.id;
  lbRounds[totalLBRounds-1][0].nextMatchSlot="B";
  const wbFinal=wbRounds[wbRounds.length-1][0];
  wbFinal.nextMatchId=grandFinal.id; wbFinal.nextMatchSlot="A";

  // Resolve any LB match where BOTH slots are phantom (very sparse brackets —
  // two adjacent WB-R1 byes feeding the same LB round-1 match) as an empty bye
  // immediately, since neither slot will ever receive a real participant.
  // Then propagate that "nobody real is coming from here" fact forward to a
  // fixed point: such a match's own next-round slot needs the same phantom
  // treatment, otherwise THAT match would wait forever on a slot nothing can
  // fill — this can in principle cascade more than one level for an extremely
  // sparse bracket, so this loop runs until nothing changes rather than
  // assuming a single-level cascade like the WB-R1-bye case guarantees.
  const flatLB = lbRounds.flat();
  let changed = true;
  while (changed){
    changed = false;
    for (const m of flatLB){
      if (m.phantomSlot==="both" && m.status!=="bye"){
        m.status="bye"; m.winner=null; changed=true;
      }
      if (m.status==="bye" && m.winner===null && m.nextMatchId){
        const nm = flatLB.find(x=>x.id===m.nextMatchId);
        if (nm && nm.phantomSlot!=="both"){
          const already=nm.phantomSlot;
          const newValue = already && already!==m.nextMatchSlot ? "both" : m.nextMatchSlot;
          if (newValue!==already){ nm.phantomSlot=newValue; changed=true; }
        }
      }
    }
  }

  return [...wbRounds.flat(), ...lbRounds.flat(), grandFinal];
}

// Pure patch-generator for when a tournament_match completes. Unlike
// advanceBracket's single patch-or-null, this returns an ARRAY of patches,
// since one completion can write to both the winner's next match and the
// loser's losers-bracket destination, plus a bounded one-level cascade when
// the loser lands on a phantomSlot (auto-resolve that LB match as a walkover
// and recurse once — phantomSlot only ever exists on LB round-1 matches, so
// this can never cascade more than one level).
export function advanceDoubleEliminationBracket(matches, completedMatchId, winnerRegistrationId, loserRegistrationId){
  const completed = matches.find(m=>m.id===completedMatchId);
  if (!completed) return [];
  const patches=[];

  if (completed.nextMatchId){
    const next = matches.find(m=>m.id===completed.nextMatchId);
    if (next){
      const slotKey = completed.nextMatchSlot==="A" ? "registrationAId" : "registrationBId";
      const otherFilled = completed.nextMatchSlot==="A" ? next.registrationBId : next.registrationAId;
      patches.push({ matchId: next.id, patch: { [slotKey]: winnerRegistrationId, status: otherFilled?"scheduled":"pending" } });
    }
  }

  if (loserRegistrationId && completed.bracketSide==="winners" && completed.loserNextMatchId){
    const lbMatch = matches.find(m=>m.id===completed.loserNextMatchId);
    if (lbMatch){
      const slotKey = completed.loserNextMatchSlot==="A" ? "registrationAId" : "registrationBId";
      const otherSlotKey = completed.loserNextMatchSlot==="A" ? "registrationBId" : "registrationAId";
      const otherIsPhantom = lbMatch.phantomSlot && lbMatch.phantomSlot!=="both" && lbMatch.phantomSlot!==completed.loserNextMatchSlot;
      if (otherIsPhantom){
        const winnerSide = completed.loserNextMatchSlot;
        patches.push({ matchId: lbMatch.id, patch: { [slotKey]: loserRegistrationId, status:"bye", winner: winnerSide } });
        const resolvedMatch = { ...lbMatch, [slotKey]: loserRegistrationId, status:"bye", winner: winnerSide };
        const further = advanceDoubleEliminationBracket(
          matches.map(m=>m.id===lbMatch.id?resolvedMatch:m),
          lbMatch.id, loserRegistrationId, null
        );
        patches.push(...further);
      } else {
        const otherFilled = lbMatch[otherSlotKey];
        patches.push({ matchId: lbMatch.id, patch: { [slotKey]: loserRegistrationId, status: otherFilled?"scheduled":"pending" } });
      }
    }
  }

  return patches;
}
