import { motion } from "framer-motion";
import { useLiveBoard } from "../../lib/liveBoard.js";
import { fmtDate, nameOf, today } from "../../lib/utils.js";
import { Card } from "../../components/ui/Card.jsx";
import { D, alpha } from "../../theme/tokens.js";
import { itemVariants } from "../../theme/motion.js";



// ================================================================
// LIVE MATCH BOARD — read-only view for EVERY logged-in user (spectators/players). No editing
// controls of any kind live here; organizers keep managing matches exclusively through the
// existing CourtsScreen/ScoringScreen/MatchSetupModal, completely untouched by this screen.
// ================================================================
export function LiveBoardScreen({directory=[],categories=[]}){
  const catNameOf=(cid)=>categories.find(c=>c.id===cid)?.name||null;
  const {matches,sessions}=useLiveBoard();
  const liveOrPaused=matches.filter(m=>m.status==="in_progress"||m.status==="paused");

  const byOwner=new Map();
  liveOrPaused.forEach(m=>{
    const oid=m.ownerId||"unknown";
    if(!byOwner.has(oid)) byOwner.set(oid,{matches:[],session:null});
    byOwner.get(oid).matches.push(m);
  });
  sessions.forEach(s=>{
    if(!byOwner.has(s.organizerId)) byOwner.set(s.organizerId,{matches:[],session:s});
    else byOwner.get(s.organizerId).session=s;
  });
  const organizerIds=[...byOwner.keys()].filter(oid=>{
    const g=byOwner.get(oid);
    return g.matches.length>0 || (g.session && ((g.session.queue||[]).length>0 || (g.session.sittingOut||[]).length>0));
  });

  return(
    <div style={{background:D.bg,height:"100%",overflowY:"auto",padding:"14px 14px 80px"}}>
      <div style={{fontWeight:900,fontSize:20,color:D.textPrimary,marginBottom:4}}>Live Matches</div>
      <div style={{fontSize:12,color:D.textMuted,marginBottom:14}}>Updates automatically for everyone — no refresh needed.</div>
      {organizerIds.length===0&&(
        <motion.div initial="hidden" animate="show" variants={itemVariants} style={{textAlign:"center",padding:"60px 20px",background:D.surface,borderRadius:16,border:"1px solid "+D.border}}>
          <div style={{fontSize:44,marginBottom:12}}>🏓</div>
          <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>No live matches right now</div>
          <div style={{fontSize:12,color:D.textSecondary}}>When an organizer starts a match, it shows up here for everyone to watch.</div>
        </motion.div>
      )}
      {organizerIds.map(oid=>{
        const {matches:orgMatches,session}=byOwner.get(oid);
        const ownerName=orgMatches[0]?.ownerName||session?.organizerName||"Organizer";
        const eventName=session?.eventName||(ownerName+"'s Session");
        const courtIds=[...new Set(orgMatches.map(m=>m.courtId))];
        const queue=session?.queue||[];
        const sittingOut=session?.sittingOut||[];
        const playerNames={...(session?.playerNames||{}),...Object.fromEntries(orgMatches.flatMap(m=>Object.entries(m.playerNames||{})))};
        const nameForId=(id)=>playerNames[id]||nameOf(directory,id);
        const totalPlayers=new Set([
          ...orgMatches.flatMap(m=>[...(m.teamA||[]),...(m.teamB||[])]),
          ...queue.flatMap(q=>[...(q.teamA||[]),...(q.teamB||[])]),
          ...sittingOut.map(p=>p.id),
        ]).size;
        const anyLive=orgMatches.some(m=>m.status==="in_progress");
        const anyPaused=orgMatches.some(m=>m.status==="paused");
        const statusLabel=anyLive?"LIVE":anyPaused?"PAUSED":"WAITING";
        const statusColor=anyLive?D.red:anyPaused?D.amber:D.blue;
        return(
          <div key={oid} style={{marginBottom:22}}>
            <Card style={{marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                <span style={{fontSize:10,fontWeight:800,color:statusColor,background:alpha(statusColor,9),borderRadius:20,padding:"3px 10px",letterSpacing:"0.5px"}}>{statusLabel}</span>
                <span style={{fontSize:11,color:D.textMuted}}>{fmtDate(today())}</span>
              </div>
              <div style={{fontWeight:800,fontSize:16,color:D.textPrimary,marginBottom:2}}>{eventName}</div>
              <div style={{fontSize:12,color:D.textSecondary,marginBottom:8}}>Organizer: {ownerName}</div>
              <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
                <span style={{fontSize:11,color:D.textSecondary}}>🏟 {courtIds.length} court{courtIds.length!==1?"s":""}</span>
                <span style={{fontSize:11,color:D.textSecondary}}>🔄 Round {session?.round||1}</span>
                <span style={{fontSize:11,color:D.textSecondary}}>👥 {totalPlayers} players</span>
              </div>
            </Card>
            {courtIds.map(cid=>{
              const m=orgMatches.find(x=>x.courtId===cid);
              if(!m) return null;
              const paused=m.status==="paused";
              const catName=catNameOf(m.category);
              return(
                <Card key={cid} padding={0} style={{overflow:"hidden",marginBottom:10}}>
                  <div style={{padding:"9px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+D.border}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      {paused
                        ?<span style={{fontSize:11,fontWeight:700,color:D.textMuted,background:D.cardEl,borderRadius:20,padding:"3px 8px"}}>⏸ PAUSED</span>
                        :<div style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:4,background:D.red,display:"inline-block",animation:"pulse 1s infinite"}}/><span style={{fontSize:11,fontWeight:700,color:D.red}}>LIVE</span></div>}
                      <span style={{fontSize:11,fontWeight:700,color:D.textPrimary}}>{m.courtName||"Court"}</span>
                      {catName&&<span style={{fontSize:9,fontWeight:700,color:D.accent,background:D.accentBg,borderRadius:20,padding:"2px 8px"}}>{catName}</span>}
                      {m.tournamentName&&<span style={{fontSize:9,fontWeight:700,color:D.purple,background:D.purpleBg,borderRadius:20,padding:"2px 8px"}}>🏆 {m.tournamentName}{m.divisionName?" · "+m.divisionName:""}</span>}
                    </div>
                    <span style={{fontSize:10,color:D.textMuted}}>{m.isDoubles?"2v2":"1v1"} · to {m.winTo}</span>
                  </div>
                  <div style={{padding:"14px",background:D.cardEl,display:"flex",alignItems:"center",gap:8}}>
                    {[{s:m.scoreA,n:m.teamALabel||"Team A",serving:m.servingTeam==="A",col:D.teamA},{s:m.scoreB,n:m.teamBLabel||"Team B",serving:m.servingTeam==="B",col:D.teamB}].map((tm,i)=>(
                      <div key={i} style={{flex:1,textAlign:"center"}}>
                        <div style={{fontSize:9,fontWeight:700,color:tm.serving?tm.col:D.textMuted,marginBottom:4}}>{tm.serving?"SERVING":""}</div>
                        <div style={{fontSize:38,fontWeight:900,color:tm.serving?tm.col:D.textMuted,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{tm.s}</div>
                        <div style={{fontSize:10,color:D.textSecondary,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tm.n}</div>
                      </div>
                    ))}
                  </div>
                </Card>
              );
            })}
            {queue.length>0&&(
              <div style={{background:D.amberBg,border:"1px solid "+D.amber,borderRadius:14,padding:"12px 14px",marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.amber,marginBottom:8}}>⏭ WAITING MATCHES · {queue.length}</div>
                {queue.map((q,i)=>(
                  <div key={q.qid||i} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,padding:"5px 0",borderTop:i?"1px solid "+D.amber:"none"}}>
                    <span style={{fontSize:10,fontWeight:800,color:D.amber,minWidth:18}}>{i+1}</span>
                    <span style={{color:D.teamA,fontWeight:700}}>{(q.teamA||[]).map(nameForId).join(" & ")}</span>
                    <span style={{color:D.textMuted,fontSize:10}}>vs</span>
                    <span style={{color:D.teamB,fontWeight:700}}>{(q.teamB||[]).map(nameForId).join(" & ")}</span>
                  </div>
                ))}
              </div>
            )}
            {sittingOut.length>0&&(
              <div style={{background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,padding:"12px 14px"}}>
                <div style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.textMuted,marginBottom:8}}>⏳ WAITING PLAYERS · {sittingOut.length}</div>
                {sittingOut.map((p,i)=>(
                  <div key={p.id||i} style={{fontSize:12,color:D.textSecondary,padding:"3px 0"}}>#{i+1} {p.name||nameForId(p.id)}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
