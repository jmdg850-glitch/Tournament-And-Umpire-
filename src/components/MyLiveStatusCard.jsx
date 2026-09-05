import { useLiveBoard } from "../lib/liveBoard.js";
import { Card } from "./ui/Card.jsx";
import { D } from "../theme/tokens.js";


// ================================================================
// PERSONAL LIVE STATUS — rendered at the top of HomeScreen. Tells a player, without them
// searching through the board, whether they're currently playing (and where/with whom/the
// score), waiting in a queue, or sitting out this round — across ANY organizer's session, not
// just their own. Renders nothing if the viewer isn't part of any live/waiting context.
// ================================================================
export function MyLiveStatusCard({currentUser,myIds=[],directory=[],players=[],onOpen}){
  const {matches,sessions}=useLiveBoard();
  if(!currentUser) return null;

  const resolveName=(id)=>{
    if(id===currentUser.id) return currentUser.name||"You";
    const p=(directory||[]).find(x=>x.id===id)||(players||[]).find(x=>x.id===id);
    return p?.name||"Player";
  };

  const myMatch=matches.find(m=>{
    if(m.status!=="in_progress"&&m.status!=="paused") return false;
    const idsToCheck=m.ownerId===currentUser.id?myIds:[currentUser.id];
    return idsToCheck.some(id=>(m.teamA||[]).includes(id)||(m.teamB||[]).includes(id));
  });

  if(myMatch){
    const idsToCheck=myMatch.ownerId===currentUser.id?myIds:[currentUser.id];
    const myId=idsToCheck.find(id=>(myMatch.teamA||[]).includes(id)||(myMatch.teamB||[]).includes(id));
    const onTeamA=(myMatch.teamA||[]).includes(myId);
    const partnerIds=(onTeamA?myMatch.teamA:myMatch.teamB).filter(id=>id!==myId);
    const oppIds=onTeamA?myMatch.teamB:myMatch.teamA;
    const nameForId=(id)=>myMatch.playerNames?.[id]||resolveName(id);
    const paused=myMatch.status==="paused";
    return(
      <Card onClick={onOpen} padding="16px" style={{width:"calc(100% - 28px)",margin:"12px 14px 0",
        background:"linear-gradient(135deg,"+D.accent+","+D.accentHi+")",border:"none",color:"#fff"}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
          <span style={{width:8,height:8,borderRadius:4,background:"#fff",display:"inline-block",animation:paused?"none":"pulse 1.2s infinite"}}/>
          <span style={{fontSize:11,fontWeight:800,letterSpacing:"1px"}}>{paused?"PAUSED":"YOU'RE PLAYING"}</span>
        </div>
        <div style={{fontSize:13,opacity:.95,marginBottom:4}}>{myMatch.courtName||"Court"}{partnerIds.length?(" · with "+partnerIds.map(nameForId).join(" & ")):""}</div>
        <div style={{fontSize:12,opacity:.9,marginBottom:12}}>vs {oppIds.map(nameForId).join(" & ")}</div>
        <div style={{display:"flex",alignItems:"center",gap:14,fontVariantNumeric:"tabular-nums"}}>
          <span style={{fontSize:30,fontWeight:900}}>{myMatch.scoreA}</span>
          <span style={{fontSize:14,opacity:.8}}>–</span>
          <span style={{fontSize:30,fontWeight:900}}>{myMatch.scoreB}</span>
        </div>
      </Card>
    );
  }

  for(const s of sessions){
    const qi=(s.queue||[]).findIndex(q=>(q.teamA||[]).includes(currentUser.id)||(q.teamB||[]).includes(currentUser.id));
    if(qi!==-1){
      return(
        <Card onClick={onOpen} padding="16px" style={{width:"calc(100% - 28px)",margin:"12px 14px 0",background:D.amberBg,border:"1px solid "+D.amber}}>
          <div style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.amber,marginBottom:6}}>WAITING</div>
          <div style={{fontSize:13,color:D.textPrimary,fontWeight:700}}>Next up in {s.eventName}</div>
          <div style={{fontSize:12,color:D.textSecondary,marginTop:2}}>Queue position #{qi+1}</div>
        </Card>
      );
    }
  }
  for(const s of sessions){
    if((s.sittingOut||[]).some(p=>p.id===currentUser.id)){
      return(
        <Card onClick={onOpen} padding="16px" style={{width:"calc(100% - 28px)",margin:"12px 14px 0",background:D.cardEl}}>
          <div style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.textMuted,marginBottom:6}}>WAITING</div>
          <div style={{fontSize:13,color:D.textPrimary,fontWeight:700}}>Sitting out this round in {s.eventName}</div>
          <div style={{fontSize:12,color:D.textSecondary,marginTop:2}}>You'll rotate into the next round.</div>
        </Card>
      );
    }
  }
  return null;
}
