import { useState, useEffect } from "react";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { Cloud } from "../../lib/cloud.js";
import { Outbox } from "../../lib/outbox.js";
import { uid } from "../../lib/utils.js";
import { D } from "../../theme/tokens.js";

const AWARD_TYPES=[
  {value:"champion",label:"Champion"},{value:"runner_up_1",label:"Runner-up"},{value:"runner_up_2",label:"2nd Runner-up"},
  {value:"mvp",label:"MVP"},{value:"best_sportsmanship",label:"Best Sportsmanship"},
];
const AWARD_LABEL=Object.fromEntries(AWARD_TYPES.map(a=>[a.value,a.label]));
const DIVISION_SCOPED=new Set(["champion","runner_up_1","runner_up_2"]);

const regLabel=r=>r.teamName||Object.values(r.playerNames||{}).join(" / ")||"Unnamed";

// Champion/Runner-up/2nd Runner-up (per division) and MVP/Best Sportsmanship
// (tournament-wide). Champion/runner-up awards fan out one row per player on the winning
// registration (not one row per team) when saved, so tournament_results.player_id is
// always populated regardless of singles/doubles — see migration 123 and
// Cloud.fetchAccountTournamentHistory, which relies on that being true.
export function ResultsPanel({tournament,divisions,registrations,canEdit,notify}){
  const [results,setResults]=useState([]);
  const [awardType,setAwardType]=useState("champion");
  const [divisionId,setDivisionId]=useState(divisions[0]?.id||"");
  const [registrationId,setRegistrationId]=useState("");
  const [playerName,setPlayerName]=useState("");
  const [notes,setNotes]=useState("");

  useEffect(()=>{
    let alive=true;
    Cloud.fetchTournamentResults(tournament.id).then(rows=>{
      if(alive) setResults(prev=>{
        const ids=new Set(rows.map(r=>r.id));
        const localOnly=prev.filter(r=>!ids.has(r.id));
        return [...rows,...localOnly];
      });
    });
    let channel=null;
    Cloud.subscribeTournamentResults(tournament.id,(mapped,eventType)=>{
      setResults(prev=>{
        if(eventType==="DELETE") return prev.filter(r=>r.id!==mapped.id);
        const exists=prev.some(r=>r.id===mapped.id);
        return exists ? prev.map(r=>r.id===mapped.id?mapped:r) : [...prev,mapped];
      });
    }).then(c=>{ if(alive) channel=c; else if(c) Cloud.removeChannel(c); });
    return ()=>{ alive=false; if(channel) Cloud.removeChannel(channel); };
  },[tournament.id]);

  const divisionScoped=DIVISION_SCOPED.has(awardType);
  const divisionRegistrations=registrations.filter(r=>r.divisionId===divisionId&&r.status!=="withdrawn");

  const saveResult=()=>{
    if(divisionScoped){
      const reg=divisionRegistrations.find(r=>r.id===registrationId);
      if(!reg){ notify?.("Pick a team/player","err"); return; }
      const playerIds=Object.keys(reg.playerNames||{});
      const rows=(playerIds.length?playerIds:[null]).map(pid=>({
        id:"tres_"+uid(), tournamentId:tournament.id, divisionId, organizerId:tournament.ownerId,
        awardType, registrationId:reg.id, playerId:pid, playerName:pid?reg.playerNames[pid]:regLabel(reg), notes:notes.trim()||null,
      }));
      rows.forEach(r=>Outbox.enqueue("upsertTournamentResult",{result:r}));
      setResults(prev=>[...prev,...rows]);
    } else {
      if(!playerName.trim()){ notify?.("Enter a player name","err"); return; }
      const row={id:"tres_"+uid(), tournamentId:tournament.id, divisionId:null, organizerId:tournament.ownerId,
        awardType, registrationId:null, playerId:null, playerName:playerName.trim(), notes:notes.trim()||null};
      Outbox.enqueue("upsertTournamentResult",{result:row});
      setResults(prev=>[...prev,row]);
    }
    Outbox.drain();
    setRegistrationId(""); setPlayerName(""); setNotes("");
    notify?.("Result saved");
  };

  const deleteResult=id=>{
    Cloud.deleteTournamentResult(id);
    setResults(prev=>prev.filter(r=>r.id!==id));
  };

  // Group champion/runner-up rows back into one card per registration (they're stored one
  // row per player) — dedupe by registrationId+awardType for display.
  const divisionAwards=[];
  const seen=new Set();
  results.filter(r=>r.divisionId).forEach(r=>{
    const key=r.registrationId+"|"+r.awardType;
    if(seen.has(key)) return;
    seen.add(key);
    const names=results.filter(x=>x.registrationId===r.registrationId&&x.awardType===r.awardType).map(x=>x.playerName).join(" / ");
    divisionAwards.push({...r,displayName:names||r.playerName});
  });
  const tournamentAwards=results.filter(r=>!r.divisionId);

  return(
    <div>
      {canEdit&&(
        <Card padding="14px" style={{marginBottom:16}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>ADD RESULT</div>
          <div style={{marginBottom:10}}><FilterChipGroup options={AWARD_TYPES} value={awardType} onChange={setAwardType}/></div>
          {divisionScoped?(
            <>
              <div style={{marginBottom:10}}>
                <FilterChipGroup options={divisions.map(d=>({value:d.id,label:d.name}))} value={divisionId} onChange={v=>{setDivisionId(v);setRegistrationId("");}}/>
              </div>
              <select value={registrationId} onChange={e=>setRegistrationId(e.target.value)}
                style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"9px 12px",color:D.textPrimary,fontSize:13,marginBottom:10,boxSizing:"border-box"}}>
                <option value="">Select team/player…</option>
                {divisionRegistrations.map(r=><option key={r.id} value={r.id}>{regLabel(r)}</option>)}
              </select>
            </>
          ):(
            <input value={playerName} onChange={e=>setPlayerName(e.target.value)} placeholder="Player name"
              style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"9px 12px",color:D.textPrimary,fontSize:13,marginBottom:10,outline:"none",boxSizing:"border-box"}}/>
          )}
          <input value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Notes (optional)"
            style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"9px 12px",color:D.textPrimary,fontSize:13,marginBottom:10,outline:"none",boxSizing:"border-box"}}/>
          <button onClick={saveResult}
            style={{width:"100%",padding:11,background:D.accent,border:"none",borderRadius:20,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
            Save Result
          </button>
        </Card>
      )}

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>DIVISION AWARDS</div>
      {divisionAwards.length===0&&<div style={{textAlign:"center",padding:"16px",color:D.textMuted,fontSize:12,marginBottom:16}}>No division awards yet.</div>}
      {divisionAwards.map(r=>{
        const div=divisions.find(d=>d.id===r.divisionId);
        return(
          <Card key={r.registrationId+r.awardType} padding="11px 13px" style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:700,color:D.textPrimary}}>{r.displayName}</div>
              <div style={{fontSize:10,color:D.textMuted}}>{AWARD_LABEL[r.awardType]}{div?" · "+div.name:""}</div>
            </div>
            {canEdit&&<button onClick={()=>results.filter(x=>x.registrationId===r.registrationId&&x.awardType===r.awardType).forEach(x=>deleteResult(x.id))}
              style={{padding:"4px 9px",background:D.redBg,border:"1px solid "+D.red,borderRadius:14,color:D.red,fontWeight:700,fontSize:10,cursor:"pointer"}}>Remove</button>}
          </Card>
        );
      })}

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8,marginTop:8}}>TOURNAMENT AWARDS</div>
      {tournamentAwards.length===0&&<div style={{textAlign:"center",padding:"16px",color:D.textMuted,fontSize:12}}>No tournament-wide awards yet.</div>}
      {tournamentAwards.map(r=>(
        <Card key={r.id} padding="11px 13px" style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:700,color:D.textPrimary}}>{r.playerName}</div>
            <div style={{fontSize:10,color:D.textMuted}}>{AWARD_LABEL[r.awardType]}</div>
          </div>
          {canEdit&&<button onClick={()=>deleteResult(r.id)}
            style={{padding:"4px 9px",background:D.redBg,border:"1px solid "+D.red,borderRadius:14,color:D.red,fontWeight:700,fontSize:10,cursor:"pointer"}}>Remove</button>}
        </Card>
      ))}
    </div>
  );
}
