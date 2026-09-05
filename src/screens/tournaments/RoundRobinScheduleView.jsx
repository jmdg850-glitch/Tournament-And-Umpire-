import { generateRoundRobinSchedule } from "../../lib/tournamentRoundRobin.js";
import { generateTop4PlayoffShell } from "../../lib/tournamentBracket.js";
import { uid } from "../../lib/utils.js";
import { Card } from "../../components/ui/Card.jsx";
import { D, alpha } from "../../theme/tokens.js";

const nameFor=(registrations,id)=>{
  if(!id) return "TBD";
  const r=registrations.find(x=>x.id===id);
  return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "—";
};

export function RoundRobinScheduleView({division,registrations,matches,courts=[],onGenerate,onStartMatch,onAssignCourt,onAutoAssignCourts,canEdit,onOpenUmpirePicker,eliminationRound}){
  if(!matches.length){
    // Withdrawn entrants must never be seeded into a freshly-generated schedule.
    const activeRegistrations=registrations.filter(r=>r.status!=="withdrawn");
    const canGenerate=activeRegistrations.length>=2;
    return(
      <div style={{textAlign:"center",padding:"36px 20px"}}>
        <div style={{fontSize:32,marginBottom:10}}>🔄</div>
        <div style={{fontWeight:700,color:D.textPrimary,marginBottom:6}}>No schedule yet</div>
        <div style={{fontSize:12,color:D.textMuted,marginBottom:16}}>{activeRegistrations.length} registered — generates a round where everyone plays everyone once.</div>
        <button onClick={()=>{
            const {rounds}=generateRoundRobinSchedule(activeRegistrations);
            const rows=rounds.flatMap(rnd=>rnd.matches.filter(m=>!m.isBye).map(m=>({
              id:"tm_"+uid(), tournamentId:division.tournamentId, divisionId:division.id, organizerId:division.organizerId,
              round:rnd.round, registrationAId:m.registrationAId, registrationBId:m.registrationBId, status:"pending",
            })));
            // Top 4 Playoffs: create the whole Semifinal/Final/Bronze shell (all TBD) in the
            // same action, immediately — never waits for the round robin to finish. Below 4
            // active registrations there's no possible top-4, so this is skipped entirely and
            // the division stays a plain terminal round robin, same as today.
            if(division.top4Playoffs&&activeRegistrations.length>=4){
              const shellRows=generateTop4PlayoffShell({makeId:()=>"tm_"+uid()}).map(m=>({
                ...m, tournamentId:division.tournamentId, divisionId:division.id, organizerId:division.organizerId,
              }));
              rows.push(...shellRows);
            }
            onGenerate(rows);
          }} disabled={!canGenerate}
          style={{padding:"12px 24px",background:canGenerate?D.accent:D.cardEl,border:"none",borderRadius:22,color:canGenerate?"#fff":D.textMuted,fontWeight:700,fontSize:13,cursor:canGenerate?"pointer":"default"}}>
          Generate Schedule
        </button>
      </div>
    );
  }

  const byRound=new Map();
  matches.forEach(m=>{ if(!byRound.has(m.round)) byRound.set(m.round,[]); byRound.get(m.round).push(m); });
  const rounds=[...byRound.keys()].sort((a,b)=>a-b);

  return(
    <div>
      {onAutoAssignCourts&&(
        <button onClick={onAutoAssignCourts}
          style={{width:"100%",padding:10,background:D.cardEl,border:"1px solid "+D.border,borderRadius:16,color:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer",marginBottom:16}}>
          Auto-assign courts
        </button>
      )}
      {rounds.map(rnd=>(
        <div key={rnd} style={{marginBottom:18}}>
          <div style={{fontSize:11,fontWeight:800,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>{eliminationRound?"ELIMINATION ROUND ":"ROUND "}{rnd}</div>
          {byRound.get(rnd).map(m=>{
            const statusColor=m.status==="completed"?D.green:m.status==="in_progress"?D.red:D.textMuted;
            return(
              <Card key={m.id} padding="11px 13px" style={{marginBottom:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <span style={{fontSize:9,fontWeight:800,color:statusColor,background:alpha(statusColor,9),borderRadius:20,padding:"2px 8px",letterSpacing:"0.5px"}}>{m.status.replace("_"," ").toUpperCase()}</span>
                  {m.status==="in_progress"&&<span style={{width:6,height:6,borderRadius:3,background:D.red,animation:"pulse 1s infinite"}}/>}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:13,marginBottom:8}}>
                  <span style={{fontWeight:700,color:m.winner==="A"?D.green:D.textPrimary,flex:1}}>{nameFor(registrations,m.registrationAId)}</span>
                  <span style={{fontSize:10,color:D.textMuted}}>vs</span>
                  <span style={{fontWeight:700,color:m.winner==="B"?D.green:D.textPrimary,flex:1,textAlign:"right"}}>{nameFor(registrations,m.registrationBId)}</span>
                </div>
                {m.status==="pending"&&(
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    <select value={m.courtId||""} onChange={e=>onAssignCourt(m.id,e.target.value||null)}
                      style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:8,padding:"7px 8px",color:D.textPrimary,fontSize:12}}>
                      <option value="">Assign court…</option>
                      {courts.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                    <button onClick={()=>onStartMatch(m)}
                      style={{padding:"7px 16px",background:D.accent,border:"none",borderRadius:16,color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>
                      Start Match
                    </button>
                  </div>
                )}
                {canEdit&&onOpenUmpirePicker&&m.status!=="completed"&&m.status!=="cancelled"&&m.status!=="bye"&&(
                  <button onClick={()=>onOpenUmpirePicker(m)}
                    style={{marginTop:8,padding:"5px 10px",background:m.umpireName?D.accentBg:D.cardEl,border:"1px solid "+(m.umpireName?D.accent:D.border),borderRadius:14,color:m.umpireName?D.accent:D.textSecondary,fontWeight:700,fontSize:10,cursor:"pointer"}}>
                    {m.umpireName?"🎽 "+m.umpireName:"+ Assign Umpire"}
                  </button>
                )}
              </Card>
            );
          })}
        </div>
      ))}
    </div>
  );
}
