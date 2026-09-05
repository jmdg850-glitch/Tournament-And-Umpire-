import { D } from "../../theme/tokens.js";

// Individual-pair qualification ranking for team_elimination's elimination stage —
// same table shape/convention as TeamStandingsPanel.jsx, one level down: rows are
// PAIRS (from both teams combined, no team quota), not Teams. `rankedPairs`:
// output of rankIndividualPairsForSemifinals (already ranked/tie-broken per the
// spec's exact chain: Wins -> Losses -> Point Differential -> Points For ->
// deterministic). `registrations`: for pair name lookup. `teamGroups`: for the
// team-of-origin display column (informational only — it never affects seeding).
// `qualifiedIds`: a Set of registrationIds that actually qualify under the
// division's configured mode (Top 4 Overall / Top X Per Team / Manual) — never
// just "rank<=4", since qualification is no longer always exactly the top 4.
export function IndividualQualificationStandingsPanel({rankedPairs,registrations,teamGroups,qualifiedIds}){
  const pairName=id=>{ const r=registrations.find(x=>x.id===id); return r ? (Object.values(r.playerNames||{}).join(" / ")||"Unnamed") : "—"; };
  const teamName=id=>{ const t=teamGroups.find(x=>x.id===id); return t?t.name:"—"; };
  if(!rankedPairs.length) return <div style={{textAlign:"center",padding:"30px 20px",color:D.textMuted,fontSize:13}}>No completed matches yet.</div>;
  return(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead>
          <tr style={{borderBottom:"1px solid "+D.border}}>
            {["#","Pair","Team","W","L","PF","PA","Diff"].map((h,i)=>(
              <th key={h} style={{textAlign:i>=3?"center":"left",padding:"8px 6px",color:D.textMuted,fontWeight:700,fontSize:10,letterSpacing:"0.5px",whiteSpace:"nowrap"}}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rankedPairs.map(r=>{
            const qualified=qualifiedIds?.has(r.registrationId);
            return(
            <tr key={r.registrationId} style={{borderBottom:"1px solid "+D.border,background:qualified?D.accentBg:"transparent"}}>
              <td style={{padding:"9px 6px",fontWeight:800,color:qualified?D.accent:D.textMuted}}>{r.rank}{qualified?" ✓":""}</td>
              <td style={{padding:"9px 6px",fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:160}}>{pairName(r.registrationId)}</td>
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
  );
}
