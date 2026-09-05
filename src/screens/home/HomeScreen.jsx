import { useRef, useState } from "react";
import { motion } from "framer-motion";
import { MyLiveStatusCard } from "../../components/MyLiveStatusCard.jsx";
import { MyUmpireAssignmentsCard } from "../../components/MyUmpireAssignmentsCard.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { today } from "../../lib/utils.js";
import { D } from "../../theme/tokens.js";
import { itemVariants, listVariants } from "../../theme/motion.js";

export function HomeScreen({players,liveMatches,doneMatches,liveStates,teamLabel,onNewMatch,onOpenMatch,setScreen,currentUser,directory,myIds=[],dismissedHomeIds,onDismissFromHome,umpireAssignments=[],onOpenUmpireAssignment}){
  const myMatches=doneMatches.filter(m=>[...(m.teamA||[]),...(m.teamB||[])].some(id=>myIds.includes(id)));
  const myWins=myMatches.filter(m=>(m.winner==="A"&&m.teamA?.some(id=>myIds.includes(id)))||(m.winner==="B"&&m.teamB?.some(id=>myIds.includes(id)))).length;
  const visibleDoneMatches=doneMatches.filter(m=>!dismissedHomeIds?.has(m.id) && m.date===today());
  const todaysLiveMatches=liveMatches.filter(m=>m.date===today());

  const TodayCard=({m})=>{
    const [dragX,setDragX]=useState(0);
    const [confirmDismiss,setConfirmDismiss]=useState(false);
    const dragging=useRef(false);
    const startX=useRef(0);
    const wl=m.winner==="A"?teamLabel(m.teamA):teamLabel(m.teamB);
    const ws=m.winner==="A"?(m.finalScoreA||m.scoreA):(m.finalScoreB||m.scoreB);
    const ls=m.winner==="A"?(m.finalScoreB||m.scoreB):(m.finalScoreA||m.scoreA);
    const doDismiss=()=>setConfirmDismiss(true);
    return(
      <>
      <div style={{position:"relative",marginBottom:8,overflow:"hidden",borderRadius:14}}>
        {onDismissFromHome&&(
          <div style={{position:"absolute",inset:0,display:"flex",justifyContent:"flex-end",alignItems:"stretch",background:D.red,borderRadius:14}}>
            <button onClick={doDismiss} style={{padding:"0 22px",background:"transparent",border:"none",color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer"}}>Delete</button>
          </div>
        )}
        <div
          onTouchStart={e=>{ if(!onDismissFromHome) return; dragging.current=true; startX.current=e.touches[0].clientX; e.stopPropagation(); }}
          onTouchMove={e=>{
            if(!onDismissFromHome||!dragging.current) return;
            const dx=e.touches[0].clientX-startX.current;
            if(dx<0) setDragX(Math.max(dx,-80));
            e.stopPropagation();
          }}
          onTouchEnd={e=>{
            if(!onDismissFromHome) return;
            dragging.current=false;
            setDragX(prev=>prev<-40?-80:0);
            e.stopPropagation();
          }}
          style={{background:D.surface,borderRadius:14,padding:"14px",boxShadow:"0 1px 4px rgba(0,0,0,.06)",border:"1px solid "+D.border,display:"flex",alignItems:"center",gap:12,transform:"translateX("+dragX+"px)",transition:dragging.current?"none":"transform .2s"}}>
          <div style={{width:36,height:36,borderRadius:10,background:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>T</div>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:700,fontSize:13,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{wl}</div>
            <div style={{fontSize:11,color:D.textSecondary}}>{m.courtName} · {m.isDoubles?"Doubles":"Singles"}</div>
          </div>
          <div style={{fontWeight:800,fontSize:16,color:D.textPrimary,flexShrink:0}}>{ws}–{ls}</div>
          {onDismissFromHome&&<button onClick={e=>{e.stopPropagation();doDismiss();}} style={{width:24,height:24,borderRadius:12,background:D.cardEl,border:"1px solid "+D.border,color:D.textMuted,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:13}}>×</button>}
        </div>
      </div>
      {confirmDismiss&&(
        <ConfirmDialog title="Remove from your Active list?" message="Your match history isn't affected." confirmLabel="Remove"
          onConfirm={()=>{setConfirmDismiss(false);onDismissFromHome&&onDismissFromHome(m.id);}}
          onCancel={()=>{setConfirmDismiss(false);setDragX(0);}}/>
      )}
      </>
    );
  };

  return(
    <div style={{background:D.bg,height:"100%",overflowY:"auto",paddingBottom:20}}>
      <MyLiveStatusCard currentUser={currentUser} myIds={myIds} directory={directory} players={players} onOpen={()=>setScreen("liveboard")}/>
      <MyUmpireAssignmentsCard currentUser={currentUser} umpireAssignments={umpireAssignments} onOpen={onOpenUmpireAssignment}/>

      {myWins>0&&(
        <div style={{margin:"12px 14px 0",background:D.surface,borderRadius:16,padding:"14px 16px",border:"1px solid "+D.border}}>
          <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,marginBottom:2}}>Match history</div>
          <div style={{fontSize:12,color:D.textSecondary}}>{myWins} win{myWins!==1?"s":""} · {myMatches.length} match{myMatches.length!==1?"es":""} played</div>
        </div>
      )}

      <div style={{margin:"14px 14px 0",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
        {[
          {label:"Tournaments",screen:"tournaments",primary:true},
          {label:"Live Matches",screen:"liveboard"},
          {label:"Courts",screen:"courts"},
          {label:"Players",screen:"players"},
          {label:"Settings",screen:"settings"},
        ].map(item=>(
          <button key={item.label} onClick={()=>setScreen(item.screen)} style={{
            background:item.primary?D.accent:D.cardEl,
            borderRadius:14,padding:"18px 10px 14px",border:"none",cursor:"pointer",
            display:"flex",flexDirection:"column",alignItems:"center",gap:8,
            color:item.primary?"#fff":D.textSecondary,
          }}>
            <span style={{fontSize:11,fontWeight:item.primary?700:600,color:item.primary?"#fff":D.textSecondary,textAlign:"center",lineHeight:1.2}}>{item.label}</span>
          </button>
        ))}
      </div>

      <motion.div variants={listVariants} initial="hidden" animate="show">
      {todaysLiveMatches.length>0&&todaysLiveMatches.map(m=>{
        const st=liveStates[m.id];
        return(
          <motion.div key={m.id} variants={itemVariants}>
          <button onClick={()=>onOpenMatch(m.id)} style={{margin:"10px 14px 0",width:"calc(100% - 28px)",background:D.surface,borderRadius:16,padding:"16px",border:"1px solid "+D.border,cursor:"pointer",textAlign:"left",display:"block"}}>
            <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,marginBottom:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{teamLabel(m.teamA)} vs {teamLabel(m.teamB)}</div>
            <div style={{fontSize:11,color:D.textSecondary,marginBottom:8}}>{m.courtName}</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:D.cardEl,borderRadius:10,padding:"10px 14px"}}>
              <div style={{fontSize:28,fontWeight:900,color:D.teamA,fontVariantNumeric:"tabular-nums"}}>{st?.scoreA??0}</div>
              <div style={{fontSize:12,color:D.textMuted,fontWeight:600}}>vs</div>
              <div style={{fontSize:28,fontWeight:900,color:D.teamB,fontVariantNumeric:"tabular-nums"}}>{st?.scoreB??0}</div>
            </div>
          </button>
          </motion.div>
        );
      })}

      {visibleDoneMatches.length>0&&(
        <div style={{margin:"16px 14px 0"}}>
          <div style={{fontWeight:800,fontSize:15,color:D.accent,marginBottom:10}}>Today</div>
          {visibleDoneMatches.slice(0,3).map(m=><motion.div key={m.id} variants={itemVariants}><TodayCard m={m}/></motion.div>)}
        </div>
      )}

      {todaysLiveMatches.length===0&&visibleDoneMatches.length===0&&(
        <motion.div variants={itemVariants} style={{textAlign:"center",padding:"48px 20px"}}>
          <div style={{fontWeight:800,fontSize:18,color:D.textPrimary,marginBottom:6}}>No live matches today</div>
          <div style={{fontSize:13,color:D.textSecondary,marginBottom:20}}>Open Tournaments to create a division, register players, and start scoring.</div>
          <button onClick={onNewMatch} style={{padding:"12px 28px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer"}}>Open Tournaments</button>
        </motion.div>
      )}
      </motion.div>
    </div>
  );
}
