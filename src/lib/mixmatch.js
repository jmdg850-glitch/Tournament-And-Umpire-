// SMART MIX & MATCH ENGINE — fair partner randomization, duplicate-pairing
// avoidance, and opponent rotation. Pure JS (no React), so it can never throw
// into a render. `hist` accumulates counts across repeated generations in a
// session so successive rounds rotate partners/opponents rather than repeat.

export function mixPairKey(a,b){ return a<b ? a+"|"+b : b+"|"+a; }
export function mixShuffle(a){ const r=[...a]; for(let i=r.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [r[i],r[j]]=[r[j],r[i]]; } return r; }

// Structural guarantee that a match can never pit a player against themselves or list the
// same player twice on one team. Checked once here and enforced at the single startMatch()
// choke point every match-creation path (Manual Team Setup, Mix & Match, queue, Infinite
// Match Making) already funnels through, so "no self-match" holds regardless of which path
// produced the setup.
export function isValidMatchup(teamA, teamB){
  const a=teamA||[], b=teamB||[];
  if(!a.length || !b.length) return false;
  if(new Set(a).size!==a.length) return false;
  if(new Set(b).size!==b.length) return false;
  return !a.some(id=>b.includes(id));
}

// Organizer ownership gate: every match now carries an organizerId (defaulted to its creator
// at startMatch()). Legacy matches created before this existed have no organizerId and stay
// open to everyone, matching pre-existing behavior. App admins always have full control.
// For matches that belong to an Event, control defers entirely to the event's LIVE
// organizerIds (via canControlEvent below) instead of the match's own frozen organizerIds
// snapshot — a match created before a co-organizer's invite was accepted would otherwise never
// grant that organizer control, since organizerIds is only ever set once, at startMatch() time.
export function canControlMatch(match, currentUser, event){
  if(!match) return true;
  if(match.eventId && event) return canControlEvent(event, currentUser);
  if(!match.organizerId && !(match.organizerIds||[]).length) return true; // legacy matches, unchanged
  if(currentUser?.role==="admin") return true;
  if(match.organizerId===currentUser?.id) return true;                    // owner
  if((match.organizerIds||[]).includes(currentUser?.id)) return true;     // co-organizer
  return false;
}

// Same gate, for calendar events (standalone events/event_attendees, not club-embedded ones).
// Mirrors canControlMatch's owner-or-array shape: event.ownerId is always the creator;
// event.organizerIds is an additive list of co-organizers granted full control except deleting
// the event or transferring ownership (see the isTrueOwner check at the Delete button).
export function canControlEvent(event, currentUser){
  // Fails CLOSED on a missing event (deleted, or not yet synced to this device) — every real
  // caller already passes a guaranteed-loaded event object; a lookup miss must never be read as
  // "unrestricted", or any stray live_matches row for a since-deleted/not-yet-cached event gets
  // adopted as controllable by every other logged-in user instead of just its real organizers
  // (see reconcileOwnLiveMatches, the actual source of the ghost "LIVE" badge bug).
  if(!event) return false;
  if(currentUser?.role==="admin") return true;
  if(event.ownerId===currentUser?.id) return true;
  if((event.organizerIds||[]).includes(currentUser?.id)) return true;
  return false;
}

// Build ONE fair round from a pool of {id,rating}. Returns {matches,leftovers}.
// mode: "singles" | "doubles". hist: {partner:{}, opp:{}} (mutated in place).
// orderedIds (optional): pre-ordered id list (e.g. players who sat out last round
// placed first) so the greedy pairing below consumes them before anyone else —
// falls back to a plain shuffle when omitted.
export function buildMixRound(pool, mode, hist, orderedIds){
  const partner = hist.partner || (hist.partner = {});
  const opp     = hist.opp     || (hist.opp     = {});
  const rOf = id => { const p = pool.find(x=>x.id===id); return p ? (+p.rating||3) : 3; };
  let ids = orderedIds ? [...orderedIds] : mixShuffle((pool||[]).map(p=>p.id));
  const matches = [], leftovers = [];
  const oppCost = (aIds,bIds)=>{ let c=0; for(const a of aIds) for(const b of bIds) c += (opp[mixPairKey(a,b)]||0); return c; };

  if(mode==="singles"){
    while(ids.length>=2){
      const a = ids.shift();
      let best=0, bestScore=Infinity;
      for(let i=0;i<ids.length;i++){
        const b = ids[i];
        const score = (opp[mixPairKey(a,b)]||0)*100 + Math.abs(rOf(a)-rOf(b));
        if(score<bestScore){ bestScore=score; best=i; }
      }
      const b = ids.splice(best,1)[0];
      matches.push({ teamA:[a], teamB:[b] });
      opp[mixPairKey(a,b)] = (opp[mixPairKey(a,b)]||0)+1;
    }
    leftovers.push(...ids);
    return { matches, leftovers };
  }

  // Doubles: form balanced teams that avoid repeat partners, then pair teams to
  // rotate opponents while keeping matchups close on rating (fairer games).
  const teams=[];
  while(ids.length>=2){
    const a = ids.shift();
    let best=0, bestScore=Infinity;
    for(let i=0;i<ids.length;i++){
      const b = ids[i];
      const score = (partner[mixPairKey(a,b)]||0)*100 + Math.abs(rOf(a)-rOf(b))*0.5;
      if(score<bestScore){ bestScore=score; best=i; }
    }
    const b = ids.splice(best,1)[0];
    teams.push({ ids:[a,b], r:rOf(a)+rOf(b) });
    partner[mixPairKey(a,b)] = (partner[mixPairKey(a,b)]||0)+1;
  }
  leftovers.push(...ids); // odd player out (if any)

  const used = new Array(teams.length).fill(false);
  for(let i=0;i<teams.length;i++){
    if(used[i]) continue;
    used[i]=true;
    let best=-1, bestScore=Infinity;
    for(let j=i+1;j<teams.length;j++){
      if(used[j]) continue;
      const score = oppCost(teams[i].ids,teams[j].ids)*100 + Math.abs(teams[i].r-teams[j].r);
      if(score<bestScore){ bestScore=score; best=j; }
    }
    if(best===-1){ leftovers.push(...teams[i].ids); continue; }
    used[best]=true;
    matches.push({ teamA:teams[i].ids, teamB:teams[best].ids });
    for(const a of teams[i].ids) for(const b of teams[best].ids) opp[mixPairKey(a,b)] = (opp[mixPairKey(a,b)]||0)+1;
  }
  return { matches, leftovers };
}

// Player Rest Interval: filters a Mix & Match pool down to players who have sat out at least
// `restInterval` matches since they last played (tracked in `restCounters`, keyed by player id —
// a missing entry means "never played yet in this session", i.e. immediately eligible). Never
// lets the rest requirement fully stall generation: if applying it would leave fewer than `min`
// players, the most-rested excluded players are added back (longest-rested first) until there
// are enough for at least one match. Pure/no React dependency, same convention as buildMixRound —
// callers own restCounters' lifecycle (Infinite Match Making keeps one across generations so the
// interval is respected match-to-match; a one-shot Mix & Match generation isn't affected since it
// never passes a persisted restCounters object).
export function eligibleForRound(pool, restCounters, restInterval, min){
  if(!restInterval || restInterval<=0 || !restCounters) return pool;
  const counterOf=id=>restCounters[id]??Infinity;
  const ready=pool.filter(p=>counterOf(p.id)>=restInterval);
  if(ready.length>=min) return ready;
  const resting=pool.filter(p=>counterOf(p.id)<restInterval).sort((a,b)=>counterOf(b.id)-counterOf(a.id));
  return [...ready, ...resting.slice(0, min-ready.length)];
}

// Court Distribution: reorders an already-generated, category-tagged match list (from
// MixMatchPanel.generate()) so a single category's block never monopolizes the front of the
// list/queue — used by both non-default distribution modes. Groups matches by category
// (preserving each category's own internal round order), then repeatedly takes one match from
// each still-active category in turn until all are placed. `weighted`=false cycles through
// categories in their original (selection) order every pass ("Sequential Rotation"); =true
// re-sorts the active categories by remaining count (most-remaining-first) before each pass, so
// a much larger category doesn't get throttled to one slot per cycle once smaller categories run
// dry ("Cross-Category"). With 0 or 1 categories this degenerates to a no-op (one group, drained
// in original order), so it's always safe to apply regardless of how many categories are selected.
export function interleaveByCategory(matches, weighted){
  const order=[]; const groups=new Map();
  matches.forEach(m=>{
    const key=m.category||"__none__";
    if(!groups.has(key)){ groups.set(key,[]); order.push(key); }
    groups.get(key).push(m);
  });
  const result=[];
  let active=order;
  while(active.length){
    if(weighted) active=[...active].sort((a,b)=>groups.get(b).length-groups.get(a).length);
    for(const key of active){ const g=groups.get(key); if(g.length) result.push(g.shift()); }
    active=active.filter(key=>groups.get(key).length>0);
  }
  return result;
}
