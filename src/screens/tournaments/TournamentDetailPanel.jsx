import { useState, useEffect, useCallback } from "react";
import { Panel } from "../../components/ui/Panel.jsx";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { DivisionEditorModal } from "../../modals/DivisionEditorModal.jsx";
import { DivisionDetailPanel } from "./DivisionDetailPanel.jsx";
import { StatisticsPanel } from "./StatisticsPanel.jsx";
import { ResultsPanel } from "./ResultsPanel.jsx";
import { SyncCenterPanel } from "./SyncCenterPanel.jsx";
import { UmpirePickerModal } from "./UmpirePickerModal.jsx";
import { Cloud } from "../../lib/cloud.js";
import { Outbox } from "../../lib/outbox.js";
import { LS } from "../../lib/storage.js";
import { canControlTournament } from "../../lib/tournamentPermissions.js";
import { uid } from "../../lib/utils.js";
import { buildTournamentStandings } from "../../lib/tournamentStandings.js";
import { exportStandingsCsv, exportResultsCsv, exportSheetsXlsx } from "../../lib/tournamentExport.js";
import { D } from "../../theme/tokens.js";

const FORMAT_LABEL={round_robin:"Round Robin",single_elimination:"Single Elimination",double_elimination:"Double Elimination",pool_play:"Pool Play",pool_to_knockout:"Pool to Knockout"};
// pool_to_knockout with poolCount:1 is the "Round Robin + Knockout" UI preset (see
// DivisionEditorModal.jsx) — same stored format, friendlier badge text.
const formatLabelFor=d=>d.format==="pool_to_knockout"&&d.poolCount===1?"Round Robin + Knockout":(FORMAT_LABEL[d.format]||d.format);
const TYPE_LABEL={singles:"Singles",doubles:"Doubles",mixed:"Mixed"};
const COURT_STATUS_CYCLE=["available","occupied","cleaning","maintenance"];
const COURT_STATUS_COLOR={available:D.green,occupied:D.red,cleaning:D.accent,maintenance:D.textMuted};

const teamNameFor=(registrations,id)=>{
  if(!id) return "TBD";
  const r=registrations.find(x=>x.id===id);
  return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "—";
};

// Connection status: no Presence infra in this codebase — a simple heartbeat column
// (umpire_last_seen_at, updated every ~15s by the umpire's own open scoreboard view)
// plus a client-computed staleness threshold does the same job with zero new
// subscriptions (tournament_matches is already realtime-published).
const UMPIRE_ONLINE_THRESHOLD_MS=20000;
const umpireOnlineAt=(m,now)=>!!(m?.umpireLastSeenAt&&(now-new Date(m.umpireLastSeenAt).getTime())<UMPIRE_ONLINE_THRESHOLD_MS);
const lastSyncLabel=(m,now)=>{
  if(!m?.umpireLastSeenAt) return "never synced";
  const secs=Math.max(0,Math.round((now-new Date(m.umpireLastSeenAt).getTime())/1000));
  if(secs<60) return "last sync "+secs+"s ago";
  return "last sync "+Math.round(secs/60)+"m ago";
};

export function TournamentDetailPanel({tournament,currentUser,directory=[],accountsDirectory=[],courts=[],onStartMatch,onEdit,onDelete,onPatchTournament,onClose,notify,deepLinkDivisionId=null,onConsumeMatchAssignedDeepLink}){
  const [tab,setTab]=useState("dashboard");
  const [umpirePickerMatch,setUmpirePickerMatch]=useState(null);
  // Ticks every 5s so the Courts tab's umpire 🟢/🔴 dot and "last sync Xs ago" label
  // stay fresh without a new subscription — purely a render trigger, no state read by
  // anything else.
  const [nowTick,setNowTick]=useState(()=>Date.now());
  useEffect(()=>{ const t=setInterval(()=>setNowTick(Date.now()),5000); return ()=>clearInterval(t); },[]);
  // LS-mirrored per tournament id — this panel fully unmounts on close (not a persistent
  // top-level screen), so without this a cold offline reopen would show empty until Cloud
  // reconnects, unlike every other cached slice of app state.
  const [divisions,setDivisions]=useState(()=>LS.get("pl6_divisions_"+tournament.id,[]));
  const [matches,setMatches]=useState(()=>LS.get("pl6_tmatches_"+tournament.id,[]));
  const [registrations,setRegistrations]=useState(()=>LS.get("pl6_tregs_"+tournament.id,[]));
  const [showDivisionEditor,setShowDivisionEditor]=useState(false);
  const [selectedDivisionId,setSelectedDivisionId]=useState(null);
  // Local overrides layered on top of the `courts` prop (owned by App.jsx, no realtime
  // subscription of its own) — same reasoning as the additive-merge pattern used for
  // divisions/matches/registrations above: this panel can write status via Outbox/Cloud,
  // but can't call the parent's setCourts, so it tracks its own optimistic view until the
  // next full courts refetch picks up the confirmed value.
  const [courtStatusOverrides,setCourtStatusOverrides]=useState({});
  const [swapPendingMatchId,setSwapPendingMatchId]=useState(null);
  const [refereeDrafts,setRefereeDrafts]=useState({});
  const [historyDivisionFilter,setHistoryDivisionFilter]=useState("all");
  const [historyRoundFilter,setHistoryRoundFilter]=useState("all");
  const [historyDateFrom,setHistoryDateFrom]=useState("");
  const [historyDateTo,setHistoryDateTo]=useState("");
  // Delete confirmations used to go through native window.confirm() — replaced with the app's
  // own ConfirmDialog so a destructive action doesn't break out of the app's visual language.
  const [confirmDeleteTournament,setConfirmDeleteTournament]=useState(false);
  const [confirmDeleteDivision,setConfirmDeleteDivision]=useState(null);
  const [confirmFinishTournament,setConfirmFinishTournament]=useState(false);
  const canEdit=canControlTournament(tournament,currentUser);

  useEffect(()=>{ LS.set("pl6_divisions_"+tournament.id,divisions); },[divisions,tournament.id]);
  useEffect(()=>{ LS.set("pl6_tmatches_"+tournament.id,matches); },[matches,tournament.id]);
  useEffect(()=>{ LS.set("pl6_tregs_"+tournament.id,registrations); },[registrations,tournament.id]);

  useEffect(()=>{
    let alive=true;
    Cloud.fetchDivisions(tournament.id).then(rows=>{
      // Additive merge, not a wholesale replace — this Panel fully unmounts on close and
      // remounts fresh on reopen (unlike a top-level nav screen), so a division just created
      // via Outbox may not have drained to Supabase yet the next time this effect runs.
      if(alive) setDivisions(prev=>{
        const ids=new Set(rows.map(d=>d.id));
        const localOnly=prev.filter(d=>!ids.has(d.id));
        return [...rows,...localOnly];
      });
    });
    let channel=null;
    Cloud.subscribeDivisions(tournament.id,(mapped,eventType)=>{
      setDivisions(prev=>{
        if(eventType==="DELETE") return prev.filter(d=>d.id!==mapped.id);
        const exists=prev.some(d=>d.id===mapped.id);
        return exists ? prev.map(d=>d.id===mapped.id?mapped:d) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) channel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(channel) Cloud.removeChannel(channel); };
  },[tournament.id]);

  // match_assigned deep-link, phase 2 of 2: waits for this tournament's own division fetch
  // (the effect above) to actually contain the target division before selecting it, then
  // finally consumes the shared deep-link state that TournamentsListScreen deliberately left
  // un-consumed after phase 1 (selecting this tournament).
  useEffect(()=>{
    if(!deepLinkDivisionId) return;
    if(!divisions.some(d=>d.id===deepLinkDivisionId)) return; // not loaded yet
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedDivisionId(deepLinkDivisionId);
    onConsumeMatchAssignedDeepLink?.();
  },[deepLinkDivisionId,divisions,onConsumeMatchAssignedDeepLink]);

  // Tournament-wide matches (all divisions) — feeds the Overview live-count and Courts tab.
  // Separate from DivisionDetailPanel's own division-scoped fetch/subscribe, no overlap.
  useEffect(()=>{
    let alive=true;
    Cloud.fetchTournamentMatchesForTournament(tournament.id).then(rows=>{
      if(alive) setMatches(prev=>{
        const ids=new Set(rows.map(m=>m.id));
        const localOnly=prev.filter(m=>!ids.has(m.id));
        return [...rows,...localOnly];
      });
    });
    let channel=null;
    Cloud.subscribeTournamentMatchesForTournament(tournament.id,(mapped,eventType)=>{
      setMatches(prev=>{
        if(eventType==="DELETE") return prev.filter(m=>m.id!==mapped.id);
        const exists=prev.some(m=>m.id===mapped.id);
        return exists ? prev.map(m=>m.id===mapped.id?mapped:m) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) channel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(channel) Cloud.removeChannel(channel); };
  },[tournament.id]);

  // Tournament-wide registrations (all divisions) — feeds Match History's team-name lookup.
  // Same additive-merge pattern as the two effects above, separate from DivisionDetailPanel's
  // own division-scoped fetch/subscribe.
  useEffect(()=>{
    let alive=true;
    Cloud.fetchRegistrationsForTournament(tournament.id).then(rows=>{
      if(alive) setRegistrations(prev=>{
        const ids=new Set(rows.map(r=>r.id));
        const localOnly=prev.filter(r=>!ids.has(r.id));
        return [...rows,...localOnly];
      });
    });
    let channel=null;
    Cloud.subscribeRegistrationsForTournament(tournament.id,(mapped,eventType)=>{
      setRegistrations(prev=>{
        if(eventType==="DELETE") return prev.filter(r=>r.id!==mapped.id);
        const exists=prev.some(r=>r.id===mapped.id);
        return exists ? prev.map(r=>r.id===mapped.id?mapped:r) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) channel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(channel) Cloud.removeChannel(channel); };
  },[tournament.id]);

  const createDivision=useCallback(fields=>{
    const d={id:"tdiv_"+uid(),tournamentId:tournament.id,organizerId:tournament.ownerId,status:"pending",...fields};
    Outbox.enqueue("createDivision",{division:d});
    setDivisions(prev=>[...prev,d]);
    notify?.("Division created");
    setShowDivisionEditor(false);
  },[tournament.id,tournament.ownerId,notify]);

  // Structure only — never copies this division's registrations/matches/seeding, so a
  // duplicate never leaks live participant/score data into what should read as a fresh division.
  const duplicateDivision=useCallback(division=>{
    const d={id:"tdiv_"+uid(),tournamentId:tournament.id,organizerId:tournament.ownerId,
      name:division.name+" (Copy)",category:division.category,skillLevel:division.skillLevel,
      isDoubles:division.isDoubles,format:division.format,winTo:division.winTo,bestOf:division.bestOf,
      winBy:division.winBy,timeoutsAllowed:division.timeoutsAllowed,hasBronzeMatch:division.hasBronzeMatch,
      top4Playoffs:division.top4Playoffs,
      poolCount:division.poolCount,poolAdvanceCount:division.poolAdvanceCount,poolKnockoutFormat:division.poolKnockoutFormat,
      status:"pending"};
    Outbox.enqueue("createDivision",{division:d});
    setDivisions(prev=>[...prev,d]);
    notify?.("Division duplicated");
  },[tournament.id,tournament.ownerId,notify]);

  const deleteDivision=useCallback(division=>{
    Outbox.enqueue("deleteDivision",{id:division.id});
    Outbox.drain();
    setDivisions(prev=>prev.filter(d=>d.id!==division.id));
    if(selectedDivisionId===division.id) setSelectedDivisionId(null);
    notify?.("Division deleted");
  },[selectedDivisionId,notify]);

  // Court Management: Status cycles Available -> Occupied -> Cleaning -> Maintenance ->
  // Available. Swap is a two-click flow: pick the first in-progress match's court, then
  // pick a second one to exchange their court_id — both existing updateTournamentMatch
  // outbox calls, no new write path needed.
  const cycleCourtStatus=useCallback(court=>{
    const current=courtStatusOverrides[court.id]??court.status??"available";
    const next=COURT_STATUS_CYCLE[(COURT_STATUS_CYCLE.indexOf(current)+1)%COURT_STATUS_CYCLE.length];
    Outbox.enqueue("updateCourtStatus",{id:court.id,status:next});
    setCourtStatusOverrides(prev=>({...prev,[court.id]:next}));
  },[courtStatusOverrides]);

  const moveMatchToCourt=useCallback((matchId,courtId)=>{
    Outbox.enqueue("updateTournamentMatch",{id:matchId,patch:{courtId}});
    setMatches(prev=>prev.map(m=>m.id===matchId?{...m,courtId}:m));
    notify?.("Match moved");
  },[notify]);

  const commitReferee=useCallback((matchId,name)=>{
    Outbox.enqueue("updateTournamentMatch",{id:matchId,patch:{refereeName:name||null}});
    setMatches(prev=>prev.map(m=>m.id===matchId?{...m,refereeName:name||null}:m));
  },[]);

  // Same unilateral umpire-assignment write as DivisionDetailPanel's own assignUmpire —
  // duplicated rather than lifted higher because the two panels don't share a common
  // ancestor with match state (each fetches/subscribes its own `matches` slice).
  const assignUmpire=useCallback((match,umpireId,umpireName)=>{
    const patch={umpireId,umpireName,umpireAssignedAt:umpireId?new Date().toISOString():null};
    Outbox.enqueue("updateTournamentMatch",{id:match.id,patch});
    setMatches(prev=>prev.map(m=>m.id===match.id?{...m,...patch}:m));
    Outbox.drain();
    const div=divisions.find(d=>d.id===match.divisionId);
    if(umpireId){
      Cloud.sendNotification({userId:umpireId,type:"umpire_assigned",title:"You've been assigned as umpire",
        body:(div?.name||tournament.name)+" · "+teamNameFor(registrations,match.registrationAId)+" vs "+teamNameFor(registrations,match.registrationBId),
        matchId:match.id,actorId:currentUser?.id,actorName:currentUser?.name});
      Cloud.appendAuditLog({tournamentMatchId:match.id,organizerId:tournament.ownerId,actorId:currentUser?.id,actorName:currentUser?.name,
        action:"umpire_assigned",detail:{umpireId,umpireName}});
      notify?.("Umpire assigned");
    } else {
      Cloud.appendAuditLog({tournamentMatchId:match.id,organizerId:tournament.ownerId,actorId:currentUser?.id,actorName:currentUser?.name,
        action:"umpire_removed",detail:null});
      notify?.("Umpire removed");
    }
  },[divisions,registrations,tournament.name,tournament.ownerId,currentUser,notify]);

  // Finish Tournament: flips status to completed (existing updateTournament outbox kind —
  // Archive, Phase 17, just lists tournaments with this status, so nothing else is needed
  // to "archive" it). Final Rankings/Statistics are already live in the Standings/
  // Statistics tabs, not re-generated here — Finish's own job is the status flip plus the
  // export snapshot below. Prepare DUPR Submission is already covered by Sync Center.
  const finishTournament=useCallback(()=>{
    onPatchTournament?.(tournament.id,{status:"completed"},"Tournament finished");
  },[tournament.id,onPatchTournament]);

  const exportAllStandingsXlsx=useCallback(async()=>{
    const nameFor=id=>teamNameFor(registrations,id);
    const sheets=divisions.map(d=>{
      const standings=buildTournamentStandings(registrations.filter(r=>r.divisionId===d.id),matches.filter(m=>m.divisionId===d.id));
      return {
        name:d.name,
        headers:["Rank","Player/Team","Wins","Losses","Games Won","Games Lost","Points For","Points Against","Point Diff","Avg Score"],
        rows:standings.map(s=>[s.rank,nameFor(s.registrationId),s.wins,s.losses,s.gamesWon,s.gamesLost,s.pointsFor,s.pointsAgainst,s.pointDiff,s.averageScore]),
      };
    });
    if(!sheets.length){ notify?.("No divisions to export","err"); return; }
    const ok=await exportSheetsXlsx(tournament.name+"-standings",sheets);
    if(ok) notify?.("Standings exported");
  },[divisions,registrations,matches,tournament.name,notify]);

  const exportStandingsForDivisionCsv=useCallback(async division=>{
    const standings=buildTournamentStandings(registrations.filter(r=>r.divisionId===division.id),matches.filter(m=>m.divisionId===division.id));
    const ok=await exportStandingsCsv(tournament.name,division.name,standings,id=>teamNameFor(registrations,id));
    if(ok) notify?.("Standings exported");
  },[registrations,matches,tournament.name,notify]);

  const exportResults=useCallback(async()=>{
    const results=await Cloud.fetchTournamentResults(tournament.id);
    if(!results.length){ notify?.("No results recorded yet","err"); return; }
    const AWARD_LABEL={champion:"Champion",runner_up_1:"Runner-up",runner_up_2:"2nd Runner-up",mvp:"MVP",best_sportsmanship:"Best Sportsmanship"};
    const rows=results.map(r=>({award:AWARD_LABEL[r.awardType]||r.awardType,name:r.playerName,division:divisions.find(d=>d.id===r.divisionId)?.name,notes:r.notes}));
    const ok=await exportResultsCsv(tournament.name,rows);
    if(ok) notify?.("Results exported");
  },[tournament.id,tournament.name,divisions,notify]);

  const onSwapClick=useCallback(matchId=>{
    if(!swapPendingMatchId){ setSwapPendingMatchId(matchId); return; }
    if(swapPendingMatchId===matchId){ setSwapPendingMatchId(null); return; }
    const a=matches.find(m=>m.id===swapPendingMatchId), b=matches.find(m=>m.id===matchId);
    if(!a||!b){ setSwapPendingMatchId(null); return; }
    Outbox.enqueue("updateTournamentMatch",{id:a.id,patch:{courtId:b.courtId}});
    Outbox.enqueue("updateTournamentMatch",{id:b.id,patch:{courtId:a.courtId}});
    setMatches(prev=>prev.map(m=>m.id===a.id?{...m,courtId:b.courtId}:m.id===b.id?{...m,courtId:a.courtId}:m));
    setSwapPendingMatchId(null);
    notify?.("Courts swapped");
  },[swapPendingMatchId,matches,notify]);

  const selectedDivision=selectedDivisionId?divisions.find(d=>d.id===selectedDivisionId):null;
  const inProgressMatches=matches.filter(m=>m.status==="in_progress");
  const upcomingMatches=matches.filter(m=>m.status==="pending"||m.status==="scheduled");
  const completedMatches=matches.filter(m=>m.status==="completed").sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0));
  // Match History filters — division/round ("bracket")/date, pure client-side filtering
  // of the already-fetched completedMatches array, same FilterChip pattern used elsewhere.
  const historyRoundOptions=[...new Set(completedMatches
    .filter(m=>historyDivisionFilter==="all"||m.divisionId===historyDivisionFilter)
    .map(m=>m.round))].sort((a,b)=>a-b);
  const filteredHistoryMatches=completedMatches.filter(m=>{
    if(historyDivisionFilter!=="all"&&m.divisionId!==historyDivisionFilter) return false;
    if(historyRoundFilter!=="all"&&m.round!==+historyRoundFilter) return false;
    if(historyDateFrom&&(!m.updatedAt||new Date(m.updatedAt)<new Date(historyDateFrom))) return false;
    if(historyDateTo&&(!m.updatedAt||new Date(m.updatedAt)>new Date(historyDateTo+"T23:59:59"))) return false;
    return true;
  });
  // Dashboard counts — derived from data this panel already fetches (registrations
  // tournament-wide, matches tournament-wide, the courts prop), no new fetch needed.
  const totalPlayers=new Set(registrations.filter(r=>r.status!=="withdrawn").flatMap(r=>r.playerIds||[])).size;
  const totalTeams=registrations.filter(r=>r.status!=="withdrawn"&&(r.playerIds||[]).length>1).length;
  const progressPct=matches.length?Math.round(completedMatches.length/matches.length*100):0;
  const STAGE_LABEL={draft:"Setup",active:"In Progress",completed:"Completed",cancelled:"Cancelled",archived:"Archived"};
  const tabs=[
    {value:"dashboard",label:"Dashboard"},
    {value:"divisions",label:"Divisions · "+divisions.length},
    {value:"courts",label:"Courts"},
    {value:"history",label:"Match History"},
    {value:"statistics",label:"Statistics"},
    {value:"results",label:"Results"},
    {value:"sync",label:"Sync Center"},
  ];

  return(
    <Panel title={tournament.name} sub={tournament.venue||undefined} onClose={onClose}
      headerRight={canEdit&&(
        <div style={{display:"flex",gap:6}}>
          <button onClick={()=>onEdit(tournament)} style={{padding:"6px 12px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>Edit</button>
          <button onClick={()=>setConfirmDeleteTournament(true)}
            style={{padding:"6px 12px",background:D.redBg,border:"1px solid "+D.red,borderRadius:16,color:D.red,fontWeight:700,fontSize:11,cursor:"pointer"}}>Delete</button>
        </div>
      )}>
      <div style={{marginBottom:16}}><FilterChipGroup options={tabs} value={tab} onChange={setTab}/></div>

      {tab==="dashboard"&&(
        <>
          {tournament.bannerUrl&&(
            <div style={{width:"100%",height:120,borderRadius:14,overflow:"hidden",marginBottom:14,background:D.surface}}>
              <img src={tournament.bannerUrl} alt="" style={{width:"100%",height:"100%",objectFit:"cover"}}/>
            </div>
          )}
          {tournament.types&&tournament.types.length>0&&(
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
              {tournament.types.map(t=>(
                <span key={t} style={{fontSize:10,fontWeight:700,color:D.accent,background:D.accentBg,borderRadius:20,padding:"3px 10px"}}>{TYPE_LABEL[t]||t}</span>
              ))}
            </div>
          )}
          {tournament.description&&<div style={{fontSize:12,color:D.textSecondary,marginBottom:16,lineHeight:1.6}}>{tournament.description}</div>}

          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <div style={{fontSize:12,color:D.textSecondary}}><b>Stage:</b> {STAGE_LABEL[tournament.status]||tournament.status}</div>
            <div style={{fontSize:11,color:D.textMuted}}>{progressPct}% complete</div>
          </div>
          <div style={{width:"100%",height:6,background:D.cardEl,borderRadius:3,overflow:"hidden",marginBottom:16}}>
            <div style={{width:progressPct+"%",height:"100%",background:D.accent}}/>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:16}}>
            {[["Divisions",divisions.length],["Players",totalPlayers],["Teams",totalTeams],["Courts",courts.length]].map(([label,value])=>(
              <Card key={label} padding="12px 6px" style={{textAlign:"center"}}>
                <div style={{fontSize:18,fontWeight:900,color:D.textPrimary}}>{value}</div>
                <div style={{fontSize:9,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginTop:2}}>{label.toUpperCase()}</div>
              </Card>
            ))}
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
            <Card padding="12px 6px" style={{textAlign:"center"}}>
              <div style={{fontSize:18,fontWeight:900,color:inProgressMatches.length?D.red:D.textPrimary}}>{inProgressMatches.length}</div>
              <div style={{fontSize:9,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginTop:2}}>LIVE</div>
            </Card>
            <Card padding="12px 6px" style={{textAlign:"center"}}>
              <div style={{fontSize:18,fontWeight:900,color:D.textPrimary}}>{upcomingMatches.length}</div>
              <div style={{fontSize:9,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginTop:2}}>UPCOMING</div>
            </Card>
            <Card padding="12px 6px" style={{textAlign:"center"}}>
              <div style={{fontSize:18,fontWeight:900,color:D.textPrimary}}>{completedMatches.length}</div>
              <div style={{fontSize:9,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginTop:2}}>FINISHED</div>
            </Card>
          </div>

          {tournament.venue&&<div style={{fontSize:12,color:D.textSecondary,marginBottom:6}}><b>Venue:</b> {tournament.venue}</div>}

          {canEdit&&(
            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>QUICK ACTIONS</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>setShowDivisionEditor(true)}
                  style={{padding:"8px 14px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:16,color:D.accent,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  + Create Division
                </button>
                <button onClick={()=>setTab("divisions")}
                  style={{padding:"8px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  Generate Bracket / Start Match
                </button>
                <button onClick={()=>setTab("courts")}
                  style={{padding:"8px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  Go Live / Assign Court
                </button>
                {tournament.status!=="completed"&&tournament.status!=="cancelled"&&(
                  <button onClick={()=>setConfirmFinishTournament(true)}
                    style={{padding:"8px 14px",background:D.redBg,border:"1px solid "+D.red,borderRadius:16,color:D.red,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                    Finish Tournament
                  </button>
                )}
              </div>
            </div>
          )}

          {canEdit&&(
            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>EXPORT</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={exportAllStandingsXlsx}
                  style={{padding:"8px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  Standings (Excel)
                </button>
                <button onClick={exportResults}
                  style={{padding:"8px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  Results (CSV)
                </button>
                <button onClick={()=>notify?.("PDF export coming soon")}
                  style={{padding:"8px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textMuted,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  PDF (coming soon)
                </button>
                <button onClick={()=>notify?.("Certificates coming soon")}
                  style={{padding:"8px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textMuted,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                  Certificates (coming soon)
                </button>
              </div>
            </div>
          )}

          {inProgressMatches.length>0&&(
            <div>
              <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>LIVE ACTIVITY</div>
              {inProgressMatches.map(m=>{
                const div=divisions.find(d=>d.id===m.divisionId);
                const court=courts.find(c=>c.id===m.courtId);
                const nameA=teamNameFor(registrations,m.registrationAId), nameB=teamNameFor(registrations,m.registrationBId);
                const sc=m.score||{};
                return(
                  <Card key={m.id} padding="11px 13px" style={{marginBottom:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                      <span style={{width:6,height:6,borderRadius:3,background:D.red,display:"inline-block",animation:"pulse 1s infinite"}}/>
                      <div style={{fontSize:11,color:D.textMuted,flex:1}}>{(court?.name||"Court")+" · "+(div?.name||"—")}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,fontWeight:700,color:D.textPrimary}}>
                      <span style={{flex:1}}>{nameA}</span>
                      <span>{(sc.scoreA??0)+" - "+(sc.scoreB??0)}</span>
                      <span style={{flex:1,textAlign:"right"}}>{nameB}</span>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {tab==="divisions"&&(
        <>
          {canEdit&&<button onClick={()=>setShowDivisionEditor(true)}
            style={{width:"100%",padding:11,background:D.accentBg,border:"1px solid "+D.accent,borderRadius:20,color:D.accent,fontWeight:700,fontSize:13,cursor:"pointer",marginBottom:14}}>
            + New Division
          </button>}

          {divisions.length===0&&(
            <div style={{textAlign:"center",padding:"40px 20px",color:D.textMuted}}>
              <div style={{fontSize:36,marginBottom:8}}>🏆</div>
              <div style={{fontSize:13}}>No divisions yet.</div>
            </div>
          )}
          {divisions.map(d=>(
            <div key={d.id} onClick={()=>setSelectedDivisionId(d.id)} role="button" tabIndex={0}
              onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();setSelectedDivisionId(d.id);}}}
              style={{background:D.surface,border:"1px solid "+D.border,borderRadius:14,padding:"13px 14px",marginBottom:10,cursor:"pointer"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,flex:1}}>{d.name}</div>
                <span style={{fontSize:9,fontWeight:700,color:D.accent,background:D.accentBg,borderRadius:20,padding:"2px 8px"}}>{formatLabelFor(d)}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <div style={{fontSize:11,color:D.textMuted,flex:1}}>{d.category||(d.isDoubles?"Doubles":"Singles")}{d.skillLevel?" · "+d.skillLevel:""}</div>
                {canEdit&&(
                  <div style={{display:"flex",gap:6,flexShrink:0}} onClick={e=>e.stopPropagation()}>
                    <button onClick={()=>exportStandingsForDivisionCsv(d)}
                      style={{padding:"4px 9px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,color:D.textSecondary,fontWeight:700,fontSize:10,cursor:"pointer"}}>
                      Export CSV
                    </button>
                    <button onClick={()=>duplicateDivision(d)}
                      style={{padding:"4px 9px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,color:D.textSecondary,fontWeight:700,fontSize:10,cursor:"pointer"}}>
                      Duplicate
                    </button>
                    <button onClick={()=>setConfirmDeleteDivision(d)}
                      style={{padding:"4px 9px",background:D.redBg,border:"1px solid "+D.red,borderRadius:14,color:D.red,fontWeight:700,fontSize:10,cursor:"pointer"}}>
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      {tab==="courts"&&(
        <>
          {courts.length===0&&(
            <div style={{textAlign:"center",padding:"40px 20px",color:D.textMuted}}>
              <div style={{fontSize:36,marginBottom:8}}>🎾</div>
              <div style={{fontSize:13}}>No courts set up yet.</div>
            </div>
          )}
          {courts.map(c=>{
            const cm=inProgressMatches.filter(m=>m.courtId===c.id);
            const div=cm.length?divisions.find(d=>d.id===cm[0].divisionId):null;
            const status=courtStatusOverrides[c.id]??c.status??"available";
            const otherAvailableCourts=courts.filter(x=>x.id!==c.id&&x.active&&(courtStatusOverrides[x.id]??x.status??"available")==="available");
            const nextOnCourt=matches.filter(m=>m.courtId===c.id&&(m.status==="pending"||m.status==="scheduled"))
              .sort((a,b)=>a.round-b.round)[0]||null;
            const nextDiv=nextOnCourt?divisions.find(d=>d.id===nextOnCourt.divisionId):null;
            return(
              <Card key={c.id} padding="12px 14px" style={{marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <div style={{width:10,height:10,borderRadius:5,background:c.color||D.accent,flexShrink:0}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:700,fontSize:13,color:D.textPrimary}}>{c.name}</div>
                    <div style={{fontSize:11,color:D.textMuted}}>{cm.length?(div?.name||"Tournament match")+" · Round "+cm[0].round:"Open"}</div>
                    {cm[0]?.refereeName&&<div style={{fontSize:10,color:D.textMuted}}>Referee: {cm[0].refereeName}</div>}
                    {nextOnCourt&&<div style={{fontSize:10,color:D.textMuted,marginTop:2}}>Next: {(nextDiv?.name||"Match")+" · Round "+nextOnCourt.round}</div>}
                  </div>
                  {cm.length>0&&<div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
                    <span style={{width:7,height:7,borderRadius:4,background:D.red,display:"inline-block",animation:"pulse 1s infinite"}}/>
                    <span style={{fontSize:10,fontWeight:700,color:D.red}}>LIVE</span>
                  </div>}
                  {canEdit&&(
                    <button onClick={()=>cycleCourtStatus(c)}
                      style={{padding:"4px 9px",background:D.cardEl,border:"1px solid "+(COURT_STATUS_COLOR[status]||D.border),borderRadius:14,color:COURT_STATUS_COLOR[status]||D.textSecondary,fontWeight:700,fontSize:9,letterSpacing:"0.5px",textTransform:"uppercase",cursor:"pointer",flexShrink:0}}>
                      {status}
                    </button>
                  )}
                </div>
                {canEdit&&cm.length>0&&(
                  <>
                    <div style={{display:"flex",gap:8,alignItems:"center",marginTop:10}}>
                      <select value="" onChange={e=>{if(e.target.value)moveMatchToCourt(cm[0].id,e.target.value);}}
                        style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:8,padding:"6px 8px",color:D.textPrimary,fontSize:11}}>
                        <option value="">Move to court…</option>
                        {otherAvailableCourts.map(oc=><option key={oc.id} value={oc.id}>{oc.name}</option>)}
                      </select>
                      <button onClick={()=>onSwapClick(cm[0].id)}
                        style={{padding:"6px 12px",background:swapPendingMatchId===cm[0].id?D.accent:D.cardEl,border:"1px solid "+D.accent,borderRadius:14,color:swapPendingMatchId===cm[0].id?"#fff":D.accent,fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>
                        {swapPendingMatchId===cm[0].id?"Cancel Swap":"Swap"}
                      </button>
                    </div>
                    <input value={refereeDrafts[cm[0].id]??cm[0].refereeName??""} placeholder="Referee name"
                      onChange={e=>setRefereeDrafts(prev=>({...prev,[cm[0].id]:e.target.value}))}
                      onBlur={e=>commitReferee(cm[0].id,e.target.value.trim())}
                      style={{width:"100%",marginTop:8,background:D.cardEl,border:"1px solid "+D.border,borderRadius:8,padding:"6px 8px",color:D.textPrimary,fontSize:11,outline:"none",boxSizing:"border-box"}}/>
                    <button onClick={()=>setUmpirePickerMatch(cm[0])}
                      style={{width:"100%",marginTop:8,padding:"6px 8px",background:cm[0].umpireName?D.accentBg:D.cardEl,border:"1px solid "+(cm[0].umpireName?D.accent:D.border),borderRadius:8,color:cm[0].umpireName?D.accent:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer"}}>
                      {cm[0].umpireName?"🎽 "+cm[0].umpireName+(umpireOnlineAt(cm[0],nowTick)?" 🟢":" 🔴")+" · "+lastSyncLabel(cm[0],nowTick):"+ Assign Umpire"}
                    </button>
                  </>
                )}
              </Card>
            );
          })}
        </>
      )}

      {tab==="history"&&(
        <>
          {completedMatches.length>0&&(
            <div style={{marginBottom:14}}>
              <div style={{marginBottom:8}}>
                <FilterChipGroup
                  options={[{value:"all",label:"All Divisions"},...divisions.map(d=>({value:d.id,label:d.name}))]}
                  value={historyDivisionFilter} onChange={v=>{setHistoryDivisionFilter(v);setHistoryRoundFilter("all");}}/>
              </div>
              {historyRoundOptions.length>1&&(
                <div style={{marginBottom:8}}>
                  <FilterChipGroup
                    options={[{value:"all",label:"All Rounds"},...historyRoundOptions.map(r=>({value:String(r),label:"Round "+r}))]}
                    value={historyRoundFilter} onChange={setHistoryRoundFilter}/>
                </div>
              )}
              <div style={{display:"flex",gap:8}}>
                <input type="date" value={historyDateFrom} onChange={e=>setHistoryDateFrom(e.target.value)}
                  style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:8,padding:"7px 8px",color:D.textPrimary,fontSize:11}}/>
                <input type="date" value={historyDateTo} onChange={e=>setHistoryDateTo(e.target.value)}
                  style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:8,padding:"7px 8px",color:D.textPrimary,fontSize:11}}/>
              </div>
            </div>
          )}
          {completedMatches.length===0&&(
            <div style={{textAlign:"center",padding:"40px 20px",color:D.textMuted}}>
              <div style={{fontSize:36,marginBottom:8}}>📜</div>
              <div style={{fontSize:13}}>No completed matches yet.</div>
            </div>
          )}
          {completedMatches.length>0&&filteredHistoryMatches.length===0&&(
            <div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>No matches match these filters.</div>
          )}
          {filteredHistoryMatches.map(m=>{
            const div=divisions.find(d=>d.id===m.divisionId);
            const court=courts.find(c=>c.id===m.courtId);
            const nameA=teamNameFor(registrations,m.registrationAId);
            const nameB=teamNameFor(registrations,m.registrationBId);
            const winnerName=m.winner==="A"?nameA:m.winner==="B"?nameB:null;
            const sc=m.score||{};
            const scoreLabel=(sc.games&&sc.games.length>1)?(sc.gamesWonA??0)+" - "+(sc.gamesWonB??0):(sc.scoreA??0)+" - "+(sc.scoreB??0);
            return(
              <Card key={m.id} padding="12px 14px" style={{marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <div style={{fontSize:11,color:D.textMuted,flex:1}}>{(div?.name||"—")+" · Round "+m.round+(court?" · "+court.name:"")}</div>
                  {m.updatedAt&&<div style={{fontSize:10,color:D.textMuted}}>{new Date(m.updatedAt).toLocaleDateString()}</div>}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{flex:1,fontSize:13,fontWeight:m.winner==="A"?800:600,color:m.winner==="A"?D.green:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{nameA}</div>
                  <div style={{fontSize:13,fontWeight:800,color:D.textPrimary,flexShrink:0}}>{scoreLabel}</div>
                  <div style={{flex:1,fontSize:13,fontWeight:m.winner==="B"?800:600,color:m.winner==="B"?D.green:D.textPrimary,textAlign:"right",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{nameB}</div>
                </div>
                {winnerName&&<div style={{fontSize:10,color:D.green,fontWeight:700,marginTop:6}}>Winner: {winnerName}</div>}
              </Card>
            );
          })}
        </>
      )}

      {tab==="statistics"&&<StatisticsPanel divisions={divisions} registrations={registrations} matches={matches} courts={courts}/>}

      {tab==="results"&&<ResultsPanel tournament={tournament} divisions={divisions} registrations={registrations} canEdit={canEdit} notify={notify}/>}

      {tab==="sync"&&<SyncCenterPanel matches={matches} registrations={registrations} currentUser={currentUser} notify={notify}/>}

      {showDivisionEditor&&<DivisionEditorModal onSave={createDivision} onClose={()=>setShowDivisionEditor(false)}/>}
      {selectedDivision&&<DivisionDetailPanel division={selectedDivision} directory={directory} accountsDirectory={accountsDirectory} courts={courts}
        canEdit={canEdit} currentUser={currentUser} onStartMatch={(m,div,regs)=>onStartMatch(m,div,regs,tournament)} notify={notify} onClose={()=>setSelectedDivisionId(null)}/>}
      {umpirePickerMatch&&<UmpirePickerModal match={umpirePickerMatch} accountsDirectory={accountsDirectory}
        onAssign={(umpireId,umpireName)=>assignUmpire(umpirePickerMatch,umpireId,umpireName)}
        onClose={()=>setUmpirePickerMatch(null)}/>}
      {confirmDeleteTournament&&(
        <ConfirmDialog title={"Delete "+tournament.name+"?"}
          message="This removes all its divisions, registrations, and matches."
          confirmLabel="Delete Tournament" destructive
          onConfirm={()=>{setConfirmDeleteTournament(false);onDelete(tournament.id);}}
          onCancel={()=>setConfirmDeleteTournament(false)}/>
      )}
      {confirmDeleteDivision&&(
        <ConfirmDialog title={"Delete "+confirmDeleteDivision.name+"?"}
          message="This removes its registrations and matches."
          confirmLabel="Delete Division" destructive
          onConfirm={()=>{const d=confirmDeleteDivision;setConfirmDeleteDivision(null);deleteDivision(d);}}
          onCancel={()=>setConfirmDeleteDivision(null)}/>
      )}
      {confirmFinishTournament&&(
        <ConfirmDialog title={"Finish "+tournament.name+"?"} message="It will move to Archive." confirmLabel="Finish Tournament" destructive
          onConfirm={()=>{setConfirmFinishTournament(false);finishTournament();}}
          onCancel={()=>setConfirmFinishTournament(false)}/>
      )}
    </Panel>
  );
}
