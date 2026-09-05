// Double-elimination bracket generation + advancement — pure, no DB.
import { seedOrder } from "./bracket.js";

const defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2,6)}`;

function makeShell(genId, round, bracketPosition, bracketSide){
  return { id:genId(), round, bracketPosition, bracketSide,
    registrationAId:null, registrationBId:null, status:"scheduled", winner:null,
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

  const wbRounds = [];
  let roundSize = size / 2;
  for (let r=0; r<totalWBRounds; r++){
    const shells=[];
    for (let i=0;i<roundSize;i++) shells.push(makeShell(genId, r+1, i, "winners"));
    wbRounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize/2));
  }
  for (let i=0;i<wbRounds[0].length;i++){
    const a=slots[i*2], b=slots[i*2+1];
    const m=wbRounds[0][i];
    m.registrationAId=a?.id??null; m.registrationBId=b?.id??null;
    if (!a||!b){ m.status="bye"; m.winner=a?"A":"B"; }
  }
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

  if (totalWBRounds===1){
    const only=wbRounds[0][0];
    only.nextMatchId=grandFinal.id; only.nextMatchSlot="A";
    only.loserNextMatchId=grandFinal.id; only.loserNextMatchSlot="B";
    return [...wbRounds.flat(), grandFinal];
  }

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

  for (let i=0;i<wbRounds[0].length;i++){
    const m=wbRounds[0][i];
    const lbMatch=lbRounds[0][Math.floor(i/2)];
    const slot = i%2===0 ? "A" : "B";
    m.loserNextMatchId=lbMatch.id; m.loserNextMatchSlot=slot;
    if (m.status==="bye") lbMatch.phantomSlot = lbMatch.phantomSlot ? "both" : slot;
  }

  for (let j=1;j<=totalWBRounds-1;j++){
    const oddRound=lbRounds[2*j-2];
    const evenRound=lbRounds[2*j-1];
    for (let i=0;i<oddRound.length;i++){
      oddRound[i].nextMatchId=evenRound[i].id; oddRound[i].nextMatchSlot="A";
    }
    const wbLosers=wbRounds[j];
    for (let i=0;i<wbLosers.length;i++){
      wbLosers[i].loserNextMatchId=evenRound[i].id; wbLosers[i].loserNextMatchSlot="B";
    }
  }
  for (let l=0;l<totalLBRounds-1;l++){
    if ((l+1)%2!==0) continue;
    const cur=lbRounds[l];
    const next=lbRounds[l+1];
    for (let i=0;i<cur.length;i++){
      const nm=next[Math.floor(i/2)];
      cur[i].nextMatchId=nm.id; cur[i].nextMatchSlot=i%2===0?"A":"B";
    }
  }

  lbRounds[totalLBRounds-1][0].nextMatchId=grandFinal.id;
  lbRounds[totalLBRounds-1][0].nextMatchSlot="B";
  const wbFinal=wbRounds[wbRounds.length-1][0];
  wbFinal.nextMatchId=grandFinal.id; wbFinal.nextMatchSlot="A";

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

export function advanceDoubleEliminationBracket(matches, completedMatchId, winnerRegistrationId, loserRegistrationId){
  const completed = matches.find(m=>m.id===completedMatchId);
  if (!completed) return [];
  const patches=[];

  if (completed.nextMatchId){
    const next = matches.find(m=>m.id===completed.nextMatchId);
    if (next){
      const slotKey = completed.nextMatchSlot==="A" ? "registrationAId" : "registrationBId";
      patches.push({ matchId: next.id, patch: { [slotKey]: winnerRegistrationId, status: "scheduled" } });
    }
  }

  if (loserRegistrationId && completed.bracketSide==="winners" && completed.loserNextMatchId){
    const lbMatch = matches.find(m=>m.id===completed.loserNextMatchId);
    if (lbMatch){
      const slotKey = completed.loserNextMatchSlot==="A" ? "registrationAId" : "registrationBId";
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
        patches.push({ matchId: lbMatch.id, patch: { [slotKey]: loserRegistrationId, status: "scheduled" } });
      }
    }
  }

  return patches;
}
