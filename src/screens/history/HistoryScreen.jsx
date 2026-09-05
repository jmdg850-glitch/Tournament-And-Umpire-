import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { fmtDate, today } from "../../lib/utils.js";
import { D } from "../../theme/tokens.js";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { listVariants, itemVariants } from "../../theme/motion.js";
import { Dupr } from "../../lib/dupr.js";
import { ReportIssueModal } from "../../modals/ReportIssueModal.jsx";


const DUPR_BADGE={
  submitted:{label:"Submitted to DUPR ✓",color:D.green,bg:D.greenBg},
  submitting:{label:"Submitting to DUPR…",color:D.amber,bg:D.amberBg},
  pending:{label:"Submitting to DUPR…",color:D.amber,bg:D.amberBg},
  skipped:{label:"Missing DUPR ID",color:D.textMuted,bg:D.cardEl},
  failed:{label:"DUPR submission failed",color:D.red,bg:D.redBg},
};

// Submit-to-DUPR affordance for one completed match. `sub` is this match's row from
// dupr_match_submissions (undefined = never attempted, the default "Submit" state).
// Shows an optimistic "submitting" state immediately on tap — the Edge Function call is
// fast but async, and dupr_match_submissions.status only ever gets fetched fresh via the
// parent's refresh, never streamed, so without this the button would look inert for the
// ~1-2s round trip.
const DuprSubmitRow=({matchId,sub,onSubmit,onReport})=>{
  if(!sub){
    return(
      <button onClick={()=>onSubmit(matchId)} style={{marginTop:8,width:"100%",padding:"8px",background:"transparent",border:"1.5px dashed "+D.border,borderRadius:10,color:D.textSecondary,fontWeight:700,fontSize:11.5,cursor:"pointer"}}>🏓 Submit to DUPR</button>
    );
  }
  const meta=DUPR_BADGE[sub.status]||DUPR_BADGE.pending;
  return(
    <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:meta.bg,borderRadius:10}}>
      <span style={{flex:1,fontSize:11,fontWeight:700,color:meta.color}}>{meta.label}</span>
      {sub.status==="submitted"&&sub.matchCode&&<span style={{fontSize:9,color:meta.color,fontVariantNumeric:"tabular-nums"}}>#{sub.matchCode}</span>}
      {sub.status==="failed"&&<button onClick={()=>onSubmit(matchId)} style={{padding:"4px 10px",background:D.red,border:"none",borderRadius:14,color:"#fff",fontWeight:700,fontSize:10,cursor:"pointer"}}>Retry</button>}
      <button onClick={()=>onReport(matchId,sub.matchCode)} title="Report an issue"
        style={{padding:"4px 7px",background:"transparent",border:"1px solid "+meta.color,borderRadius:14,color:meta.color,fontWeight:700,fontSize:10,cursor:"pointer"}}>⚠</button>
    </div>
  );
};

export function HistoryScreen({matches,teamLabel,currentUser,categories=[],onSubmitDupr,notify}){
  const [filter,setFilter]=useState("all");
  const [scope,setScope]=useState("mine");
  const [catFilter,setCatFilter]=useState("all");
  const myId=currentUser?.id;
  const isMine=(m)=>[...(m.teamA||[]),...(m.teamB||[])].includes(myId)||m.organizerId===myId||(m.organizerIds||[]).includes(myId);
  const scoped=scope==="mine"?matches.filter(isMine):matches;
  const catScoped=catFilter==="all"?scoped:scoped.filter(m=>m.category===catFilter);
  const filtered=(filter==="all"?catScoped:catScoped.filter(m=>m.isDoubles===(filter==="doubles")))
    .slice().sort((a,b)=>String(b.date||"").localeCompare(String(a.date||"")));
  const labelA=(m)=>m.teamALabel||teamLabel(m.teamA);
  const labelB=(m)=>m.teamBLabel||teamLabel(m.teamB);
  // Collapsible grouping — purely a display grouping over the already-filtered/sorted list
  // above; no filter, sort, or data logic changes. Today starts expanded, the rest collapsed.
  const todayStr=today();
  const weekAgo=(()=>{const d=new Date();d.setDate(d.getDate()-7);return d.toISOString().split("T")[0];})();
  const monthAgo=(()=>{const d=new Date();d.setDate(d.getDate()-30);return d.toISOString().split("T")[0];})();
  const buckets=[
    {key:"today",label:"Today",matches:filtered.filter(m=>m.date===todayStr)},
    {key:"week",label:"This Week",matches:filtered.filter(m=>m.date!==todayStr&&String(m.date||"")>=weekAgo)},
    {key:"month",label:"This Month",matches:filtered.filter(m=>String(m.date||"")<weekAgo&&String(m.date||"")>=monthAgo)},
    {key:"older",label:"Older",matches:filtered.filter(m=>String(m.date||"")<monthAgo)},
  ].filter(b=>b.matches.length>0);
  const [openSections,setOpenSections]=useState(()=>new Set(["today"]));
  const [reportingMatch,setReportingMatch]=useState(null); // {matchId,matchCode}|null
  // DUPR submission status per match, keyed by match id — only fetched for the currently
  // visible (filtered) set, refreshed whenever that set's membership changes.
  const [duprStatuses,setDuprStatuses]=useState({});
  const visibleIds=filtered.map(m=>m.id).join(",");
  useEffect(()=>{
    let alive=true;
    const ids=visibleIds?visibleIds.split(","):[];
    Dupr.fetchSubmissionStatuses(ids).then(s=>{ if(alive) setDuprStatuses(s); });
    return ()=>{ alive=false; };
  },[visibleIds]);
  // Tapping Submit/Retry: show "submitting" immediately (the fetched-once effect above has
  // no way to know a submission just started), fire the real request, then poll a couple of
  // times for the Edge Function's write to land before settling on whatever it reports.
  const submitDupr=async(matchId)=>{
    setDuprStatuses(prev=>({...prev,[matchId]:{status:"submitting"}}));
    onSubmitDupr(matchId);
    for(const delay of [1200,1500,2000]){
      await new Promise(r=>setTimeout(r,delay));
      const s=await Dupr.fetchSubmissionStatuses([matchId]);
      if(s[matchId]&&s[matchId].status!=="submitting"&&s[matchId].status!=="pending"){
        setDuprStatuses(prev=>({...prev,[matchId]:s[matchId]}));
        return;
      }
    }
    const finalStatus=await Dupr.fetchSubmissionStatuses([matchId]);
    if(finalStatus[matchId]) setDuprStatuses(prev=>({...prev,[matchId]:finalStatus[matchId]}));
  };
  const toggleSection=(key)=>setOpenSections(prev=>{const n=new Set(prev);n.has(key)?n.delete(key):n.add(key);return n;});
  const HistoryCard=({m})=>{
    const wl=m.winner==="A"?labelA(m):labelB(m);
    const ll=m.winner==="A"?labelB(m):labelA(m);
    const ws=m.winner==="A"?(m.finalScoreA||m.scoreA):(m.finalScoreB||m.scoreB);
    const ls=m.winner==="A"?(m.finalScoreB||m.scoreB):(m.finalScoreA||m.scoreA);
    const delta=m.winner==="A"?m.ratingDeltaA:m.ratingDeltaB;
    return(
      <motion.div whileHover={{boxShadow:"var(--sh-2)"}} style={{background:D.surface,border:"1px solid "+D.border,borderRadius:14,padding:"14px",marginBottom:8,boxShadow:"var(--sh-1)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
              <span style={{fontSize:14,fontWeight:800,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🏆 {wl}</span>
            </div>
            <div style={{fontSize:11,color:D.textSecondary,marginBottom:4}}>def. {ll}</div>
            <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
              <span style={{fontSize:10,fontWeight:600,color:D.accent,background:D.accentBg,borderRadius:20,padding:"2px 8px"}}>{m.isDoubles?"Doubles":"Singles"}</span>
              <span style={{fontSize:10,color:D.textMuted}}>{m.courtName} · {fmtDate(m.date)}</span>
            </div>
          </div>
          <div style={{textAlign:"right",flexShrink:0,marginLeft:12}}>
            <div style={{fontSize:24,fontWeight:900,color:D.textPrimary,fontVariantNumeric:"tabular-nums"}}>{ws}<span style={{color:D.textMuted,fontWeight:300,fontSize:18,margin:"0 2px"}}>-</span>{ls}</div>
            {delta!=null&&<div style={{fontSize:10,color:delta>0?D.green:D.red,fontWeight:700,fontVariantNumeric:"tabular-nums"}}>{delta>0?"+":""}{delta?.toFixed(3)}</div>}
          </div>
        </div>
        {onSubmitDupr&&<DuprSubmitRow matchId={m.id} sub={duprStatuses[m.id]} onSubmit={submitDupr}
          onReport={(matchId,matchCode)=>setReportingMatch({matchId,matchCode})}/>}
      </motion.div>
    );
  };
  return(
    <div style={{background:D.bg,height:"100%",overflowY:"auto",padding:"14px 14px 80px"}}>
      <div style={{fontWeight:900,fontSize:20,color:D.textPrimary,marginBottom:14}}>Match History</div>
      <div style={{marginBottom:10}}>
        <FilterChipGroup options={[{value:"mine",label:"My Matches"},{value:"all",label:"Everyone"}]} value={scope} onChange={setScope}/>
      </div>
      <div style={{marginBottom:10}}>
        <FilterChipGroup options={[{value:"all",label:"All"},{value:"singles",label:"Singles"},{value:"doubles",label:"Doubles"}]} value={filter} onChange={setFilter}/>
      </div>
      {categories.length>0&&(
        <div style={{marginBottom:14}}>
          <FilterChipGroup
            options={[{value:"all",label:"All Categories"},...categories.map(c=>({value:c.id,label:c.name}))]}
            value={catFilter} onChange={setCatFilter}
            style={{flexWrap:"wrap",overflowX:"visible"}}
          />
        </div>
      )}
      {filtered.length===0&&<motion.div initial="hidden" animate="show" variants={itemVariants} style={{textAlign:"center",padding:"60px 20px"}}><div style={{fontSize:36,marginBottom:12}}>📋</div><div style={{color:D.textMuted}}>No results yet.</div></motion.div>}
      {buckets.map(b=>{
        const open=openSections.has(b.key);
        return(
          <div key={b.key} style={{marginBottom:6}}>
            <button onClick={()=>toggleSection(b.key)} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"10px 2px",background:"transparent",border:"none",cursor:"pointer",textAlign:"left"}}>
              <span style={{fontSize:11,color:D.textMuted,display:"inline-block",transition:"transform .18s ease",transform:open?"rotate(90deg)":"none"}}>▶</span>
              <span style={{fontWeight:800,fontSize:14,color:D.textPrimary,flex:1}}>{b.label}</span>
              <span style={{fontSize:11,fontWeight:700,color:D.textMuted,background:D.cardEl,borderRadius:20,padding:"2px 9px"}}>{b.matches.length}</span>
            </button>
            <AnimatePresence initial={false}>
              {open&&(
                <motion.div key="content" initial={{opacity:0,height:0}} animate={{opacity:1,height:"auto"}} exit={{opacity:0,height:0}} transition={{duration:0.2,ease:[0.2,0,0,1]}} style={{overflow:"hidden"}}>
                  <motion.div variants={listVariants} initial="hidden" animate="show" style={{marginBottom:6}}>
                    {b.matches.map(m=><motion.div key={m.id} variants={itemVariants}><HistoryCard m={m}/></motion.div>)}
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
      {reportingMatch&&(
        <ReportIssueModal matchId={reportingMatch.matchId} duprMatchCode={reportingMatch.matchCode}
          currentUser={currentUser} notify={notify} onClose={()=>setReportingMatch(null)}/>
      )}
    </div>
  );
}
