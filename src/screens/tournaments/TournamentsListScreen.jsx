import { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { TournamentEditorModal } from "../../modals/TournamentEditorModal.jsx";
import { TournamentDetailPanel } from "./TournamentDetailPanel.jsx";
import { CoinTossModal } from "./CoinTossModal.jsx";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { Cloud } from "../../lib/cloud.js";
import { Outbox } from "../../lib/outbox.js";
import { LS } from "../../lib/storage.js";
import { uid, fmtDate } from "../../lib/utils.js";
import { D, alpha } from "../../theme/tokens.js";
import { itemVariants } from "../../theme/motion.js";

const STATUS_COLOR={draft:D.textMuted,active:D.green,completed:D.blue,cancelled:D.red,archived:D.textMuted};
const MATCH_STATUS_COLOR={pending:D.textMuted,scheduled:D.accent,in_progress:D.red,completed:D.green,cancelled:D.textMuted};
const VIEWS=[{value:"active",label:"Active"},{value:"archive",label:"Archive"},{value:"umpiring",label:"Umpiring"}];

const regName=(regsById,id)=>{
  const r=id&&regsById[id];
  return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "TBD";
};

export function TournamentsListScreen({currentUser,directory=[],accountsDirectory=[],courts=[],onStartMatch,notify,umpireAssignments=[],onOpenLiveMatch,deepLinkUmpireMatchId=null,onConsumeUmpireDeepLink,deepLinkTournamentId=null,deepLinkDivisionId=null,onConsumeMatchAssignedDeepLink}){
  // LS-mirrored like the ~25 top-level App.jsx state slots (players/matches/courts/etc.) —
  // this screen owns its own Cloud fetch/subscribe (see below) rather than lifting into
  // App.jsx's state bag, so it mirrors the same way at its own level: a cold reload while
  // offline shows the last-known tournament list instead of an empty screen.
  const [tournaments,setTournaments]=useState(()=>LS.get("pl6_tournaments",[]));
  const [loading,setLoading]=useState(true);
  const [showEditor,setShowEditor]=useState(false);
  const [editingTournament,setEditingTournament]=useState(null);
  const [selectedId,setSelectedId]=useState(null);
  const [view,setView]=useState("active");
  const [archiveSearch,setArchiveSearch]=useState("");
  // Umpiring view: umpireAssignments (App.jsx-level, shared with reconcileOwnLiveMatches — no
  // second subscription here) only carries raw tournament_matches rows. Division/registration
  // names are resolved lazily, once per unique tournament an assignment belongs to (every select
  // policy involved is `using(true)` for any authenticated user — see migration 112 — so this
  // never needs the umpire to be that tournament's organizer). Court names are best-effort only:
  // `courts` above is this device's OWN organizer-scoped list, so a match umpired for a tournament
  // this user doesn't also organize just falls back to a generic label.
  const [umpireDivisions,setUmpireDivisions]=useState({});
  const [umpireRegistrations,setUmpireRegistrations]=useState({});
  const [coinTossMatch,setCoinTossMatch]=useState(null);
  const fetchedUmpireTournamentIds=useRef(new Set());

  useEffect(()=>{ LS.set("pl6_tournaments",tournaments); },[tournaments]);

  useEffect(()=>{
    let alive=true;
    Cloud.fetchTournaments().then(rows=>{
      // Additive merge (keep any not-yet-confirmed local-only row), not a wholesale replace —
      // same fix as App.jsx's events fetch, for the same reason: a tournament just created via
      // Outbox may not have drained to Supabase yet when this fetch runs.
      if(alive){
        setTournaments(prev=>{
          const ids=new Set(rows.map(t=>t.id));
          const localOnly=prev.filter(t=>!ids.has(t.id));
          return [...rows,...localOnly];
        });
        setLoading(false);
      }
    });
    let channel=null;
    Cloud.subscribeTournaments((mapped,eventType)=>{
      setTournaments(prev=>{
        if(eventType==="DELETE") return prev.filter(t=>t.id!==mapped.id);
        const exists=prev.some(t=>t.id===mapped.id);
        return exists ? prev.map(t=>t.id===mapped.id?mapped:t) : [mapped,...prev];
      });
    }).then(c=>{ if(alive) channel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(channel) Cloud.removeChannel(channel); };
  },[]);

  useEffect(()=>{
    const toFetch=[...new Set(umpireAssignments.map(m=>m.tournamentId))].filter(tid=>tid&&!fetchedUmpireTournamentIds.current.has(tid));
    if(!toFetch.length) return;
    let alive=true;
    toFetch.forEach(tid=>{
      // Only mark `tid` as fetched once its result is actually applied (inside the `alive`
      // guard below) — NOT eagerly here. umpireAssignments routinely gets a new array
      // reference more than once during startup (localStorage hydration → initial Cloud
      // fetch → realtime confirmation), each one tearing down and re-running this effect.
      // Marking `tid` fetched up front meant a torn-down in-flight request permanently
      // blocked every future retry (the `if(!alive)return` below discarded the result, but
      // the id already looked "done"), leaving division/team names stuck on "TBD" forever.
      Promise.all([Cloud.fetchDivisions(tid),Cloud.fetchRegistrationsForTournament(tid)]).then(([divs,regs])=>{
        if(!alive) return;
        fetchedUmpireTournamentIds.current.add(tid);
        setUmpireDivisions(prev=>{ const n={...prev}; divs.forEach(d=>{n[d.id]=d;}); return n; });
        setUmpireRegistrations(prev=>{ const n={...prev}; regs.forEach(r=>{n[r.id]=r;}); return n; });
      });
    });
    return ()=>{ alive=false; };
  },[umpireAssignments]);

  // Shared by the edit modal (below) and any other action that needs to patch a
  // tournament already in view (Finish Tournament, Archive's Restore) without opening
  // the editor — keeps every such write on the same outbox-then-local-update pattern.
  const patchTournament=useCallback((id,patch,msg)=>{
    Outbox.enqueue("updateTournament",{id,patch});
    setTournaments(prev=>prev.map(t=>t.id===id?{...t,...patch}:t));
    if(msg) notify?.(msg);
  },[notify]);

  const saveTournament=useCallback(fields=>{
    if(editingTournament){
      patchTournament(editingTournament.id,fields,"Tournament updated");
    } else {
      const t={id:"trn_"+uid(),ownerId:currentUser?.id,ownerName:currentUser?.name,status:"draft",organizerIds:[],organizerNames:{},...fields};
      Outbox.enqueue("createTournament",{tournament:t});
      setTournaments(prev=>[t,...prev]);
      notify?.("Tournament created");
    }
    setShowEditor(false); setEditingTournament(null);
  },[editingTournament,currentUser,notify,patchTournament]);

  const deleteTournament=useCallback(id=>{
    Outbox.enqueue("deleteTournament",{id});
    Outbox.drain();
    setTournaments(prev=>prev.filter(t=>t.id!==id));
    setSelectedId(null);
    notify?.("Tournament deleted");
  },[notify]);

  const restoreTournament=useCallback(t=>{
    patchTournament(t.id,{status:"active"},"Tournament restored");
  },[patchTournament]);

  const archiveTournament=useCallback(t=>{
    patchTournament(t.id,{status:"archived"},"Tournament archived");
  },[patchTournament]);

  // Structure only — clones the tournament's own metadata + its divisions (format/settings
  // preserved, seed cleared, status reset to pending), explicitly NOT registrations/
  // matches/pools/results, so a duplicate never leaks a prior season's live participant or
  // score data into what should read as a brand-new tournament. Dates are cleared too,
  // since the old tournament's dates wouldn't make sense for the new one.
  const duplicateTournament=useCallback(async t=>{
    const newId="trn_"+uid();
    const newTournament={id:newId,ownerId:currentUser?.id,ownerName:currentUser?.name,
      name:t.name+" (Copy)",venue:t.venue,startDate:null,endDate:null,logoUrl:t.logoUrl,bannerUrl:t.bannerUrl,
      types:t.types,description:t.description,status:"draft",organizerIds:[],organizerNames:{}};
    Outbox.enqueue("createTournament",{tournament:newTournament});
    setTournaments(prev=>[newTournament,...prev]);
    const divisions=await Cloud.fetchDivisions(t.id);
    divisions.forEach(d=>{
      Outbox.enqueue("createDivision",{division:{
        id:"tdiv_"+uid(),tournamentId:newId,organizerId:currentUser?.id,
        name:d.name,category:d.category,skillLevel:d.skillLevel,isDoubles:d.isDoubles,format:d.format,
        winTo:d.winTo,bestOf:d.bestOf,winBy:d.winBy,timeoutsAllowed:d.timeoutsAllowed,hasBronzeMatch:d.hasBronzeMatch,
        poolCount:d.poolCount,poolAdvanceCount:d.poolAdvanceCount,poolKnockoutFormat:d.poolKnockoutFormat,status:"pending",
      }});
    });
    Outbox.drain();
    notify?.("Tournament duplicated");
  },[currentUser,notify]);

  const selected=selectedId?tournaments.find(t=>t.id===selectedId):null;
  const activeTournaments=tournaments.filter(t=>t.status!=="completed"&&t.status!=="archived");
  const archivedTournaments=tournaments.filter(t=>(t.status==="completed"||t.status==="archived")
    &&(!archiveSearch.trim()||t.name.toLowerCase().includes(archiveSearch.trim().toLowerCase())));
  const visibleTournaments=view==="active"?activeTournaments:view==="archive"?archivedTournaments:[];
  const actionableUmpireMatches=[...umpireAssignments]
    .filter(m=>m.status!=="completed"&&m.status!=="cancelled")
    .sort((a,b)=>(a.status==="in_progress"?0:1)-(b.status==="in_progress"?0:1));

  // Open Scoreboard: an already-live assigned match goes straight to this device's own
  // ScoringScreen (reconcileOwnLiveMatches' isMineByUmpire widening in App.jsx already made it
  // controllable there); a not-yet-started one runs the Coin Toss first, per spec — no manual
  // winner selection, Start Match stays disabled until a result exists (see CoinTossModal).
  const openScoreboard=useCallback(match=>{
    if(match.status==="in_progress"&&match.liveMatchId){ onOpenLiveMatch?.(match.liveMatchId); return; }
    setCoinTossMatch(match);
  },[onOpenLiveMatch]);

  // Deep-link from Home's "YOU'RE UMPIRING" banner or an umpire_assigned notification tap —
  // lands on the Umpiring view and reuses this screen's own openScoreboard (same branch the
  // "Open Scoreboard" button below already uses) instead of a second navigation path. Mirrors
  // that button's own readyToStart gate so we don't try to auto-open a match with no teams set.
  useEffect(()=>{
    if(!deepLinkUmpireMatchId) return;
    const m=actionableUmpireMatches.find(x=>x.id===deepLinkUmpireMatchId);
    if(!m) return; // not loaded yet, or already completed/cancelled — stays pending, no-op
    // Reacting to an external signal (a prop set by a Home-banner tap or notification tap),
    // not deriving/mirroring local state — the one-shot setView+openScoreboard here is the
    // intended side effect, immediately consumed via onConsumeUmpireDeepLink so it can't loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView("umpiring");
    if(m.registrationAId&&m.registrationBId) openScoreboard(m);
    onConsumeUmpireDeepLink?.();
  },[deepLinkUmpireMatchId,actionableUmpireMatches,openScoreboard,onConsumeUmpireDeepLink]);

  // match_assigned deep-link, phase 1 of 2: select the tournament once it's loaded into this
  // screen's own list. Division selection (phase 2) happens inside TournamentDetailPanel once
  // its own division fetch completes — this effect only opens the panel and deliberately does
  // NOT consume the shared deep-link state yet, since TournamentDetailPanel still needs
  // deepLinkDivisionId on the next render to finish the drill-down.
  useEffect(()=>{
    if(!deepLinkTournamentId) return;
    if(!tournaments.some(t=>t.id===deepLinkTournamentId)) return; // not loaded yet
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId(deepLinkTournamentId);
  },[deepLinkTournamentId,tournaments]);

  const startFromCoinToss=useCallback(()=>{
    const match=coinTossMatch;
    if(!match) return;
    const division=umpireDivisions[match.divisionId];
    const tournament=tournaments.find(t=>t.id===match.tournamentId);
    const registrations=Object.values(umpireRegistrations).filter(r=>r.tournamentId===match.tournamentId);
    if(!division||!tournament){ notify?.("Match details still loading — try again in a moment","err"); return; }
    onStartMatch(match,division,registrations,tournament);
    setCoinTossMatch(null);
  },[coinTossMatch,umpireDivisions,umpireRegistrations,tournaments,onStartMatch,notify]);

  // Persists only the raw "heads"/"tails" result to the existing audit-log table (migration
  // 128 — no new schema) — never a team/winner, per spec. Best-effort/fire-and-forget like
  // every other appendAuditLog call site; a dropped write here just means one missing audit
  // row, never a missing/incorrect match outcome.
  const logCoinToss=useCallback(result=>{
    const match=coinTossMatch;
    const division=match&&umpireDivisions[match.divisionId];
    if(!match||!division) return;
    Cloud.appendAuditLog({tournamentMatchId:match.id,organizerId:division.organizerId,
      actorId:currentUser?.id,actorName:currentUser?.name,action:"coin_toss",detail:{result}});
  },[coinTossMatch,umpireDivisions,currentUser]);

  return(
    <div style={{background:D.bg,height:"100%",overflowY:"auto",padding:"14px 14px 80px"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:4}}>
        <div style={{fontWeight:900,fontSize:20,color:D.textPrimary,flex:1}}>Tournaments</div>
        <button onClick={()=>{setEditingTournament(null);setShowEditor(true);}}
          style={{padding:"8px 16px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
          + New
        </button>
      </div>
      <div style={{fontSize:12,color:D.textMuted,marginBottom:14}}>Divisions, registration, round robin and bracket play — synced live for everyone.</div>

      <div style={{marginBottom:14}}><FilterChipGroup options={VIEWS} value={view} onChange={setView}/></div>
      {view==="archive"&&(
        <input value={archiveSearch} onChange={e=>setArchiveSearch(e.target.value)} placeholder="Search archived tournaments…"
          style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"9px 12px",color:D.textPrimary,fontSize:13,marginBottom:14,outline:"none",boxSizing:"border-box"}}/>
      )}

      {view==="umpiring"&&actionableUmpireMatches.length===0&&(
        <motion.div initial="hidden" animate="show" variants={itemVariants} style={{textAlign:"center",padding:"60px 20px",background:D.surface,borderRadius:16,border:"1px solid "+D.border}}>
          <div style={{fontSize:44,marginBottom:12}}>🎽</div>
          <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>No assigned matches</div>
          <div style={{fontSize:12,color:D.textSecondary}}>A tournament organizer assigns you as umpire — assigned matches show up here automatically.</div>
        </motion.div>
      )}

      {view==="umpiring"&&actionableUmpireMatches.map(m=>{
        const tournament=tournaments.find(t=>t.id===m.tournamentId);
        const division=umpireDivisions[m.divisionId];
        const court=courts.find(c=>c.id===m.courtId);
        const nameA=regName(umpireRegistrations,m.registrationAId), nameB=regName(umpireRegistrations,m.registrationBId);
        const readyToStart=m.registrationAId&&m.registrationBId;
        const statusColor=MATCH_STATUS_COLOR[m.status]||D.textMuted;
        return(
          <Card key={m.id} padding="13px 14px" style={{marginBottom:10}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
              <span style={{fontSize:9,fontWeight:800,color:statusColor,background:alpha(statusColor,9),borderRadius:20,padding:"2px 8px",letterSpacing:"0.5px"}}>{m.status.replace("_"," ").toUpperCase()}</span>
              {m.status==="in_progress"&&<span style={{width:6,height:6,borderRadius:3,background:D.red,animation:"pulse 1s infinite"}}/>}
            </div>
            <div style={{fontSize:11,color:D.textMuted,marginBottom:6}}>
              {(tournament?.name||"Tournament")+" · "+(division?.name||"Division")+" · "+(court?.name||"Court")+" · Round "+m.round}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:700,color:D.textPrimary,marginBottom:10}}>
              <span style={{flex:1}}>{nameA}</span>
              <span style={{fontSize:10,color:D.textMuted,fontWeight:400}}>vs</span>
              <span style={{flex:1,textAlign:"right"}}>{nameB}</span>
            </div>
            <button onClick={()=>openScoreboard(m)} disabled={!readyToStart}
              style={{width:"100%",padding:10,background:readyToStart?D.accent:D.cardEl,border:"none",borderRadius:18,color:readyToStart?"#fff":D.textMuted,fontWeight:700,fontSize:12,cursor:readyToStart?"pointer":"default"}}>
              {m.status==="in_progress"?"Open Scoreboard":readyToStart?"Open Scoreboard":"Teams not set yet"}
            </button>
          </Card>
        );
      })}

      {view!=="umpiring"&&!loading&&visibleTournaments.length===0&&(
        <motion.div initial="hidden" animate="show" variants={itemVariants} style={{textAlign:"center",padding:"60px 20px",background:D.surface,borderRadius:16,border:"1px solid "+D.border}}>
          <div style={{fontSize:44,marginBottom:12}}>{view==="archive"?"📦":"🏆"}</div>
          <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>{view==="archive"?"No archived tournaments":"No tournaments yet"}</div>
          <div style={{fontSize:12,color:D.textSecondary}}>{view==="archive"?"Finished tournaments show up here.":"Create one to start registering players and generating brackets."}</div>
        </motion.div>
      )}

      {view!=="umpiring"&&visibleTournaments.map(t=>(
        <Card key={t.id} padding="13px 14px" style={{marginBottom:10}}>
          <button onClick={()=>setSelectedId(t.id)} style={{display:"flex",alignItems:"center",gap:12,width:"100%",background:"none",border:"none",padding:0,textAlign:"left",cursor:"pointer",font:"inherit",color:"inherit"}}>
            <div style={{width:44,height:44,borderRadius:12,background:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,overflow:"hidden"}}>
              {t.logoUrl ? <img src={t.logoUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/> : <span style={{fontSize:20}}>🏆</span>}
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{t.name}</div>
              <div style={{fontSize:11,color:D.textMuted}}>{t.venue||"No venue set"}{t.startDate?" · "+fmtDate(t.startDate):""}</div>
            </div>
            <span style={{fontSize:9,fontWeight:800,color:STATUS_COLOR[t.status]||D.textMuted,letterSpacing:"0.5px",textTransform:"uppercase",flexShrink:0}}>{t.status}</span>
          </button>
          {view==="archive"&&(
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <button onClick={()=>restoreTournament(t)}
                style={{flex:1,padding:"7px 0",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:14,color:D.accent,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                Restore
              </button>
              {t.status==="completed"&&(
                <button onClick={()=>archiveTournament(t)}
                  style={{flex:1,padding:"7px 0",background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  Archive
                </button>
              )}
              <button onClick={()=>duplicateTournament(t)}
                style={{flex:1,padding:"7px 0",background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                Duplicate
              </button>
            </div>
          )}
        </Card>
      ))}

      {showEditor&&<TournamentEditorModal tournament={editingTournament} onSave={saveTournament} onClose={()=>{setShowEditor(false);setEditingTournament(null);}}/>}
      {selected&&<TournamentDetailPanel tournament={selected} currentUser={currentUser} directory={directory} accountsDirectory={accountsDirectory} courts={courts}
        onStartMatch={onStartMatch} notify={notify}
        onEdit={t=>{setEditingTournament(t);setShowEditor(true);}} onDelete={deleteTournament} onPatchTournament={patchTournament}
        deepLinkDivisionId={deepLinkDivisionId} onConsumeMatchAssignedDeepLink={onConsumeMatchAssignedDeepLink}
        onClose={()=>{setSelectedId(null);onConsumeMatchAssignedDeepLink?.();}}/>}
      {coinTossMatch&&<CoinTossModal
        teamALabel={regName(umpireRegistrations,coinTossMatch.registrationAId)}
        teamBLabel={regName(umpireRegistrations,coinTossMatch.registrationBId)}
        onStart={startFromCoinToss} onToss={logCoinToss} onClose={()=>setCoinTossMatch(null)}/>}
    </div>
  );
}
