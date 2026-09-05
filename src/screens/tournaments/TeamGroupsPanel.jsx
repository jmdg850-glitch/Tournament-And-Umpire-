import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { D } from "../../theme/tokens.js";

// Local edit buffer so renaming doesn't enqueue an Outbox write on every
// keystroke — commits on blur/Enter only, unlike the per-keystroke seed-number
// input in DivisionDetailPanel.jsx (fine there since seeds are 1-2 digits;
// a team name is free text and re-rendering/writing per character is wasteful).
function TeamNameInput({team,onRename}){
  const [value,setValue]=useState(team.name);
  const commit=()=>{ const trimmed=value.trim(); if(trimmed&&trimmed!==team.name) onRename(team.id,{name:trimmed}); else setValue(team.name); };
  return(
    <input value={value} onChange={e=>setValue(e.target.value)} onBlur={commit}
      onKeyDown={e=>{ if(e.key==="Enter") e.target.blur(); }}
      style={{flex:1,background:"transparent",border:"none",color:D.textPrimary,fontSize:13,fontWeight:700,outline:"none"}}/>
  );
}

// Local pair-display-name helper — deliberately NOT named teamNameOf/teamName
// (those already mean "this pair's own display name" elsewhere, e.g.
// DivisionDetailPanel.jsx, registration.teamName). This file's "team" always
// means the Team Group grouping (tournament_teams), so its own display-name
// helper for a pair gets a distinct name to avoid that ambiguity.
const pairDisplayName = r => r.teamName || Object.values(r.playerNames||{}).join(" / ") || "Unnamed";

// Team Elimination's "Team Groups" tab: organizer creates persisted team
// groups (e.g. Team A/B/C/D) and assigns each registered pair to one. Purely
// presentational — parent (DivisionDetailPanel) owns all Cloud/Outbox writes,
// same convention TeamsPanel.jsx uses for its own (unrelated) pairing feature.
//
// "Bracket Group" (below, optional) is a DIFFERENT, higher-level concept than
// the Team Groups this file otherwise manages: a Team (one row above) already
// groups Pairs into an elimination competitor; a Bracket Group optionally
// groups those TEAMS (e.g. "Bracket A"/"Bracket B") so they play only within
// their own group until a group champion emerges — see tournamentTeamGroups.js.
// Stored as a free-text `bracketGroup` field directly on the same
// tournament_teams row (migration 137), not a parallel table.
export function TeamGroupsPanel({registrations,teamGroups,onCreateTeamGroup,onRenameTeamGroup,onDeleteTeamGroup,onAssignRegistrationToTeamGroup,onSetTeamBracketGroup}){
  const [newName,setNewName]=useState("");
  const [newBracketGroup,setNewBracketGroup]=useState("");
  const [pendingBracketGroups,setPendingBracketGroups]=useState([]); // locally-added candidate labels not yet assigned to any team
  const [confirmRemoveTeam,setConfirmRemoveTeam]=useState(null);

  const active=registrations.filter(r=>r.status!=="withdrawn");
  const assignOptions=[...teamGroups.map(t=>({value:t.id,label:t.name})),{value:"",label:"Unassigned"}];
  const teamCounts=teamGroups.map(t=>active.filter(r=>r.teamId===t.id).length).filter(c=>c>0);
  const unevenTeamSizes=new Set(teamCounts).size>1;

  const usedBracketGroups=[...new Set(teamGroups.map(t=>t.bracketGroup).filter(Boolean))];
  const bracketGroupOptions=[...new Set([...usedBracketGroups,...pendingBracketGroups])].sort()
    .map(label=>({value:label,label}));
  const bracketGroupCounts=bracketGroupOptions.map(o=>teamGroups.filter(t=>t.bracketGroup===o.value).length);
  const ungroupedTeamCount=teamGroups.filter(t=>!t.bracketGroup).length;
  const partialBracketGroupAssignment=usedBracketGroups.length>0&&ungroupedTeamCount>0&&usedBracketGroups.length<teamGroups.length;
  const tooSmallBracketGroups=bracketGroupOptions.filter((o,i)=>bracketGroupCounts[i]>0&&bracketGroupCounts[i]<2);

  const submitNew=()=>{
    const name=newName.trim();
    if(!name) return;
    onCreateTeamGroup(name);
    setNewName("");
  };

  const submitNewBracketGroup=()=>{
    const label=newBracketGroup.trim();
    if(!label||usedBracketGroups.includes(label)||pendingBracketGroups.includes(label)) return;
    setPendingBracketGroups(prev=>[...prev,label]);
    setNewBracketGroup("");
  };

  const removeTeam=id=>{
    const team=teamGroups.find(t=>t.id===id);
    const assignedCount=active.filter(r=>r.teamId===id).length;
    if(assignedCount>0){ setConfirmRemoveTeam({id,name:team?.name,assignedCount}); return; }
    onDeleteTeamGroup(id);
  };

  return(
    <>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} placeholder="New team name (e.g. Team A)"
          onKeyDown={e=>{ if(e.key==="Enter") submitNew(); }}
          style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"11px 13px",color:D.white,fontSize:13,outline:"none"}}/>
        <button onClick={submitNew} disabled={!newName.trim()}
          style={{padding:"0 16px",background:newName.trim()?D.accent:D.cardEl,border:"none",borderRadius:14,color:newName.trim()?"#fff":D.textMuted,fontWeight:700,fontSize:13,cursor:newName.trim()?"pointer":"default"}}>
          + Add
        </button>
      </div>

      {teamGroups.length===0&&<div style={{textAlign:"center",padding:"20px",color:D.textMuted,fontSize:13}}>No team groups yet — add one above, then assign pairs below.</div>}
      {teamGroups.map(t=>{
        const count=active.filter(r=>r.teamId===t.id).length;
        return(
          <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 4px",borderBottom:"1px solid "+D.border}}>
            <TeamNameInput team={t} onRename={onRenameTeamGroup}/>
            <span style={{fontSize:11,color:unevenTeamSizes&&count>0?(D.amber||D.red):D.textMuted,fontWeight:unevenTeamSizes&&count>0?700:400,flexShrink:0}}>{count} pair{count!==1?"s":""}</span>
            <button onClick={()=>removeTeam(t.id)}
              style={{padding:"4px 10px",background:D.redBg,border:"1px solid "+D.red,borderRadius:12,color:D.red,fontWeight:700,fontSize:10,cursor:"pointer",flexShrink:0}}>
              Delete
            </button>
          </div>
        );
      })}
      {unevenTeamSizes&&<div style={{fontSize:11,color:D.amber||D.red,marginTop:4,marginBottom:8}}>Teams must all have the same number of pairs before a bracket can be generated.</div>}

      {teamGroups.length>=2&&(
        <div style={{marginTop:18}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:4}}>BRACKET GROUPS (OPTIONAL)</div>
          <div style={{fontSize:11,color:D.textMuted,marginBottom:10}}>
            Assign Teams to a Bracket Group (e.g. Bracket A, Bracket B) so they play within their own group first — group champions then meet in the Final. Leave every team ungrouped for one combined bracket.
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12}}>
            <input value={newBracketGroup} onChange={e=>setNewBracketGroup(e.target.value)} placeholder="New bracket group (e.g. Bracket A)"
              onKeyDown={e=>{ if(e.key==="Enter") submitNewBracketGroup(); }}
              style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:9,padding:"11px 13px",color:D.white,fontSize:13,outline:"none"}}/>
            <button onClick={submitNewBracketGroup} disabled={!newBracketGroup.trim()}
              style={{padding:"0 16px",background:newBracketGroup.trim()?D.accent:D.cardEl,border:"none",borderRadius:14,color:newBracketGroup.trim()?"#fff":D.textMuted,fontWeight:700,fontSize:13,cursor:newBracketGroup.trim()?"pointer":"default"}}>
              + Add
            </button>
          </div>
          {teamGroups.map(t=>(
            <div key={t.id} style={{padding:"8px 4px",borderBottom:"1px solid "+D.border}}>
              <div style={{fontSize:12,fontWeight:700,color:D.textPrimary,marginBottom:6}}>{t.name}</div>
              <FilterChipGroup options={[...bracketGroupOptions,{value:"",label:"Ungrouped"}]} value={t.bracketGroup||""}
                onChange={v=>onSetTeamBracketGroup(t.id,v||null)}/>
            </div>
          ))}
          {partialBracketGroupAssignment&&<div style={{fontSize:11,color:D.amber||D.red,marginTop:8}}>{ungroupedTeamCount} team{ungroupedTeamCount!==1?"s":""} have no Bracket Group assigned. Assign every team to a group, or clear every team's group, before generating.</div>}
          {tooSmallBracketGroups.length>0&&<div style={{fontSize:11,color:D.amber||D.red,marginTop:8}}>{tooSmallBracketGroups.map(g=>`"${g.label}" needs at least 2 teams`).join("; ")}.</div>}
        </div>
      )}

      {teamGroups.length>0&&(
        <div style={{marginTop:18}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>ASSIGN PAIRS · {active.length}</div>
          {active.length===0&&<div style={{textAlign:"center",padding:"20px",color:D.textMuted,fontSize:13}}>No active registrations yet.</div>}
          {active.map(r=>(
            <div key={r.id} style={{padding:"9px 4px",borderBottom:"1px solid "+D.border}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                <Avatar name={Object.values(r.playerNames||{})[0]||"?"} size={26} color={D.accent}/>
                <div style={{fontSize:13,fontWeight:600,color:D.textPrimary}}>{pairDisplayName(r)}</div>
              </div>
              <FilterChipGroup options={assignOptions} value={r.teamId||""}
                onChange={v=>onAssignRegistrationToTeamGroup(r.id,v||null)}/>
            </div>
          ))}
        </div>
      )}
      {confirmRemoveTeam&&(
        <ConfirmDialog title={`Delete "${confirmRemoveTeam.name}"?`}
          message={confirmRemoveTeam.assignedCount+" pair"+(confirmRemoveTeam.assignedCount!==1?"s":"")+" will become unassigned."}
          confirmLabel="Delete Team" destructive
          onConfirm={()=>{const id=confirmRemoveTeam.id;setConfirmRemoveTeam(null);onDeleteTeamGroup(id);}}
          onCancel={()=>setConfirmRemoveTeam(null)}/>
      )}
    </>
  );
}
