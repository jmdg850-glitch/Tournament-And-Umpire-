import { useState } from "react";
import { Modal } from "../../components/ui/Modal.jsx";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { D } from "../../theme/tokens.js";

// Organizer-side umpire assignment: search REGISTERED accounts only (no free-text/guest
// fallback — a guest has no account to grant match-control permissions to), single-select,
// no default-to-me (unlike MatchOrganizerPicker, an umpire is a distinct role from the
// organizer and should never silently default to whoever opened the picker).
export function UmpirePickerModal({match,accountsDirectory=[],onAssign,onClose}){
  const [q,setQ]=useState("");
  const query=q.trim().toLowerCase();
  const results=accountsDirectory.filter(d=>
    query===""||(d.name||"").toLowerCase().includes(query)||(d.email||"").toLowerCase().includes(query));

  return(
    <Modal title="Assign Umpire" onClose={onClose} width={400}>
      {match?.umpireName&&(
        <div style={{display:"flex",alignItems:"center",gap:10,background:D.accentBg,border:"1px solid "+D.accent,borderRadius:12,padding:"9px 12px",marginBottom:12}}>
          <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:700,color:D.accent,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            Currently: {match.umpireName}
          </div>
          <button onClick={()=>{onAssign(null,null);onClose();}}
            style={{padding:"6px 12px",background:"transparent",border:"1px solid "+D.accent,borderRadius:16,color:D.accent,fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>
            Remove
          </button>
        </div>
      )}
      <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search registered accounts by name or email…" autoFocus
        style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"9px 12px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:10}}/>
      <div style={{maxHeight:320,overflowY:"auto"}}>
        {results.length===0&&<div style={{fontSize:12,color:D.textMuted,padding:"10px 2px",textAlign:"center"}}>No registered accounts found.</div>}
        {results.slice(0,30).map((d,i)=>(
          <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 2px",borderTop:i?"1px solid "+D.border:"none"}}>
            <Avatar name={d.name} photo={d.photo} size={30} color={D.accent}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
              {d.email&&<div style={{fontSize:11,color:D.textMuted,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.email}</div>}
            </div>
            <button onClick={()=>{onAssign(d.id,d.name);onClose();}}
              style={{padding:"6px 12px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>
              Assign
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
