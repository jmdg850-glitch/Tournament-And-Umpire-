import { Avatar } from "../../components/ui/Avatar.jsx";
import { Panel } from "../../components/ui/Panel.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { RatingHistorySpark } from "../../components/ui/RatingHistorySpark.jsx";
import { buildStandings, getRankingPosition, ratingStatsFor } from "../../lib/standings.js";
import { fmtDate } from "../../lib/utils.js";
import { D } from "../../theme/tokens.js";


// ================================================================
// PLAYER PROFILE PANEL
// ================================================================
export function PlayerProfilePanel({player,doneMatches,players,friends,currentUser,onFriendReq,onClose}){
  const MY_ID=currentUser?.id;
  const pMatches=doneMatches.filter(m=>[...(m.teamA||[]),...(m.teamB||[])].includes(player.id));
  const wins=pMatches.filter(m=>(m.winner==="A"&&m.teamA?.includes(player.id))||(m.winner==="B"&&m.teamB?.includes(player.id))).length;
  const fr=friends.find(f=>(f.from===MY_ID&&f.to===player.id)||(f.from===player.id&&f.to===MY_ID));
  const stats=ratingStatsFor(player,"singles");
  const rank=getRankingPosition(player.id, buildStandings(players, doneMatches, "singles"));
  return(
    <Panel title="Player Profile" onClose={onClose}>
        <Card padding="20px" style={{marginBottom:14,textAlign:"center"}}>
          <div style={{display:"flex",justifyContent:"center",marginBottom:12}}><Avatar name={player.name} photo={player.photo} size={72} color={D.accent}/></div>
          <div style={{fontWeight:900,fontSize:19,color:D.textPrimary,marginBottom:2}}>{player.name}</div>
          <div style={{fontSize:12,color:D.textSecondary,marginBottom:12}}>{player.email||"No email"}</div>
          {!fr&&<button onClick={()=>onFriendReq(MY_ID,player.id)} style={{padding:"9px 22px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:22,color:D.accent,fontWeight:700,fontSize:13,cursor:"pointer"}}>+ Add Friend</button>}
          {fr?.status==="accepted"&&<span style={{fontSize:12,fontWeight:700,color:D.green,background:D.greenBg,borderRadius:22,padding:"6px 14px"}}>Friends</span>}
        </Card>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
          {[{l:"Singles",v:(+player.singlesRating||3).toFixed(3),c:D.accent},{l:"Doubles",v:(+player.doublesRating||3).toFixed(3),c:D.blue},
            {l:"Wins",v:wins,c:D.green},{l:"Losses",v:pMatches.length-wins,c:D.red},
            {l:"Confidence",v:stats.confidence+"%",c:D.purple},{l:"Rank",v:"#"+(rank||"—"),c:D.blue},
            {l:"Highest",v:stats.highest.toFixed(3),c:D.green},{l:"Lowest",v:stats.lowest.toFixed(3),c:D.red}].map(s=>(
            <Card key={s.l} padding="13px" style={{textAlign:"center"}}>
              <div style={{fontSize:20,fontWeight:900,color:s.c}}>{s.v}</div>
              <div style={{fontSize:10,color:D.textMuted,fontWeight:600,marginTop:3}}>{s.l.toUpperCase()}</div>
            </Card>
          ))}
        </div>
        {(player.ratingHistory||[]).filter(h=>h.type==="singles").length>=2&&(
          <Card padding="13px" style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
            <RatingHistorySpark history={player.ratingHistory} type="singles" color={D.accent}/>
            <div style={{fontSize:11,color:D.textMuted,fontWeight:700}}>
              Singles rating trend · {stats.trend==="up"?"📈 Trending up":stats.trend==="down"?"📉 Trending down":"➡️ Stable"}
            </div>
          </Card>
        )}
        {pMatches.slice(0,5).map(m=>{
          const won=(m.winner==="A"&&m.teamA?.includes(player.id))||(m.winner==="B"&&m.teamB?.includes(player.id));
          const ws=m.winner==="A"?(m.finalScoreA||m.scoreA):(m.finalScoreB||m.scoreB);
          const ls=m.winner==="A"?(m.finalScoreB||m.scoreB):(m.finalScoreA||m.scoreA);
          return(
            <Card key={m.id} padding="11px 14px" style={{marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:10,fontWeight:700,color:won?D.green:D.red,background:won?D.greenBg:D.redBg,borderRadius:20,padding:"3px 8px",flexShrink:0}}>{won?"WIN":"LOSS"}</span>
              <div style={{flex:1,fontSize:12,color:D.textSecondary}}>{m.isDoubles?"Doubles":"Singles"} · {fmtDate(m.date)}</div>
              <div style={{fontWeight:700,color:D.textPrimary,flexShrink:0}}>{ws}–{ls}</div>
            </Card>
          );
        })}
    </Panel>
  );
}
