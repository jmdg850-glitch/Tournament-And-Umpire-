import { useState } from "react";
import { Avatar } from "./ui/Avatar.jsx";
import { Card } from "./ui/Card.jsx";
import { D } from "../theme/tokens.js";


// ================================================================
// MATCH ORGANIZERS FIELD — additional co-organizers for a match, on top of (never replacing) the
// Owner above. Each added person gets identical control rights to the Owner (see the co-organizer
// branch in canControlMatch). Same directory-search/registered-accounts-only approach as
// MatchOrganizerPicker, but add/remove-list shaped instead of single-value. Also reused (as-is,
// via the `label` prop) for calendar-event co-organizers — see EventDetailPanel — since the
// shape (ids/names/onChange/directory/currentUser/excludeId) is identical for both.
// ================================================================
export function MatchOrganizersField({organizerIds=[],organizerNames={},onChange,directory=[],currentUser,excludeId,label="ORGANIZERS (OPTIONAL) · invited to co-organize this match, pending until they accept"}){
  const [adding,setAdding]=useState(false);
  const [q,setQ]=useState("");
  const results=(directory||[]).filter(d=>d.id!==currentUser?.id&&d.id!==excludeId&&!organizerIds.includes(d.id)&&
    (q.trim()===""||(d.name||"").toLowerCase().includes(q.toLowerCase())||(d.email||"").toLowerCase().includes(q.toLowerCase())));
  const addOrganizer=(id,name)=>{
    onChange([...organizerIds,id],{...organizerNames,[id]:name});
    setAdding(false); setQ("");
  };
  const removeOrganizer=(id)=>{
    const rest=Object.fromEntries(Object.entries(organizerNames).filter(([oid])=>oid!==id));
    onChange(organizerIds.filter(x=>x!==id),rest);
  };
  return(
    <div style={{marginBottom:14}}>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>{label}</div>
      {organizerIds.length>0&&(
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:8}}>
          {organizerIds.map(id=>(
            <div key={id} style={{display:"flex",alignItems:"center",gap:6,background:D.accentBg,border:"1px solid "+D.accent,borderRadius:20,padding:"5px 6px 5px 12px"}}>
              <span style={{fontSize:12,fontWeight:700,color:D.accent}}>{organizerNames[id]||"Organizer"}</span>
              <button onClick={()=>removeOrganizer(id)} style={{width:18,height:18,borderRadius:9,background:"transparent",border:"none",color:D.accent,cursor:"pointer",fontSize:13,lineHeight:1,display:"flex",alignItems:"center",justifyContent:"center"}}>×</button>
            </div>
          ))}
        </div>
      )}
      <button onClick={()=>setAdding(a=>!a)} style={{padding:"7px 13px",background:adding?D.accentBg:D.cardEl,border:"1px solid "+(adding?D.accent:D.border),borderRadius:18,color:adding?D.accent:D.textSecondary,fontWeight:700,fontSize:11.5,cursor:"pointer"}}>
        {adding?"Close":"+ Add Organizer"}
      </button>
      {adding&&(
        <Card padding={10} style={{marginTop:8}}>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search registered accounts by name or email…"
            style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"9px 12px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:8}}/>
          {results.length===0&&<div style={{fontSize:12,color:D.textMuted,padding:"6px 2px"}}>No registered accounts found.</div>}
          {results.slice(0,20).map((d,i)=>(
            <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 2px",borderTop:i?"1px solid "+D.border:"none"}}>
              <Avatar name={d.name} photo={d.photo} size={28} color={D.accent}/>
              <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:600,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
              <button onClick={()=>addOrganizer(d.id,d.name)} style={{padding:"6px 12px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>Add</button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
