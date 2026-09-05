import { Card } from "./ui/Card.jsx";
import { D } from "../theme/tokens.js";

// ================================================================
// PERSONAL UMPIRE STATUS — mirrors MyLiveStatusCard.jsx exactly: rendered at the top of
// HomeScreen, tells a player without them searching through Tournaments that they've been
// assigned as umpire for a match, across ANY organizer's tournament. Renders nothing if the
// viewer has no actionable (not completed/cancelled) assignment. `umpireAssignments` is the
// same App.jsx-level fetch/subscribe state that also feeds reconcileOwnLiveMatches — no
// second subscription opened here.
// ================================================================
export function MyUmpireAssignmentsCard({currentUser,umpireAssignments=[],onOpen}){
  if(!currentUser) return null;
  const actionable=umpireAssignments.filter(m=>m.status!=="completed"&&m.status!=="cancelled");
  if(!actionable.length) return null;
  const live=actionable.find(m=>m.status==="in_progress");
  const next=live||actionable[0];
  const extra=actionable.length-1;

  return(
    <Card onClick={()=>onOpen?.(next.id)} padding="16px" style={{width:"calc(100% - 28px)",margin:"12px 14px 0",
      background:live?"linear-gradient(135deg,"+D.accent+","+D.accentHi+")":D.accentBg,
      border:live?"none":"1px solid "+D.accent,color:live?"#fff":undefined}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
        <span style={{width:8,height:8,borderRadius:4,background:live?"#fff":D.accent,display:"inline-block",animation:live?"pulse 1.2s infinite":"none"}}/>
        <span style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:live?"#fff":D.accent}}>{live?"UMPIRING NOW":"YOU'RE UMPIRING"}</span>
      </div>
      <div style={{fontSize:13,fontWeight:700,color:live?"#fff":D.textPrimary}}>Round {next.round}{next.status!=="in_progress"?" · Not started":""}</div>
      {extra>0&&<div style={{fontSize:12,marginTop:2,opacity:live?0.9:1,color:live?"#fff":D.textSecondary}}>+{extra} more assigned match{extra!==1?"es":""}</div>}
    </Card>
  );
}
