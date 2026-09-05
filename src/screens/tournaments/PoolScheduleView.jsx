import { assignPools, generatePoolSchedules, buildPoolStandings, selectAdvancers, generateKnockoutFromPools } from "../../lib/tournamentPoolPlay.js";
import { uid } from "../../lib/utils.js";
import { Card } from "../../components/ui/Card.jsx";
import { D, alpha } from "../../theme/tokens.js";

const nameFor=(registrations,id)=>{
  if(!id) return "TBD";
  const r=registrations.find(x=>x.id===id);
  return r ? Object.values(r.playerNames||{}).join(" / ")||"Unnamed" : "—";
};

const genId=()=>"tm_"+Math.random().toString(36).slice(2,10);

// Pool Play / Pool-to-Knockout's pool phase — once the knockout bracket is generated
// (pool_to_knockout only), DivisionDetailPanel switches its Schedule tab over to the
// existing BracketView component entirely (the knockout matches this view hands off to
// generateKnockoutFromPools are byte-for-byte the same shape single/double-elim already
// produce, so BracketView needs zero changes to render them).
export function PoolScheduleView({division,registrations,matches,pools,courts=[],onGeneratePools,onAssignCourt,onStartMatch,onGenerateKnockout,canEdit,onOpenUmpirePicker}){
  const activeRegistrations=registrations.filter(r=>r.status!=="withdrawn");
  const poolPhaseMatches=matches.filter(m=>m.poolId);

  if(!pools.length){
    const canGenerate=activeRegistrations.length>=2;
    return(
      <div style={{textAlign:"center",padding:"36px 20px"}}>
        <div style={{fontSize:32,marginBottom:10}}>🏊</div>
        <div style={{fontWeight:700,color:D.textPrimary,marginBottom:6}}>No pools yet</div>
        <div style={{fontSize:12,color:D.textMuted,marginBottom:16}}>
          {activeRegistrations.length} registered — splits into {division.poolCount||1} pool{(division.poolCount||1)!==1?"s":""} and schedules round-robin play within each.
        </div>
        <button onClick={()=>{
            const seeded=[...activeRegistrations].sort((a,b)=>(a.seed??999)-(b.seed??999));
            const generatedPools=assignPools(seeded,division.poolCount||1,i=>"pool_"+uid()+"_"+i);
            const rows=generatePoolSchedules(generatedPools,genId).map(m=>({
              ...m, tournamentId:division.tournamentId, divisionId:division.id, organizerId:division.organizerId,
            }));
            onGeneratePools(generatedPools,rows);
          }} disabled={!canGenerate}
          style={{padding:"12px 24px",background:canGenerate?D.accent:D.cardEl,border:"none",borderRadius:22,color:canGenerate?"#fff":D.textMuted,fontWeight:700,fontSize:13,cursor:canGenerate?"pointer":"default"}}>
          Generate Pools
        </button>
      </div>
    );
  }

  const allPoolMatchesComplete=poolPhaseMatches.length>0&&poolPhaseMatches.every(m=>m.status==="completed"||m.status==="bye"||m.status==="cancelled");
  const canGenerateKnockout=division.format==="pool_to_knockout"&&allPoolMatchesComplete;
  const poolMatchesDoneCount=poolPhaseMatches.filter(m=>m.status==="completed"||m.status==="bye"||m.status==="cancelled").length;

  return(
    <div>
      {division.format==="pool_to_knockout"&&!canGenerateKnockout&&poolPhaseMatches.length>0&&(
        <div style={{fontSize:11,color:D.textMuted,textAlign:"center",marginBottom:14}}>
          Knockout unlocks once all round-robin matches are complete — {poolMatchesDoneCount}/{poolPhaseMatches.length} done.
        </div>
      )}
      {canGenerateKnockout&&(
        <button onClick={()=>{
            const poolsWithRegs=pools.map(p=>({...p,registrations:registrations.filter(r=>r.poolId===p.id)}));
            const advancers=selectAdvancers(poolsWithRegs,matches,division.poolAdvanceCount||1);
            if(advancers.length<2) return;
            const genOpts=division.poolKnockoutFormat==="double_elimination"?{makeId:genId}:{makeId:genId,bronzeMatch:!!division.hasBronzeMatch};
            const rows=generateKnockoutFromPools(advancers,division.poolKnockoutFormat||"single_elimination",genOpts).map(m=>({
              ...m, tournamentId:division.tournamentId, divisionId:division.id, organizerId:division.organizerId,
            }));
            onGenerateKnockout(rows);
          }}
          style={{width:"100%",padding:12,background:D.accent,border:"none",borderRadius:20,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",marginBottom:16}}>
          Generate Knockout Bracket
        </button>
      )}
      {pools.map(pool=>{
        const poolRegs=registrations.filter(r=>r.poolId===pool.id);
        const poolMatches=poolPhaseMatches.filter(m=>m.poolId===pool.id);
        const standings=buildPoolStandings({...pool,registrations:poolRegs},matches);
        return(
          <div key={pool.id} style={{marginBottom:22}}>
            <div style={{fontSize:12,fontWeight:800,color:D.textPrimary,marginBottom:8}}>{pool.name}</div>
            {poolMatches.map(m=>{
              const statusColor=m.status==="completed"?D.green:m.status==="in_progress"?D.red:D.textMuted;
              return(
                <Card key={m.id} padding="11px 13px" style={{marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                    <span style={{fontSize:9,fontWeight:800,color:statusColor,background:alpha(statusColor,9),borderRadius:20,padding:"2px 8px",letterSpacing:"0.5px"}}>{m.status.replace("_"," ").toUpperCase()}</span>
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
            <div style={{fontSize:10,color:D.textMuted,marginTop:4}}>
              {standings.map((s,i)=>(i+1)+". "+nameFor(registrations,s.registrationId)+" ("+s.wins+"-"+s.losses+")").join(" · ")}
            </div>
          </div>
        );
      })}
    </div>
  );
}
