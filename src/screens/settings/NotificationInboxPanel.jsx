import { Panel } from "../../components/ui/Panel.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { D } from "../../theme/tokens.js";


// Persistent notification inbox — separate from NotifPanel above (which is just the
// category on/off settings screen). Backed by the `notifications` Supabase table; items stay
// until explicitly opened (read:true), matching the "persists until opened" requirement.
export function NotificationInboxPanel({notifications=[],onMarkRead,onOpenEvent,onOpenUmpireMatch,onOpenMatch,onAcceptOrganizerInvite,onDeclineOrganizerInvite,onClose}){
  const sorted=[...notifications].sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  return(
    <Panel title="Notifications" onClose={onClose}>
      {sorted.length===0&&(
        <div style={{textAlign:"center",padding:"48px 20px"}}>
          <div style={{fontSize:44,marginBottom:10}}>🔔</div>
          <div style={{fontWeight:700,fontSize:15,color:D.textPrimary,marginBottom:4}}>Nothing yet</div>
          <div style={{fontSize:12,color:D.textMuted}}>Organizer invites and other updates will show up here.</div>
        </div>
      )}
      {sorted.map(n=>(
        <Card key={n.id} padding="13px 14px" style={{background:n.read?D.surface:D.accentBg,border:"1px solid "+(n.read?D.border:D.accent),marginBottom:10}}>
          <div style={{display:"flex",alignItems:"flex-start",gap:8}}>
            {!n.read&&<span style={{width:8,height:8,borderRadius:4,background:D.accent,marginTop:5,flexShrink:0}}/>}
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:800,color:D.textPrimary}}>🏓 {n.title}</div>
              {n.body&&<div style={{fontSize:12,color:D.textSecondary,marginTop:2}}>{n.body}</div>}
              {n.actorName&&<div style={{fontSize:11,color:D.textMuted,marginTop:4}}>Added by {n.actorName}</div>}
            </div>
          </div>
          {n.type==="match_organizer_invite"&&!n.read&&(
            <div style={{display:"flex",gap:8,marginTop:10}}>
              <button onClick={()=>onAcceptOrganizerInvite(n)} style={{flex:1,padding:"7px 14px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11.5,cursor:"pointer"}}>Accept</button>
              <button onClick={()=>onDeclineOrganizerInvite(n)} style={{flex:1,padding:"7px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:18,color:D.textSecondary,fontWeight:700,fontSize:11.5,cursor:"pointer"}}>Decline</button>
            </div>
          )}
          {n.eventId&&(
            <button onClick={()=>{onMarkRead(n.id);onOpenEvent(n.eventId);}} style={{marginTop:10,padding:"7px 14px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11.5,cursor:"pointer"}}>Open Event</button>
          )}
          {n.type==="umpire_assigned"&&n.matchId&&(
            <button onClick={()=>{onMarkRead(n.id);onOpenUmpireMatch(n.matchId);}} style={{marginTop:10,padding:"7px 14px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11.5,cursor:"pointer"}}>Open Match</button>
          )}
          {n.type==="match_assigned"&&n.matchId&&(
            <button onClick={()=>{onMarkRead(n.id);onOpenMatch(n.matchId);}} style={{marginTop:10,padding:"7px 14px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11.5,cursor:"pointer"}}>Open Match</button>
          )}
          {!n.eventId&&n.type!=="match_organizer_invite"&&n.type!=="umpire_assigned"&&n.type!=="match_assigned"&&!n.read&&(
            <button onClick={()=>onMarkRead(n.id)} style={{marginTop:10,padding:"7px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:18,color:D.textSecondary,fontWeight:700,fontSize:11.5,cursor:"pointer"}}>Mark read</button>
          )}
        </Card>
      ))}
    </Panel>
  );
}
