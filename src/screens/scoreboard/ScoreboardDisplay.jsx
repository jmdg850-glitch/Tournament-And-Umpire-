import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SCOREBOARD_PALETTES } from "./scoreboardPalettes.js";
import { D } from "../../theme/tokens.js";

// One shared 1s tick powering both the elapsed-time clock and the timeout
// banner's self-expiry below — a single interval per mounted scoreboard
// instead of each computing its own "now" (which would call the impure
// Date.now() during render).
function useNow(intervalMs=1000){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    const t=setInterval(()=>setNow(Date.now()),intervalMs);
    return ()=>clearInterval(t);
  },[intervalMs]);
  return now;
}

// "Since match start" clock, formatted mm:ss (h:mm:ss past an hour).
// Deliberately runs continuously (doesn't pause with the match) — simplest,
// most honest "elapsed since start" reading.
function useElapsed(startedAt,now){
  if(!startedAt) return null;
  const secs=Math.max(0,Math.floor((now-new Date(startedAt).getTime())/1000));
  const h=Math.floor(secs/3600), m=Math.floor((secs%3600)/60), s=secs%60;
  const pad=n=>String(n).padStart(2,"0");
  return h>0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Pure presentational TV/projector scoreboard. Tournament header only renders
// when the live match carries tournament context (see App.jsx's
// startTournamentMatch/pushLive) — absent for every casual match, so this
// looks like a plain scoreboard until a tournament match is actually live.
export function ScoreboardDisplay({match:m,theme="dark"}){
  const palette=SCOREBOARD_PALETTES[theme]||SCOREBOARD_PALETTES.dark;
  const done=m.status==="completed";
  const paused=m.status==="paused";
  const teamAServing=m.servingTeam==="A";
  const teamBServing=m.servingTeam==="B";
  const now=useNow(1000);
  const elapsed=useElapsed(m.matchStartedAt,now);
  const timeoutsAllowed=m.timeoutsAllowed||2;
  const teams=[
    {label:m.teamALabel||"Team A",score:m.scoreA,serving:teamAServing,color:D.teamA,won:done&&m.winner==="A",
      country:m.teamACountry,club:m.teamAClub,timeouts:m.timeoutsA||0},
    {label:m.teamBLabel||"Team B",score:m.scoreB,serving:teamBServing,color:D.teamB,won:done&&m.winner==="B",
      country:m.teamBCountry,club:m.teamBClub,timeouts:m.timeoutsB||0},
  ];
  const winnerTeam=done?teams.find(t=>t.won):null;
  // Self-hides even if the organizer never explicitly dismisses it, using the
  // same shared tick as the elapsed clock above (no extra interval).
  const showTimeoutBanner=!done&&m.timeoutTeam&&(!m.timeoutCalledAt||(now-new Date(m.timeoutCalledAt).getTime())<60000);
  const timeoutTeamLabel=m.timeoutTeam==="A"?teams[0].label:teams[1].label;

  return(
    <div style={{height:"100%",display:"flex",flexDirection:"column",padding:"64px 40px 40px",boxSizing:"border-box",background:palette.bg,color:palette.text}}>
      {m.tournamentName&&(
        <div style={{display:"flex",alignItems:"center",gap:16,justifyContent:"center",marginBottom:22}}>
          {m.tournamentLogo&&<img src={m.tournamentLogo} alt="" style={{width:48,height:48,borderRadius:10,objectFit:"cover"}}/>}
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:22,fontWeight:900,letterSpacing:"0.5px"}}>{m.tournamentName}</div>
            {(m.divisionName||m.tournamentRound)&&(
              <div style={{fontSize:13,opacity:0.65,fontWeight:600}}>
                {[m.divisionName,m.tournamentRound?("Round "+m.tournamentRound):null].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
        </div>
      )}

      {done&&winnerTeam&&(
        <div style={{textAlign:"center",fontSize:18,fontWeight:900,letterSpacing:"0.5px",color:winnerTeam.color,marginBottom:14}}>
          🏆 {winnerTeam.label} WINS
        </div>
      )}

      {showTimeoutBanner&&(
        <div style={{textAlign:"center",fontSize:16,fontWeight:900,letterSpacing:"0.5px",color:"#F5B94A",marginBottom:14}}>
          ⏱ TIMEOUT — {timeoutTeamLabel}
        </div>
      )}

      <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:14,marginBottom:10}}>
        <span style={{fontSize:14,fontWeight:800,letterSpacing:"1px",opacity:0.7}}>{(m.courtName||"COURT").toUpperCase()}</span>
        {done?(
          <span style={{fontSize:13,fontWeight:800,color:palette.textMuted,letterSpacing:"1px"}}>FINAL</span>
        ):!paused?(
          <span style={{display:"flex",alignItems:"center",gap:6}}>
            <span style={{width:9,height:9,borderRadius:5,background:"#EF4444",display:"inline-block",animation:"pulse 1s infinite"}}/>
            <span style={{fontSize:13,fontWeight:800,color:"#EF4444",letterSpacing:"1px"}}>LIVE</span>
          </span>
        ):(
          <span style={{fontSize:13,fontWeight:800,color:"#F5B94A",letterSpacing:"1px"}}>PAUSED</span>
        )}
        {m.category&&<span style={{fontSize:12,fontWeight:700,padding:"2px 10px",borderRadius:20,background:palette.chipBg}}>{m.category}</span>}
        {elapsed&&<span style={{fontSize:12,fontWeight:700,padding:"2px 10px",borderRadius:20,background:palette.chipBg,fontVariantNumeric:"tabular-nums"}}>⏱ {elapsed}</span>}
      </div>

      <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:"6vw"}}>
        {teams.map((team,i)=>(
          <div key={i} style={{flex:1,maxWidth:440,textAlign:"center",opacity:done&&!team.won?0.5:1}}>
            <div style={{fontSize:"clamp(16px,2vw,24px)",fontWeight:800,marginBottom:6,
              color:team.serving?team.color:palette.textFaint,
              overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {team.serving&&!done&&<span style={{marginRight:8}}>●</span>}{team.label}
            </div>
            {(team.country||team.club)&&(
              <div style={{fontSize:12,opacity:0.5,marginBottom:10,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                {[team.country,team.club].filter(Boolean).join(" · ")}
              </div>
            )}
            <AnimatePresence mode="popLayout">
              <motion.div key={team.score}
                initial={{opacity:0,y:-18,scale:0.9}} animate={{opacity:1,y:0,scale:1}} exit={{opacity:0,y:18}}
                transition={{duration:0.25,ease:[0.2,0,0,1]}}
                style={{fontSize:"clamp(90px,14vw,220px)",fontWeight:900,lineHeight:1,fontVariantNumeric:"tabular-nums",
                  color:team.serving&&!done?theme==="dark"?"#fff":"#000":palette.textFaint}}>
                {team.score}
              </motion.div>
            </AnimatePresence>
            <div style={{display:"flex",justifyContent:"center",gap:6,marginTop:10}}>
              {Array.from({length:timeoutsAllowed}).map((_,i)=>(
                <span key={i} style={{width:9,height:9,borderRadius:5,border:"1.5px solid "+(i<team.timeouts?team.color:palette.pip),
                  background:i<team.timeouts?team.color:"transparent"}}/>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={{display:"flex",justifyContent:"center",gap:22,marginTop:24,flexWrap:"wrap"}}>
        {m.bestOf>1&&(
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <span style={{fontSize:12,opacity:0.6,fontWeight:700,letterSpacing:"0.5px"}}>GAME {m.gameNumber||1} OF {m.bestOf}</span>
            <span style={{fontSize:12,fontWeight:800}}>{m.gamesWonA||0}–{m.gamesWonB||0}</span>
          </div>
        )}
        <span style={{fontSize:12,opacity:0.5,fontWeight:700,letterSpacing:"0.5px"}}>PLAY TO {m.winTo}</span>
        <span style={{fontSize:12,opacity:0.5,fontWeight:700,letterSpacing:"0.5px"}}>{m.isDoubles?"DOUBLES":"SINGLES"}</span>
      </div>
    </div>
  );
}
