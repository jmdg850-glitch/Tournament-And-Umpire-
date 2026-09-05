import { useState, useRef, useEffect } from "react";
import { Panel } from "../components/ui/Panel.jsx";
import { FilterChipGroup } from "../components/ui/FilterChip.jsx";
import { Avatar } from "../components/ui/Avatar.jsx";
import { Input } from "../components/ui/Input.jsx";
import { Card } from "../components/ui/Card.jsx";
import { parseFile, parseFilePath } from "../lib/xlsxImport.js";
import { uid } from "../lib/utils.js";
import { D } from "../theme/tokens.js";
import { Cloud } from "../lib/cloud.js";

const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

// Small inline "search or type a name" field — same directory-search shape as
// MatchOrganizerPicker, but also accepts a free-text name for guest/walk-in
// entrants who have no account (mirrors mixmatch_players' "manual" source).
// DUPR badge label — uses the DUPR Player ID when it's directly available (a roster row's
// own mixmatch_players.dupr_id, already fetched for this organizer's own directory), and
// falls back to a plain "linked, no ID shown" badge when linkage is only known via the
// account-level boolean lookup (accounts_dupr_status RPC deliberately exposes only that one
// boolean for OTHER players' accounts, not their dupr_id/dupr_full_name — see migration
// 124_accounts_dupr_link_status_rpc.sql's comment; showing an ID we don't actually have would
// mean widening that intentionally-narrow exposure, not just a display tweak).
function duprBadgeLabel(duprId){ return duprId ? ("DUPR · ID "+duprId) : "DUPR"; }

function PlayerPicker({label,directory,value,onChange,duprStatus={}}){
  const [q,setQ]=useState("");
  const results=q.trim()? (directory||[]).filter(d=>(d.name||"").toLowerCase().includes(q.toLowerCase())).slice(0,8) : [];
  const valueHasDupr=value&&(!!value.duprId || (value.linkedUserId && !!duprStatus[value.linkedUserId]));
  return(
    <div style={{marginBottom:10}}>
      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:6}}>{label}</div>
      {value ? (
        <Card padding="8px 10px" style={{display:"flex",alignItems:"center",gap:10}}>
          <Avatar name={value.name} size={26} color={D.accent}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontSize:13,fontWeight:600,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{value.name}</div>
            <div style={{fontSize:10,fontWeight:700,color:valueHasDupr?D.green:D.textMuted,marginTop:2}}>
              {valueHasDupr?("🟢 "+duprBadgeLabel(value.duprId)):"⚪ DUPR Not Linked"}
            </div>
          </div>
          <button onClick={()=>onChange(null)} style={{background:"none",border:"none",color:D.textMuted,cursor:"pointer",fontSize:16}}>×</button>
        </Card>
      ) : (
        <>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search or type a name…"
            style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"9px 12px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box"}}/>
          {results.length>0&&(
            <Card padding={0} style={{marginTop:6,overflow:"hidden"}}>
              {results.map(d=>{
                const hasDupr=!!d.duprId || (d.linkedUserId && !!duprStatus[d.linkedUserId]);
                return (
                  <button key={d.id} onClick={()=>{onChange({id:d.id,name:d.name,linked:!!d.linkedUserId,duprId:d.duprId||null,linkedUserId:d.linkedUserId||null});setQ("");}}
                    style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",width:"100%",background:"none",border:"none",borderTop:"1px solid "+D.border,textAlign:"left",cursor:"pointer",font:"inherit",color:"inherit"}}>
                    <Avatar name={d.name} photo={d.photo} size={24} color={D.accent}/>
                    <span style={{fontSize:13,color:D.textPrimary,flex:1}}>{d.name}</span>
                    {hasDupr&&<span style={{fontSize:9,fontWeight:700,color:D.green,background:D.greenBg,borderRadius:8,padding:"1px 6px",flexShrink:0}}>{duprBadgeLabel(d.duprId)}</span>}
                  </button>
                );
              })}
            </Card>
          )}
          {q.trim()&&<button onClick={()=>{onChange({id:"guest_"+uid(),name:q.trim(),linked:false});setQ("");}}
            style={{marginTop:6,width:"100%",textAlign:"left",padding:"7px 4px",background:"transparent",border:"none",color:D.accent,fontWeight:700,fontSize:12,cursor:"pointer"}}>
            + Add "{q.trim()}" as a new entrant
          </button>}
        </>
      )}
    </div>
  );
}

// Register players/teams into a division — manual entry (search existing accounts
// or type a walk-in name) and, for singles divisions, Excel/CSV import (reuses the
// same column-sniffing parseFile/parseFilePath as the Mix & Match roster import).
// Compact per-player detail row (gender/age/DUPR), shown once that player
// slot is filled. Accumulated into the id-keyed playerGenders/playerAges/
// playerDuprRatings maps in addManual() below, the same way playerNames
// already is — a doubles team's two players can have different values,
// unlike the team-level country/club fields above them.
function PlayerDetails({gender,onGender,age,onAge,dupr,onDupr}){
  const fieldStyle={background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"9px 8px",color:D.textPrimary,fontSize:12,outline:"none",boxSizing:"border-box"};
  return(
    <div style={{display:"flex",gap:8,marginBottom:10}}>
      <select value={gender} onChange={e=>onGender(e.target.value)} style={{...fieldStyle,flex:1}}>
        <option value="">Gender…</option>
        <option value="M">M</option>
        <option value="F">F</option>
        <option value="other">Other</option>
      </select>
      <input type="number" min="0" inputMode="numeric" placeholder="Age" value={age} onChange={e=>onAge(e.target.value.replace(/[^0-9]/g,""))}
        style={{...fieldStyle,width:64}}/>
      <input type="number" min="0" step="0.001" inputMode="decimal" placeholder="DUPR" value={dupr} onChange={e=>onDupr(e.target.value)}
        style={{...fieldStyle,width:72}}/>
    </div>
  );
}

export function RegistrationModal({division,directory=[],organizerId,tournamentId,existingRegistrations=[],onRegister,onClose}){
  const [mode,setMode]=useState("manual");
  const [playerA,setPlayerA]=useState(null);
  const [playerB,setPlayerB]=useState(null);
  const [country,setCountry]=useState("");
  const [club,setClub]=useState("");
  const [teamName,setTeamName]=useState("");
  const [seed,setSeed]=useState("");
  const [genderA,setGenderA]=useState(""); const [ageA,setAgeA]=useState(""); const [duprA,setDuprA]=useState("");
  const [genderB,setGenderB]=useState(""); const [ageB,setAgeB]=useState(""); const [duprB,setDuprB]=useState("");
  const [preview,setPreview]=useState(null);
  const [err,setErr]=useState("");
  const [drag,setDrag]=useState(false);
  const ref=useRef(null);
  const isDoubles=division?.isDoubles!==false;

  // Account-level DUPR link fallback for the PlayerPicker badge — mirrors
  // SyncCenterPanel's identical batch lookup, since a roster row's own dupr_id
  // can be empty even when the linked account itself is DUPR-linked.
  const [duprStatus,setDuprStatus]=useState({});
  useEffect(()=>{
    let alive=true;
    const accountIds=[...new Set((directory||[]).filter(d=>d.linkedUserId).map(d=>d.linkedUserId))];
    (accountIds.length?Cloud.fetchAccountsDuprLinkStatus(accountIds):Promise.resolve({})).then(m=>{ if(alive) setDuprStatus(m); });
    return ()=>{ alive=false; };
  },[directory]);

  // A doubles division can be submitted with just Player 1 — this "pending partner"
  // registration is what the Teams tab's Automatic/Random/Balanced/Manual pairing pool
  // draws from (DivisionDetailPanel merges two such registrations into one 2-player
  // registration once paired). Both players together still registers a complete team in
  // one step, exactly as before — this only adds the single-player path, never removes it.
  const canAddManual=!!playerA;

  const addManual=()=>{
    const players=[playerA, isDoubles?playerB:null].filter(Boolean);
    const playerIds=players.map(p=>p.id);
    const taken=new Set((existingRegistrations||[]).filter(r=>r.status!=="withdrawn").flatMap(r=>r.playerIds||[]));
    const dup=players.filter(p=>taken.has(p.id));
    if(dup.length){
      setErr(dup.map(p=>p.name).join(" and ")+" already registered in this division");
      return;
    }
    setErr("");
    const playerNames=Object.fromEntries(players.map(p=>[p.id,p.name]));
    const linkedAccountIds=players.filter(p=>p.linkedUserId).map(p=>p.id);
    const playerGenders={}, playerAges={}, playerDuprRatings={};
    if(genderA) playerGenders[playerA.id]=genderA;
    if(ageA) playerAges[playerA.id]=+ageA;
    if(duprA) playerDuprRatings[playerA.id]=+duprA;
    if(isDoubles&&playerB){
      if(genderB) playerGenders[playerB.id]=genderB;
      if(ageB) playerAges[playerB.id]=+ageB;
      if(duprB) playerDuprRatings[playerB.id]=+duprB;
    }
    onRegister([{
      id:"treg_"+uid(), tournamentId, divisionId:division.id, organizerId,
      playerIds, playerNames, linkedAccountIds, status:"registered", source:"manual",
      country:country.trim()||null, club:club.trim()||null,
      teamName:isDoubles&&playerB?(teamName.trim()||null):null, seed:seed?+seed:null,
      playerGenders, playerAges, playerDuprRatings,
    }]);
    setPlayerA(null); setPlayerB(null); setCountry(""); setClub(""); setTeamName(""); setSeed("");
    setGenderA(""); setAgeA(""); setDuprA(""); setGenderB(""); setAgeB(""); setDuprB("");
  };

  const handleFile=f=>{setErr("");setPreview(null);parseFile(f,res=>setPreview(res),e=>setErr(e),[]);};
  const browse=async()=>{
    if(!hasElectron){ref.current?.click();return;}
    const result=await window.electronAPI.openFileDialog({filters:[{name:"Excel/CSV",extensions:["xlsx","xls","csv"]}]});
    if(result.canceled||!result.filePaths?.[0])return;
    setErr("");setPreview(null);
    parseFilePath(result.filePaths[0],res=>setPreview(res),e=>setErr(e),[]);
  };
  const importAll=()=>{
    if(!preview?.players?.length)return;
    const taken=new Set((existingRegistrations||[]).filter(r=>r.status!=="withdrawn").flatMap(r=>r.playerIds||[]));
    const fresh=preview.players.filter(p=>!taken.has(p.id));
    const skipped=preview.players.length-fresh.length;
    if(!fresh.length){ setErr("Every imported player is already registered in this division"); return; }
    onRegister(fresh.map(p=>({
      id:"treg_"+uid(), tournamentId, divisionId:division.id, organizerId,
      playerIds:[p.id], playerNames:{[p.id]:p.name}, linkedAccountIds:[], status:"registered", source:"import",
    })));
    if(skipped) setErr(skipped+" already-registered player"+(skipped!==1?"s":"")+" skipped");
    setPreview(null);
  };

  return(
    <Panel title={"Register — "+(division?.name||"")} onClose={onClose}>
      {isDoubles
        ? <FilterChipGroup options={[{value:"manual",label:"Add Team"}]} value={mode} onChange={setMode}/>
        : <FilterChipGroup options={[{value:"manual",label:"Add Player"},{value:"import",label:"Import Excel/CSV"}]} value={mode} onChange={setMode}/>}
      <div style={{height:14}}/>
      {mode==="manual"&&(
        <>
          <PlayerPicker label={isDoubles?"PLAYER 1":"PLAYER"} directory={directory} value={playerA} onChange={setPlayerA} duprStatus={duprStatus}/>
          {playerA&&<PlayerDetails gender={genderA} onGender={setGenderA} age={ageA} onAge={setAgeA} dupr={duprA} onDupr={setDuprA}/>}
          {isDoubles&&<PlayerPicker label="PLAYER 2 (optional — pair later in Teams tab)" directory={directory} value={playerB} onChange={setPlayerB} duprStatus={duprStatus}/>}
          {isDoubles&&playerB&&<PlayerDetails gender={genderB} onGender={setGenderB} age={ageB} onAge={setAgeB} dupr={duprB} onDupr={setDuprB}/>}
          {isDoubles&&playerB&&<Input label="Team name (optional)" value={teamName} onChange={setTeamName} placeholder="e.g. The Dinkers"/>}
          <Input label="Seed (optional)" value={seed} onChange={v=>setSeed(v.replace(/[^0-9]/g,""))} type="number" placeholder="e.g. 1"/>
          <Input label="Country (optional)" value={country} onChange={setCountry} placeholder="e.g. Philippines"/>
          <Input label="Club (optional)" value={club} onChange={setClub} placeholder="e.g. Riverside PB Club"/>
          <button onClick={addManual} disabled={!canAddManual}
            style={{width:"100%",padding:12,background:canAddManual?D.accent:D.cardEl,border:"none",borderRadius:20,color:canAddManual?"#fff":D.textMuted,fontWeight:700,fontSize:13,cursor:canAddManual?"pointer":"default"}}>
            {isDoubles?(playerB?"Register Team":"Register Player (pair later)"):"Register Player"}
          </button>
          {err&&<div style={{background:D.redBg,border:"1px solid "+D.red,borderRadius:10,padding:"10px 12px",color:D.red,fontSize:12,marginTop:12,fontWeight:600}}>{err}</div>}
        </>
      )}
      {mode==="import"&&(
        <>
          <div onDrop={e=>{e.preventDefault();setDrag(false);handleFile(e.dataTransfer.files[0]);}}
            onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onClick={browse}
            style={{border:"2px dashed "+(drag?D.accent:D.border),borderRadius:16,padding:"30px 20px",textAlign:"center",cursor:"pointer",marginBottom:14,background:drag?D.accentBg:"transparent"}}>
            <div style={{fontSize:28,marginBottom:8}}>📂</div>
            <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>Drop Excel/CSV file here</div>
            <div style={{fontSize:12,color:D.textMuted}}>or tap to browse · one row per entrant</div>
            <input ref={ref} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(f)handleFile(f);}}/>
          </div>
          {err&&<div style={{background:D.redBg,border:"1px solid "+D.red,borderRadius:10,padding:"10px 12px",color:D.red,fontSize:12,marginBottom:12,fontWeight:600}}>{err}</div>}
          {preview&&(
            <>
              <div style={{fontSize:12,color:D.textSecondary,marginBottom:10}}>{preview.imported} entrant{preview.imported!==1?"s":""} ready to register{preview.skipped?(" · "+preview.skipped+" skipped"):""}</div>
              <button onClick={importAll} disabled={!preview.imported}
                style={{width:"100%",padding:12,background:preview.imported?D.accent:D.cardEl,border:"none",borderRadius:20,color:preview.imported?"#fff":D.textMuted,fontWeight:700,fontSize:13,cursor:preview.imported?"pointer":"default"}}>
                Register {preview.imported} Entrant{preview.imported!==1?"s":""}
              </button>
            </>
          )}
        </>
      )}
    </Panel>
  );
}
