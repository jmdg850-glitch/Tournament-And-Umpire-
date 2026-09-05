import { useState, useEffect } from "react";
import { canControlMatch } from "../../lib/mixmatch.js";
import { isAssignedUmpire } from "../../lib/umpire.js";
import { Outbox } from "../../lib/outbox.js";
import { nameOf } from "../../lib/utils.js";
import { Btn } from "../../components/ui/Btn.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { StatusBadge } from "../../components/ui/StatusBadge.jsx";
import { OfflineBanner } from "../../components/ui/OfflineBanner.jsx";
import { D } from "../../theme/tokens.js";


// ================================================================
// SCORING SCREEN — the umpire's phone-held officiating console. Keeps the
// app's permanently-dark "court" chrome for gameplay (D.dark/D.darkCard/
// D.teamA/D.teamB, independent of the app-wide light/dark toggle), now built
// from the shared ui/ primitives (Btn/Modal/StatusBadge/OfflineBanner) via
// their additive `dark` variant instead of hand-rolled markup, with a
// hierarchy of Status -> Score -> Server -> Scoring controls -> Match
// controls, per the professional-officiating-console brief.
// ================================================================
export function ScoringScreen({match,state,teamLabel,onPoint,onUndo,onEnd,onBack,onPause,onResume,onTimeout,onDismissTimeout,onHold,onCancel,onEditScore,shareToken,currentUser,cloudEvents=[],players=[]}){
  const [shareMsg,setShareMsg]=useState(false);
  const [editingScore,setEditingScore]=useState(false);
  const [scoreAInput,setScoreAInput]=useState("");
  const [scoreBInput,setScoreBInput]=useState("");
  const [confirmHold,setConfirmHold]=useState(false);
  const [confirmCancel,setConfirmCancel]=useState(false);
  // Umpire connection heartbeat: while THIS assigned umpire's scoreboard view is open,
  // periodically stamp tournament_matches.umpire_last_seen_at so the organizer's Courts tab
  // can show a 🟢/🔴 dot + "last sync Xs ago" (see TournamentDetailPanel.jsx) — reuses the
  // existing updateTournamentMatch outbox kind, no new write path. Runs unconditionally as a
  // hook (rules-of-hooks), no-ops internally before `match`/`state` exist yet.
  useEffect(()=>{
    if(!match?.tournamentMatchId||!isAssignedUmpire(match,currentUser)) return;
    const beat=()=>{ Outbox.enqueue("updateTournamentMatch",{id:match.tournamentMatchId,patch:{umpireLastSeenAt:new Date().toISOString()}}); Outbox.drain(); };
    beat();
    const t=setInterval(beat,15000);
    return ()=>clearInterval(t);
    // Deliberately narrowed to the primitive fields that actually change the beat —
    // `match`/`currentUser` object identity churns every score update, which would
    // otherwise restart this interval on every point.
  },[match?.tournamentMatchId,match?.umpireId,currentUser?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if(!match||!state)return(
    <div style={{background:D.bg,padding:32,textAlign:"center",color:D.textMuted,height:"100%"}}>
      <div style={{fontSize:36,marginBottom:12}}>🏓</div><div>No active match.</div>
      <button onClick={onBack} style={{marginTop:16,padding:"10px 20px",background:D.surface,border:"1px solid "+D.border,borderRadius:22,color:D.textSecondary,cursor:"pointer"}}>Back</button>
    </div>
  );
  const {scoreA,scoreB,servingTeam,isDoubles,history,status,winner,games,
    gameNumber,gamesWonA=0,gamesWonB=0,server,
    timeoutsA=0,timeoutsB=0,timeoutsAllowed=2,timeoutTeam}=state;
  const canUndo=history.length>0||!!(games&&games.length);
  const tA=teamLabel(match.teamA),tB=teamLabel(match.teamB),done=status==="completed",paused=status==="paused";
  const canControl=canControlMatch(match,currentUser,match.eventId?cloudEvents.find(e=>e.id===match.eventId):null)
    || isAssignedUmpire(match,currentUser);
  const openScoreEditor=()=>{ setScoreAInput(String(scoreA)); setScoreBInput(String(scoreB)); setEditingScore(true); };
  const saveScoreEdit=()=>{ onEditScore&&onEditScore(scoreAInput,scoreBInput); setEditingScore(false); };
  // Serving-player name for doubles: `server` (1|2) is the engine's rotation-slot counter, not a
  // persistent per-player identity — mapped here to array index 0/1 of the currently-serving
  // team purely for display. A presentation-layer simplification only; does not touch scoring.js.
  const servingPlayerName=isDoubles?nameOf(players,(servingTeam==="A"?match.teamA:match.teamB)?.[server===1?0:1]):null;
  const statusForBadge=done?"DONE":paused?"PAUSED":"LIVE";
  return(
    <div style={{background:D.dark,height:"100%",overflowY:"auto",padding:"14px 14px 80px"}}>
      <OfflineBanner/>
      {/* ---------- STATUS ---------- */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <button onClick={onBack} aria-label="Back" style={{width:36,height:36,background:D.darkCard,border:"1px solid "+D.darkBorder,borderRadius:18,color:D.darkTextMuted,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontWeight:800,fontSize:15,color:D.darkText}}>{match.courtName}</div>
          <div style={{fontSize:11,color:D.darkTextMuted}}>{isDoubles?"Doubles 2v2":"Singles 1v1"} · First to {match.winTo}{match.organizerName?" · "+match.organizerName:""}{(match.organizerIds||[]).length>0?" +"+match.organizerIds.length+" organizer"+(match.organizerIds.length!==1?"s":""):""}</div>
        </div>
        <button onClick={()=>{if(shareToken){const u=window.location.href;navigator.clipboard?.writeText(u);setShareMsg(true);setTimeout(()=>setShareMsg(false),2000);}}} style={{padding:"7px 12px",background:shareMsg?D.darkGreen+"20":D.darkCard,border:"1px solid "+(shareMsg?D.darkGreen:D.darkBorder),borderRadius:20,color:shareMsg?D.darkGreen:D.darkTextMuted,fontSize:11,fontWeight:600,cursor:"pointer",flexShrink:0}}>
          {shareMsg?"Copied!":"Share"}
        </button>
      </div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        <StatusBadge dark status={statusForBadge}/>
        {!canControl&&<StatusBadge dark status="VIEW_ONLY"/>}
        {!canControl&&(
          <span style={{fontSize:11.5,color:D.darkTextMuted,fontWeight:600}}>
            {match.umpireName?"Umpired by "+match.umpireName:"Organized by "+(match.organizerName||"another organizer")}
          </span>
        )}
      </div>
      {!done&&timeoutTeam&&(
        <div style={{display:"flex",alignItems:"center",gap:10,background:D.darkAmber+"20",border:"1px solid "+D.darkAmber+"40",borderRadius:16,padding:"12px 14px",marginBottom:14}}>
          <span style={{fontSize:18}}>⏱</span>
          <span style={{flex:1,fontSize:12,fontWeight:700,color:D.darkAmber}}>Timeout — {timeoutTeam==="A"?tA:tB}</span>
          {canControl&&onDismissTimeout&&<Btn dark small label="Resume" color={D.darkAmber} onClick={onDismissTimeout}/>}
        </div>
      )}
      {/* ---------- SCORE ---------- */}
      <div style={{background:"linear-gradient(160deg,"+D.dark+","+D.darkCard+")",borderRadius:20,overflow:"hidden",marginBottom:14,boxShadow:"var(--sh-3)"}}>
        {match.bestOf>1&&(
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:10,padding:"10px 14px 0"}}>
            <span style={{fontSize:10,fontWeight:800,letterSpacing:"1px",color:D.darkTextMuted}}>GAME {gameNumber||1} OF {match.bestOf}</span>
            <span style={{fontSize:12,fontWeight:800,color:D.darkText,fontVariantNumeric:"tabular-nums"}}>{gamesWonA}–{gamesWonB}</span>
          </div>
        )}
        <div style={{display:"flex",alignItems:"stretch",padding:"22px 14px 18px"}}>
          {[{s:scoreA,n:tA,t:"A",serving:servingTeam==="A",col:D.teamA},{s:scoreB,n:tB,t:"B",serving:servingTeam==="B",col:D.teamB}].map(tm=>(
            <div key={tm.t} style={{flex:1,textAlign:"center"}}>
              <div style={{fontSize:9,fontWeight:800,letterSpacing:"1.5px",color:tm.serving?tm.col:D.darkTextFaint,marginBottom:6}}>{tm.serving?"SERVING":"RECEIVING"}</div>
              <div style={{fontSize:64,fontWeight:900,color:done&&winner===tm.t?D.darkAmber:tm.serving?tm.col:D.darkTextMuted,lineHeight:1,fontVariantNumeric:"tabular-nums"}}>{tm.s}</div>
              <div style={{fontSize:11,color:D.darkTextSubtle,marginTop:6,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",padding:"0 4px"}}>{tm.n}</div>
            </div>
          ))}
        </div>
        <div style={{height:4,display:"flex",margin:"0 14px 14px",gap:2}}>
          {Array.from({length:match.winTo}).map((_,i)=><div key={i} style={{flex:1,background:i<scoreA?D.teamA:D.darkBorder,borderRadius:1}}/>)}
          <div style={{width:2,background:D.darkBorder}}/>
          {Array.from({length:match.winTo}).map((_,i)=><div key={i} style={{flex:1,background:i<scoreB?D.teamB:D.darkBorder,borderRadius:1}}/>)}
        </div>
        <div style={{textAlign:"center",padding:"0 14px 12px",fontSize:10,color:D.darkTextFaint}}>First to {match.winTo} · Win by 2</div>
      </div>
      {done&&winner&&(
        <div style={{background:D.darkAmber+"20",border:"1px solid "+D.darkAmber+"40",borderRadius:16,padding:"20px",textAlign:"center",marginBottom:14}}>
          <div style={{fontSize:36,marginBottom:8}}>🏆</div>
          <div style={{fontWeight:900,fontSize:20,color:D.darkAmber,marginBottom:2}}>{winner==="A"?tA:tB} wins!</div>
          <div style={{fontSize:13,color:D.darkTextMuted}}>{scoreA} – {scoreB}</div>
        </div>
      )}
      {/* ---------- SERVER ---------- */}
      {!done&&isDoubles&&servingPlayerName&&(
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14,padding:"0 4px"}}>
          <span style={{width:8,height:8,borderRadius:4,background:servingTeam==="A"?D.teamA:D.teamB,flexShrink:0}}/>
          <span style={{fontSize:11,fontWeight:800,letterSpacing:"0.5px",color:D.darkTextMuted}}>SERVING</span>
          <span style={{fontSize:13,fontWeight:700,color:D.darkText}}>{servingPlayerName}</span>
        </div>
      )}
      {!done&&paused&&(
        <div style={{textAlign:"center",padding:"32px 20px",color:D.darkTextMuted,background:D.darkCard,border:"1px solid "+D.darkBorder,borderRadius:18,marginBottom:14}}>
          <div style={{fontSize:32,marginBottom:8}}>⏸</div>
          <div style={{fontWeight:700,marginBottom:12,color:D.darkText}}>Match paused</div>
          {canControl&&<Btn dark label="Resume Match" color={D.darkGreen} onClick={onResume}/>}
        </div>
      )}
      {/* ---------- SCORING CONTROLS ---------- */}
      {canControl&&!done&&!paused&&(
        <div style={{display:"flex",gap:10,marginBottom:18}}>
          {[{s:scoreA,n:tA,t:"A",serving:servingTeam==="A",col:D.teamA},{s:scoreB,n:tB,t:"B",serving:servingTeam==="B",col:D.teamB}].map(tm=>(
            <button key={tm.t} onClick={()=>onPoint(tm.t)} style={{flex:1,padding:0,background:tm.serving?D.darkCard:D.dark,border:"2px solid "+(tm.serving?tm.col:D.darkBorder),borderRadius:18,cursor:"pointer",overflow:"hidden"}}>
              {tm.serving&&<div style={{height:3,background:tm.col}}/>}
              <div style={{padding:"20px 10px 16px"}}>
                {tm.serving&&<div style={{fontSize:9,fontWeight:800,color:tm.col,letterSpacing:"1.5px",marginBottom:8}}>SERVING</div>}
                <div style={{fontSize:54,fontWeight:900,color:tm.serving?tm.col:D.darkTextFaint,lineHeight:1,marginBottom:8,fontVariantNumeric:"tabular-nums"}}>{tm.s}</div>
                <div style={{fontSize:11,color:tm.serving?tm.col:D.darkTextFaint,fontWeight:600,marginBottom:14,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tm.n}</div>
                <div style={{padding:"12px",background:tm.serving?tm.col:tm.col+"30",borderRadius:12,color:tm.serving?"#fff":tm.col,fontWeight:800,fontSize:14}}>+ Point</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {/* ---------- MATCH CONTROLS ---------- */}
      {canControl&&!done&&(
        <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
          <Btn dark full label={paused?"▶ Resume Match":"⏸ Pause Match"} color={paused?D.darkGreen:D.darkTextMuted} outline onClick={paused?onResume:onPause}/>
        </div>
      )}
      {canControl&&!done&&!paused&&onTimeout&&(
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          {[{t:"A",label:tA,used:timeoutsA},{t:"B",label:tB,used:timeoutsB}].map(tm=>{
            const remaining=timeoutsAllowed-tm.used;
            return(
              <button key={tm.t} onClick={()=>onTimeout(tm.t)} disabled={remaining<=0}
                style={{flex:1,padding:"9px",background:D.darkCard,border:"1px solid "+D.darkBorder,borderRadius:16,
                  color:remaining>0?D.darkTextMuted:D.darkBorder,fontWeight:600,fontSize:11,cursor:remaining>0?"pointer":"default"}}>
                Timeout — {tm.label} ({remaining} left)
              </button>
            );
          })}
        </div>
      )}
      {canControl&&!done&&(
        <div style={{display:"flex",gap:8,marginBottom:10}}>
          {onUndo&&<Btn dark small label="Undo" outline color={D.darkTextMuted} disabled={!canUndo||paused} onClick={onUndo}/>}
          {onEditScore&&<Btn dark small label="Edit Score" outline color={editingScore?D.darkGreen:D.darkTextMuted} onClick={editingScore?()=>setEditingScore(false):openScoreEditor}/>}
        </div>
      )}
      {editingScore&&canControl&&(
        <div style={{background:D.darkCard,border:"1px solid "+D.darkBorder,borderRadius:16,padding:"14px",marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.darkTextMuted,marginBottom:10}}>EDIT SCORE MANUALLY</div>
          <div style={{display:"flex",gap:10,marginBottom:12}}>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,color:D.darkTextSubtle,marginBottom:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tA}</div>
              <input type="number" min="0" step="1" inputMode="numeric" value={scoreAInput}
                onChange={e=>setScoreAInput(e.target.value.replace(/[^0-9]/g,""))}
                style={{width:"100%",background:D.dark,border:"1px solid "+D.darkBorder,borderRadius:10,padding:"10px 12px",color:D.darkText,fontSize:16,fontWeight:800,outline:"none",boxSizing:"border-box"}}/>
            </div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,color:D.darkTextSubtle,marginBottom:5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tB}</div>
              <input type="number" min="0" step="1" inputMode="numeric" value={scoreBInput}
                onChange={e=>setScoreBInput(e.target.value.replace(/[^0-9]/g,""))}
                style={{width:"100%",background:D.dark,border:"1px solid "+D.darkBorder,borderRadius:10,padding:"10px 12px",color:D.darkText,fontSize:16,fontWeight:800,outline:"none",boxSizing:"border-box"}}/>
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            <Btn dark full label="Save Score" color={D.darkGreen} disabled={scoreAInput===""||scoreBInput===""} onClick={saveScoreEdit}/>
            <Btn dark label="Cancel" outline color={D.darkTextMuted} onClick={()=>setEditingScore(false)}/>
          </div>
        </div>
      )}
      {canControl&&!done&&(
        <div style={{display:"flex",gap:8,marginBottom:14}}>
          {onHold&&<Btn dark label="Hold" outline color={D.darkAmber} onClick={()=>setConfirmHold(true)}/>}
          <Btn dark label="Cancel Match" outline color={D.darkRed} onClick={()=>setConfirmCancel(true)}/>
        </div>
      )}
      {canControl&&done&&<Btn dark full label="Save Result & Update Ratings" color={D.darkAmber} onClick={onEnd}/>}
      {confirmHold&&(
        <ConfirmDialog title="Put match on hold?"
          message="It leaves the court and moves to the Queue with its score kept — assign it to a court later to continue."
          confirmLabel="Put on Hold"
          onConfirm={()=>{setConfirmHold(false);onHold();}}
          onCancel={()=>setConfirmHold(false)}/>
      )}
      {confirmCancel&&(
        <ConfirmDialog title="Cancel this match?" message="This cannot be undone." confirmLabel="Cancel Match" destructive
          onConfirm={()=>{setConfirmCancel(false);onCancel();}}
          onCancel={()=>setConfirmCancel(false)}/>
      )}
    </div>
  );
}
