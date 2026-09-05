import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { pairAutomatic, pairRandom, pairBalanced } from "../../lib/tournamentTeams.js";
import { D } from "../../theme/tokens.js";

const MODES=[{value:"manual",label:"Manual"},{value:"automatic",label:"Automatic"},{value:"random",label:"Random"},{value:"balanced",label:"Balanced"}];

// Doubles-division Teams tab: pairs up single-player ("pending partner") registrations
// into full 2-player teams. Manual mode is organizer-driven (pick two, commit); the other
// three modes call the pure functions in tournamentTeams.js to propose a full set of
// pairings, previewed before committing. Actually writing the pairing (merging two
// registrations into one) is owned by the parent via onPairTeams — this component never
// touches Cloud/Outbox directly, matching how BracketView/RoundRobinScheduleView work.
export function TeamsPanel({registrations,directory=[],onPairTeams,notify}){
  const [mode,setMode]=useState("manual");
  const [manualPick,setManualPick]=useState([]);
  const [preview,setPreview]=useState(null);

  const paired=registrations.filter(r=>(r.playerIds||[]).length>1&&r.status!=="withdrawn");
  const unpaired=registrations.filter(r=>(r.playerIds||[]).length===1&&r.status!=="withdrawn");
  const ratingOf=id=>{ const acct=directory.find(x=>x.id===id); return acct?(+acct.doublesRating||3):3; };
  const pool=unpaired.map(r=>({id:r.playerIds[0],rating:ratingOf(r.playerIds[0])}));
  const nameOf=id=>{ const r=unpaired.find(x=>x.playerIds[0]===id); return r?(Object.values(r.playerNames||{})[0]||"Player"):id; };

  const runGenerate=()=>{
    const fn=mode==="automatic"?pairAutomatic:mode==="random"?pairRandom:pairBalanced;
    const result=fn(pool);
    if(!result.teams.length){ notify?.("Not enough unpaired players to form a team","err"); return; }
    setPreview(result);
  };

  const commitPreview=()=>{
    if(!preview) return;
    onPairTeams(preview.teams.map(([aId,bId])=>({aId,bId})));
    setPreview(null);
  };

  const togglePick=id=>{
    setManualPick(prev=>prev.includes(id)?prev.filter(x=>x!==id):(prev.length<2?[...prev,id]:prev));
  };
  const commitManual=()=>{
    if(manualPick.length!==2) return;
    onPairTeams([{aId:manualPick[0],bId:manualPick[1]}]);
    setManualPick([]);
  };

  return(
    <>
      <div style={{marginBottom:14}}>
        <FilterChipGroup options={MODES} value={mode} onChange={v=>{setMode(v);setPreview(null);setManualPick([]);}}/>
      </div>

      {paired.length>0&&(
        <div style={{marginBottom:16}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>TEAMS FORMED · {paired.length}</div>
          {paired.map(r=>(
            <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 4px",borderBottom:"1px solid "+D.border}}>
              <Avatar name={Object.values(r.playerNames||{})[0]||"?"} size={26} color={D.accent}/>
              <div style={{fontSize:13,fontWeight:700,color:D.textPrimary}}>{r.teamName||Object.values(r.playerNames||{}).join(" / ")}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>UNPAIRED PLAYERS · {unpaired.length}</div>
      {unpaired.length===0&&<div style={{textAlign:"center",padding:"20px",color:D.textMuted,fontSize:13}}>Everyone is paired.</div>}
      {unpaired.map(r=>{
        const id=r.playerIds[0];
        const picked=manualPick.includes(id);
        return(
          <button key={r.id} onClick={()=>togglePick(id)} disabled={mode!=="manual"}
            style={{display:"flex",alignItems:"center",gap:10,padding:"8px 4px",width:"100%",background:picked?D.accentBg:"transparent",border:"none",borderBottom:"1px solid "+D.border,borderRadius:picked?8:0,
              textAlign:"left",font:"inherit",color:"inherit",cursor:mode==="manual"?"pointer":"default"}}>
            <Avatar name={Object.values(r.playerNames||{})[0]||"?"} size={26} color={D.accent}/>
            <div style={{fontSize:13,fontWeight:600,color:D.textPrimary,flex:1}}>{Object.values(r.playerNames||{})[0]}</div>
            {picked&&<span style={{fontSize:10,fontWeight:700,color:D.accent}}>SELECTED</span>}
          </button>
        );
      })}

      {mode==="manual"&&manualPick.length===2&&(
        <button onClick={commitManual}
          style={{width:"100%",padding:12,marginTop:12,background:D.accent,border:"none",borderRadius:20,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
          Pair {nameOf(manualPick[0])} + {nameOf(manualPick[1])}
        </button>
      )}

      {mode!=="manual"&&!preview&&unpaired.length>=2&&(
        <button onClick={runGenerate}
          style={{width:"100%",padding:12,marginTop:12,background:D.accentBg,border:"1px solid "+D.accent,borderRadius:20,color:D.accent,fontWeight:700,fontSize:13,cursor:"pointer"}}>
          Generate Teams
        </button>
      )}

      {preview&&(
        <div style={{marginTop:12}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>
            PREVIEW · {preview.teams.length} TEAM{preview.teams.length!==1?"S":""}
          </div>
          {preview.teams.map(([aId,bId],i)=>(
            <div key={i} style={{fontSize:13,color:D.textPrimary,padding:"6px 4px"}}>{nameOf(aId)} + {nameOf(bId)}</div>
          ))}
          {preview.leftovers.length>0&&<div style={{fontSize:11,color:D.textMuted,marginTop:6}}>Not paired: {preview.leftovers.map(nameOf).join(", ")}</div>}
          <div style={{display:"flex",gap:8,marginTop:10}}>
            <button onClick={()=>setPreview(null)}
              style={{flex:1,padding:11,background:D.cardEl,border:"1px solid "+D.border,borderRadius:20,color:D.textSecondary,fontWeight:700,fontSize:13,cursor:"pointer"}}>
              Discard
            </button>
            <button onClick={commitPreview}
              style={{flex:1,padding:11,background:D.accent,border:"none",borderRadius:20,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
              Confirm Teams
            </button>
          </div>
        </div>
      )}
    </>
  );
}
