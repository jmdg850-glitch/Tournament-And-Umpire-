import { useState } from "react";
import { Modal } from "../../components/ui/Modal.jsx";
import { D } from "../../theme/tokens.js";

// Manual qualification mode's participant picker — the one mode that never auto-generates
// on round-robin completion (App.jsx's advanceTournamentBracket branch), since only the
// organizer can decide who advances. Same ranked-pairs shape/columns as
// IndividualQualificationStandingsPanel.jsx, one column added (checkbox select). A pair can
// only ever be toggled once (checkbox, not a counter) — no duplicate-selection is possible
// by construction.
export function ManualQualifierPickerModal({rankedPairs,registrations,teamGroups,initialSelectedIds=[],onGenerate,onClose}){
  const [selected,setSelected]=useState(new Set(initialSelectedIds));
  const pairName=id=>{ const r=registrations.find(x=>x.id===id); return r ? (Object.values(r.playerNames||{}).join(" / ")||"Unnamed") : "—"; };
  const teamName=id=>{ const t=teamGroups.find(x=>x.id===id); return t?t.name:"—"; };
  const toggle=id=>setSelected(prev=>{
    const next=new Set(prev);
    if(next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return(
    <Modal title="Select Qualifying Pairs" onClose={onClose} width={480}>
      <div style={{fontSize:11,color:D.textMuted,marginBottom:10}}>
        Choose which individual pairs advance to the elimination bracket. At least 2 required.
      </div>
      <div style={{maxHeight:360,overflowY:"auto",marginBottom:12}}>
        {rankedPairs.length===0&&<div style={{textAlign:"center",padding:"20px 0",color:D.textMuted,fontSize:13}}>No completed matches yet.</div>}
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
          <thead>
            <tr style={{borderBottom:"1px solid "+D.border}}>
              {["","#","Pair","Team","W","L","PF","PA","Diff"].map((h,i)=>(
                <th key={h||i} style={{textAlign:i>=4?"center":"left",padding:"8px 6px",color:D.textMuted,fontWeight:700,fontSize:10,letterSpacing:"0.5px",whiteSpace:"nowrap"}}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rankedPairs.map(r=>{
              const isSelected=selected.has(r.registrationId);
              return(
                <tr key={r.registrationId} onClick={()=>toggle(r.registrationId)}
                  style={{borderBottom:"1px solid "+D.border,background:isSelected?D.accentBg:"transparent",cursor:"pointer"}}>
                  <td style={{padding:"9px 6px"}}>
                    <input type="checkbox" checked={isSelected} onChange={()=>toggle(r.registrationId)} onClick={e=>e.stopPropagation()}/>
                  </td>
                  <td style={{padding:"9px 6px",fontWeight:800,color:isSelected?D.accent:D.textMuted}}>{r.rank}</td>
                  <td style={{padding:"9px 6px",fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:140}}>{pairName(r.registrationId)}</td>
                  <td style={{padding:"9px 6px",color:D.textSecondary}}>{teamName(r.teamId)}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.green,fontWeight:700}}>{r.wins}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.red,fontWeight:700}}>{r.losses}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.textSecondary}}>{r.pointsFor}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.textSecondary}}>{r.pointsAgainst}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",fontWeight:700,color:r.pointDiff>0?D.green:r.pointDiff<0?D.red:D.textSecondary}}>{r.pointDiff>0?"+":""}{r.pointDiff}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button onClick={()=>selected.size>=2&&onGenerate([...selected])} disabled={selected.size<2}
        style={{width:"100%",padding:13,background:selected.size>=2?D.accent:D.cardEl,border:"none",borderRadius:22,
          color:selected.size>=2?"#fff":D.textMuted,fontWeight:700,fontSize:14,cursor:selected.size>=2?"pointer":"default"}}>
        Generate Bracket ({selected.size} selected)
      </button>
    </Modal>
  );
}
