import { useState, useEffect } from "react";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { Cloud } from "../../lib/cloud.js";
import { buildPlayerStatistics, buildCourtUsage, mostActivePlayer, buildDurationStats } from "../../lib/tournamentStatistics.js";
import { D } from "../../theme/tokens.js";

const fmtDuration=ms=>ms==null?"—":Math.round(ms/60000)+" min";

function Stat({label,value}){
  return(
    <Card padding="12px 6px" style={{textAlign:"center"}}>
      <div style={{fontSize:15,fontWeight:900,color:D.textPrimary}}>{value}</div>
      <div style={{fontSize:9,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginTop:2}}>{label.toUpperCase()}</div>
    </Card>
  );
}

// Tournament-wide (or filtered to one division) statistics — per tournament/division via
// the FilterChipGroup here, per player via the table below. Compute-on-read from data this
// panel's parent already fetches (matches/registrations/courts); only match-duration stats
// need a small extra read (Cloud.fetchMatchesByIds) since that's the only place a real
// start/completion timestamp pair exists for a match.
export function StatisticsPanel({divisions,registrations,matches,courts=[]}){
  const [divisionId,setDivisionId]=useState("all");
  const [durationStats,setDurationStats]=useState({longestMs:null,fastestMs:null,averageMs:null,count:0});

  const scopedMatches=divisionId==="all"?matches:matches.filter(m=>m.divisionId===divisionId);
  const scopedRegistrations=divisionId==="all"?registrations:registrations.filter(r=>r.divisionId===divisionId);
  const playerStats=buildPlayerStatistics(scopedMatches,scopedRegistrations);
  const courtUsage=buildCourtUsage(scopedMatches,courts);
  const topPlayer=mostActivePlayer(playerStats);
  const completedCount=scopedMatches.filter(m=>m.status==="completed").length;

  useEffect(()=>{
    let alive=true;
    (async()=>{
      const scoped=divisionId==="all"?matches:matches.filter(m=>m.divisionId===divisionId);
      const ids=scoped.filter(m=>m.status==="completed"&&m.completedMatchId).map(m=>m.completedMatchId);
      const rows=ids.length?await Cloud.fetchMatchesByIds(ids):[];
      if(alive) setDurationStats(buildDurationStats(rows));
    })();
    return ()=>{ alive=false; };
  },[divisionId,matches]);

  const divisionOptions=[{value:"all",label:"All Divisions"},...divisions.map(d=>({value:d.id,label:d.name}))];

  return(
    <div>
      <div style={{marginBottom:16}}><FilterChipGroup options={divisionOptions} value={divisionId} onChange={setDivisionId}/></div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:16}}>
        <Stat label="Matches Played" value={completedCount}/>
        <Stat label="Avg Match Time" value={fmtDuration(durationStats.averageMs)}/>
        <Stat label="Longest Match" value={fmtDuration(durationStats.longestMs)}/>
      </div>

      {topPlayer&&(
        <Card padding="12px 14px" style={{marginBottom:16}}>
          <div style={{fontSize:10,color:D.textMuted,fontWeight:700,letterSpacing:"0.5px",marginBottom:4}}>MOST ACTIVE PLAYER</div>
          <div style={{fontSize:14,fontWeight:800,color:D.textPrimary}}>{topPlayer.name} · {topPlayer.matchesPlayed} matches</div>
        </Card>
      )}

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>PLAYER STATISTICS</div>
      {playerStats.length===0&&<div style={{textAlign:"center",padding:"20px",color:D.textMuted,fontSize:13}}>No completed matches yet.</div>}
      {playerStats.length>0&&(
        <div style={{overflowX:"auto",marginBottom:16}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
            <thead>
              <tr style={{borderBottom:"1px solid "+D.border}}>
                {["Player","MP","W","L","Win%","Pts For","Pts Allowed","Diff"].map((h,i)=>(
                  <th key={h} style={{textAlign:i>0?"center":"left",padding:"8px 6px",color:D.textMuted,fontWeight:700,fontSize:10,letterSpacing:"0.5px",whiteSpace:"nowrap"}}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {playerStats.map(p=>(
                <tr key={p.playerId} style={{borderBottom:"1px solid "+D.border}}>
                  <td style={{padding:"9px 6px",fontWeight:700,color:D.textPrimary}}>{p.name}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.textSecondary}}>{p.matchesPlayed}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.green,fontWeight:700}}>{p.wins}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.red,fontWeight:700}}>{p.losses}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.textSecondary}}>{p.winRate}%</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.textSecondary}}>{p.pointsFor}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:D.textSecondary}}>{p.pointsAgainst}</td>
                  <td style={{padding:"9px 6px",textAlign:"center",color:p.pointDiff>=0?D.green:D.red,fontWeight:700}}>{p.pointDiff>=0?"+":""}{p.pointDiff}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"0.5px",marginBottom:8}}>COURT USAGE</div>
      {courtUsage.length===0&&<div style={{textAlign:"center",padding:"12px",color:D.textMuted,fontSize:12}}>No courts used yet.</div>}
      {courtUsage.map(c=>(
        <div key={c.courtId} style={{display:"flex",justifyContent:"space-between",padding:"6px 4px",fontSize:12,color:D.textSecondary}}>
          <span>{c.courtName}</span><span>{c.matchesPlayed} matches</span>
        </div>
      ))}
    </div>
  );
}
