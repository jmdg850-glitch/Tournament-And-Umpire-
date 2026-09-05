import { useState } from "react";
import { Avatar } from "./ui/Avatar.jsx";
import { Card } from "./ui/Card.jsx";
import { D } from "../theme/tokens.js";



// ================================================================
// MATCH ORGANIZER PICKER — every match belongs to one organizer (a registered account), used
// for permission gating (see canControlMatch near isValidMatchup). Defaults to the current
// logged-in user; reuses the same directory name/email search approach as MatchSetupModal's
// existing "Find Registered" tool, since only a real registered account can ever satisfy the
// ownership check in a later session.
// ================================================================
export function MatchOrganizerPicker({organizerId,organizerName,onChange,directory=[],currentUser}){
  const [searching,setSearching]=useState(false);
  const [q,setQ]=useState("");
  const isMe=!organizerId||organizerId===currentUser?.id;
  const results=(directory||[]).filter(d=>d.id!==currentUser?.id&&
    (q.trim()===""||(d.name||"").toLowerCase().includes(q.toLowerCase())||(d.email||"").toLowerCase().includes(q.toLowerCase())));
  const displayName=isMe?(currentUser?.name||"You"):(organizerName||"Organizer");
  return(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>OWNER</div>
      <Card padding="9px 12px" style={{display:"flex",alignItems:"center",gap:10}}>
        <div style={{width:32,height:32,borderRadius:16,background:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:D.accent,fontSize:12,flexShrink:0}}>
          {displayName.slice(0,2).toUpperCase()}
        </div>
        <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
          {displayName}{isMe?" (You)":""}
        </div>
        <button onClick={()=>setSearching(s=>!s)} style={{padding:"6px 12px",background:searching?D.accentBg:D.cardEl,border:"1px solid "+(searching?D.accent:D.border),borderRadius:18,color:searching?D.accent:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>
          {searching?"Close":"Change"}
        </button>
      </Card>
      {searching&&(
        <Card padding={10} style={{marginTop:8}}>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search registered accounts by name or email…"
            style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"9px 12px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:8}}/>
          {!isMe&&<button onClick={()=>{onChange(null,null);setSearching(false);setQ("");}} style={{width:"100%",textAlign:"left",padding:"7px 4px",background:"transparent",border:"none",color:D.accent,fontWeight:700,fontSize:12,cursor:"pointer"}}>Reset to me ({currentUser?.name})</button>}
          {results.length===0&&<div style={{fontSize:12,color:D.textMuted,padding:"6px 2px"}}>No registered accounts found.</div>}
          {results.slice(0,20).map((d,i)=>(
            <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 2px",borderTop:i?"1px solid "+D.border:"none"}}>
              <Avatar name={d.name} photo={d.photo} size={28} color={D.accent}/>
              <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:600,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
              <button onClick={()=>{onChange(d.id,d.name);setSearching(false);setQ("");}} style={{padding:"6px 12px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>Select</button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
