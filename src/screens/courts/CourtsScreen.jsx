import { useState } from "react";
import { canControlMatch } from "../../lib/mixmatch.js";
import { isAssignedUmpire } from "../../lib/umpire.js";
import { hasElectron } from "../../lib/utils.js";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { D } from "../../theme/tokens.js";


export function CourtsScreen({matches,liveStates,courts,players,sendPoint,sendUndo,endMatch,pauseMatch,resumeMatch,holdMatch,cancelMatch,onManage,onNewMatch,teamLabel,setActiveMatchId,setScreen,queue=[],heldMatches=[],remoteLive=[],currentUser=null,onClearQueue,categories=[],onStartQueuedNow,onResumeHeld,infiniteMM,onManualAssign,cloudEvents=[]}){
  const eventOf=(m)=>m.eventId?cloudEvents.find(e=>e.id===m.eventId):null;
  const activeCourts=courts.filter(c=>c.active);
  const catNameOf=(cid)=>categories.find(c=>c.id===cid)?.name||null;
  const localIds=new Set(matches.map(m=>m.id));
  // Live matches running on OTHER devices (don't duplicate my own).
  const otherLive=(remoteLive||[]).filter(r=>!localIds.has(r.id) && r.status!=="completed" && (!currentUser||r.ownerId!==currentUser.id));
  const nameFromQueue=(id)=>players.find(p=>p.id===id)?.name||"?";
  const isEmpty=matches.length===0 && (queue||[]).length===0 && (heldMatches||[]).length===0 && otherLive.length===0;
  // Manual court assignment: selecting a queued or held match never touches a court by itself —
  // the admin must separately tap "Manually Assign"/"Assign Selected Match" on a specific open
  // court card to place it. No automatic court-picking happens anywhere in this flow.
  const [selected,setSelected]=useState(null); // {type:"queue"|"held", id}
  const toggleSelectQueue=(qid)=>setSelected(s=>(s&&s.type==="queue"&&s.id===qid)?null:{type:"queue",id:qid});
  const toggleSelectHeld=(matchId)=>setSelected(s=>(s&&s.type==="held"&&s.id===matchId)?null:{type:"held",id:matchId});
  // Confirm-before-Hold/Cancel used to go through native window.confirm() — replaced with the
  // app's own ConfirmDialog (see ui/ConfirmDialog.jsx) so it matches every other confirm flow's
  // visual language instead of breaking out into a browser-chrome dialog mid-match.
  const [confirmHoldId,setConfirmHoldId]=useState(null);
  const [confirmCancelId,setConfirmCancelId]=useState(null);
  return(
    <div style={{background:D.bg,height:"100%",overflowY:"auto",padding:"14px 14px 80px"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <div style={{fontWeight:900,fontSize:20,color:D.textPrimary}}>Live Courts</div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={onManage} style={{padding:"8px 14px",background:D.surface,border:"1px solid "+D.border,borderRadius:22,color:D.textSecondary,fontSize:12,fontWeight:600,cursor:"pointer"}}>Manage</button>
          <button onClick={onNewMatch} style={{padding:"8px 16px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>+ Match</button>
        </div>
      </div>
      {infiniteMM&&infiniteMM.enabled&&(
        <div style={{display:"flex",alignItems:"center",gap:8,background:D.accentBg,border:"1px solid "+D.accent,borderRadius:14,padding:"9px 14px",marginBottom:18}}>
          <span style={{fontSize:12,fontWeight:800,color:D.accent}}>♾️ Infinite Mode: ON</span>
          <span style={{fontSize:11,color:D.textSecondary}}>· {infiniteMM.source==="master"?"Master List":(categories.find(c=>c.id===infiniteMM.source)?.name||"Category")}{infiniteMM.roundsMode==="fixed"?" · "+(infiniteMM.roundsCount||1)+" rounds":""}</span>
        </div>
      )}

      {isEmpty&&<div style={{textAlign:"center",padding:"60px 20px",background:D.surface,borderRadius:16,border:"1px solid "+D.border}}><div style={{fontSize:44,marginBottom:12}}>🏟</div><div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>No active matches</div><div style={{fontSize:12,color:D.textSecondary}}>Start a match or use Mix &amp; Match to fill the courts</div></div>}

      {activeCourts.map(court=>{
        const cm=matches.filter(m=>m.courtId===court.id);
        return(
          <div key={court.id} style={{marginBottom:20}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <div style={{width:10,height:10,borderRadius:5,background:court.color}}/>
              <span style={{fontWeight:700,fontSize:14,color:D.textPrimary}}>{court.name}</span>
              {cm.length===0&&<span style={{fontSize:10,fontWeight:700,color:D.textMuted,background:D.cardEl,borderRadius:12,padding:"2px 8px"}}>OPEN</span>}
              {hasElectron&&(
                <button onClick={()=>window.electronAPI.openScoreboardWindow({courtId:court.id})}
                  title="Open this court on the Live Scoreboard window"
                  style={{marginLeft:"auto",width:24,height:24,borderRadius:12,background:D.cardEl,border:"1px solid "+D.border,color:D.textSecondary,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>
                  📺
                </button>
              )}
            </div>
            {cm.length===0&&(
              <div style={{background:D.surface,border:"1px dashed "+D.borderHi,borderRadius:14,padding:"18px",textAlign:"center"}}>
                <div style={{fontSize:12,color:D.textMuted,marginBottom:onManualAssign?10:0}}>Court available</div>
                {onManualAssign&&<button onClick={()=>{
                  if(selected&&selected.type==="queue"){ onStartQueuedNow&&onStartQueuedNow(selected.id,court.id); setSelected(null); return; }
                  if(selected&&selected.type==="held"){ onResumeHeld&&onResumeHeld(selected.id,court.id); setSelected(null); return; }
                  onManualAssign(court.id);
                }} style={{padding:"7px 16px",background:selected?D.accent:D.cardEl,border:"1px solid "+(selected?D.accent:D.border),borderRadius:20,color:selected?"#fff":D.textSecondary,fontSize:11,fontWeight:700,cursor:"pointer"}}>{selected?"Assign Selected Match":"Manually Assign"}</button>}
              </div>
            )}
            {cm.map(m=>{
              const st=liveStates[m.id];if(!st)return null;
              const done=st.status==="completed";
              const paused=st.status==="paused";
              const catName=catNameOf(m.category);
              const canControl=canControlMatch(m,currentUser,eventOf(m))||isAssignedUmpire(m,currentUser);
              return(
                <Card key={m.id} padding={0} style={{overflow:"hidden",marginBottom:10,boxShadow:"0 2px 8px rgba(0,0,0,.06)"}}>
                  <div style={{padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+D.border}}>
                    <div style={{display:"flex",alignItems:"center",gap:6}}>
                      {done?<span style={{fontSize:11,fontWeight:700,color:D.amber,background:D.amberBg,borderRadius:20,padding:"3px 8px"}}>DONE</span>
                        :paused?<span style={{fontSize:11,fontWeight:700,color:D.textMuted,background:D.cardEl,borderRadius:20,padding:"3px 8px"}}>⏸ PAUSED</span>
                        :<div style={{display:"flex",alignItems:"center",gap:5}}><span style={{width:7,height:7,borderRadius:4,background:D.red,display:"inline-block",animation:"pulse 1s infinite"}}/><span style={{fontSize:11,fontWeight:700,color:D.red}}>LIVE</span></div>}
                      {catName&&<span style={{fontSize:9,fontWeight:700,color:D.accent,background:D.accentBg,borderRadius:20,padding:"2px 8px"}}>{catName}</span>}
                      <span style={{fontSize:10,color:D.textMuted}}>· {m.isDoubles?"2v2":"1v1"} to {m.winTo}</span>
                      {m.organizerName&&<span style={{fontSize:10,color:D.textMuted}}>· {m.organizerName}</span>}
                      {(m.organizerIds||[]).length>0&&<span style={{fontSize:10,color:D.textMuted}}>+{m.organizerIds.length} organizer{m.organizerIds.length!==1?"s":""}</span>}
                      {!canControl&&<span style={{fontSize:9,fontWeight:700,color:D.textMuted,background:D.cardEl,borderRadius:20,padding:"2px 8px"}}>VIEW ONLY</span>}
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      {canControl&&!done&&(paused
                        ?<button onClick={()=>resumeMatch(m.id)} style={{padding:"5px 10px",background:D.greenBg,border:"1px solid "+D.green,borderRadius:20,color:D.green,fontSize:11,fontWeight:700,cursor:"pointer"}}>Resume</button>
                        :<button onClick={()=>pauseMatch(m.id)} style={{padding:"5px 10px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:20,color:D.textSecondary,fontSize:11,fontWeight:600,cursor:"pointer"}}>Pause</button>)}
                      {canControl&&!done&&holdMatch&&<button onClick={()=>setConfirmHoldId(m.id)} style={{padding:"5px 10px",background:D.amberBg,border:"1px solid "+D.amber,borderRadius:20,color:D.amber,fontSize:11,fontWeight:600,cursor:"pointer"}}>Hold</button>}
                      {canControl&&!done&&<button onClick={()=>setConfirmCancelId(m.id)} style={{padding:"5px 10px",background:D.redBg,border:"1px solid "+D.red,borderRadius:20,color:D.red,fontSize:11,fontWeight:600,cursor:"pointer"}}>Cancel</button>}
                      <button onClick={()=>{setActiveMatchId(m.id);setScreen("scoring");}} style={{padding:"5px 12px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:20,color:D.textSecondary,fontSize:11,fontWeight:600,cursor:"pointer"}}>Open</button>
                    </div>
                  </div>
                  <div style={{padding:"14px",background:D.cardEl,display:"flex",alignItems:"center",gap:8}}>
                    {[{s:st.scoreA,n:teamLabel(m.teamA),t:"A",serving:st.servingTeam==="A",col:D.teamA},{s:st.scoreB,n:teamLabel(m.teamB),t:"B",serving:st.servingTeam==="B",col:D.teamB}].map(tm=>(
                      <div key={tm.t} style={{flex:1,textAlign:"center"}}>
                        <div style={{fontSize:9,fontWeight:700,color:tm.serving?tm.col:D.textMuted,marginBottom:4}}>{tm.serving?"SERVING":""}</div>
                        <div style={{fontSize:42,fontWeight:900,color:done&&st.winner===tm.t?D.amber:tm.serving?tm.col:D.textMuted,lineHeight:1}}>{tm.s}</div>
                        <div style={{fontSize:10,color:D.textSecondary,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tm.n}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{padding:"10px 12px",display:"flex",gap:8,borderTop:"1px solid "+D.border}}>
                    {!canControl
                      ?<div style={{flex:1,textAlign:"center",padding:"8px",fontSize:12,color:D.textMuted,fontWeight:600}}>👁 View only — organized by {m.organizerName||"another organizer"}</div>
                      :done
                      ?<button onClick={()=>endMatch(m.id)} style={{flex:1,padding:"11px",background:D.amber,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>Save Result</button>
                      :paused
                      ?<div style={{flex:1,textAlign:"center",padding:"8px",fontSize:12,color:D.textMuted,fontWeight:600}}>⏸ Paused — tap Resume to continue</div>
                      :<>
                        <button onClick={()=>sendPoint(m.id,"A")} style={{flex:1,padding:"11px",background:D.teamA,border:"none",borderRadius:22,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>+1 {teamLabel(m.teamA).split(" ")[0]}</button>
                        <button onClick={()=>sendUndo(m.id)} style={{padding:"11px 14px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:22,color:D.textSecondary,cursor:"pointer",fontSize:13}}>↩</button>
                        <button onClick={()=>sendPoint(m.id,"B")} style={{flex:1,padding:"11px",background:D.teamB,border:"none",borderRadius:22,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>+1 {teamLabel(m.teamB).split(" ")[0]}</button>
                      </>}
                  </div>
                </Card>
              );
            })}
          </div>
        );
      })}

      {/* On Hold — matches pulled off a court mid-game, score/history kept, waiting for the
          admin to manually assign them to a court to continue. */}
      {(heldMatches||[]).length>0&&(
        <div style={{background:D.cardEl,border:"1px solid "+D.border,borderRadius:14,padding:"12px 14px",marginBottom:18}}>
          <span style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.textSecondary}}>⏸ ON HOLD · {heldMatches.length}</span>
          {heldMatches.map((m,i)=>{
            const st=liveStates[m.id];
            const isSelected=selected&&selected.type==="held"&&selected.id===m.id;
            return(
              <div key={m.id} style={{padding:"8px 0",borderTop:i?"1px solid "+D.border:"none"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,flexWrap:"wrap"}}>
                  <span style={{fontSize:9,fontWeight:800,color:D.textMuted,background:D.surface,borderRadius:10,padding:"2px 7px"}}>HOLD</span>
                  <span style={{color:D.teamA,fontWeight:700}}>{teamLabel(m.teamA)}</span>
                  <span style={{color:D.textMuted,fontSize:10}}>vs</span>
                  <span style={{color:D.teamB,fontWeight:700}}>{teamLabel(m.teamB)}</span>
                  {st&&<span style={{fontSize:11,fontWeight:800,color:D.textSecondary}}>{st.scoreA}–{st.scoreB}</span>}
                  {onResumeHeld&&(
                    <button onClick={()=>toggleSelectHeld(m.id)} style={{marginLeft:"auto",padding:"4px 10px",background:isSelected?D.accent:D.textMuted,border:"none",borderRadius:16,color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>{isSelected?"Selected":"Assign"}</button>
                  )}
                </div>
                {isSelected&&(
                  <div style={{fontSize:10,color:D.accent,fontWeight:600,marginTop:5,paddingLeft:26}}>Selected — tap "Manually Assign" on an open court below to resume it there.</div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Up Next — queued Mix & Match matches waiting for a free court */}
      {(queue||[]).length>0&&(
        <div style={{background:D.amberBg,border:"1px solid "+D.amber,borderRadius:14,padding:"12px 14px",marginBottom:18}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
            <span style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.amber}}>⏭ UP NEXT · {queue.length} QUEUED</span>
            {onClearQueue&&<button onClick={onClearQueue} style={{padding:"3px 10px",background:"transparent",border:"1px solid "+D.amber,borderRadius:16,color:D.amber,fontSize:10,fontWeight:700,cursor:"pointer"}}>Clear</button>}
          </div>
          {queue.map((q,i)=>{
            const isSelected=selected&&selected.type==="queue"&&selected.id===q.qid;
            return(
            <div key={q.qid||i} style={{padding:"6px 0",borderTop:i?"1px solid "+D.amber:"none"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,fontSize:12,flexWrap:"wrap"}}>
                <span style={{fontSize:10,fontWeight:800,color:D.amber,minWidth:18}}>{i+1}</span>
                <span style={{color:D.teamA,fontWeight:700}}>{(q.teamA||[]).map(nameFromQueue).join(" & ")}</span>
                <span style={{color:D.textMuted,fontSize:10}}>vs</span>
                <span style={{color:D.teamB,fontWeight:700}}>{(q.teamB||[]).map(nameFromQueue).join(" & ")}</span>
                {onStartQueuedNow&&(
                  <button onClick={()=>toggleSelectQueue(q.qid)} style={{marginLeft:"auto",padding:"4px 10px",background:isSelected?D.accent:D.amber,border:"none",borderRadius:16,color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer",flexShrink:0}}>{isSelected?"Selected":"Start Now"}</button>
                )}
              </div>
              {isSelected&&(
                <div style={{fontSize:10,color:D.accent,fontWeight:600,marginTop:5,paddingLeft:26}}>Selected — tap "Manually Assign" on an open court below to place it.</div>
              )}
            </div>
            );
          })}
          <div style={{fontSize:10,color:D.textMuted,marginTop:6}}>Auto-starts on the next court to finish, or select a match and manually assign it to any open court.</div>
        </div>
      )}

      {/* Live on other devices — read-only, auto-updates via cloud sync */}
      {otherLive.length>0&&(
        <div style={{marginTop:8}}>
          <div style={{fontSize:11,fontWeight:800,letterSpacing:"1px",color:D.textMuted,marginBottom:10}}>📡 LIVE ELSEWHERE</div>
          {otherLive.map(r=>{
            const done=r.status==="completed";
            return(
              <Card key={r.id} padding={0} style={{overflow:"hidden",marginBottom:10}}>
                <div style={{padding:"9px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",borderBottom:"1px solid "+D.border}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:7,height:7,borderRadius:4,background:done?D.amber:D.red,display:"inline-block",animation:done?"none":"pulse 1s infinite"}}/>
                    <span style={{fontSize:11,fontWeight:700,color:done?D.amber:D.red}}>{done?"DONE":"LIVE"}</span>
                    <span style={{fontSize:10,color:D.textMuted}}>· {r.courtName||"Court"} · {r.isDoubles?"2v2":"1v1"}</span>
                  </div>
                  {r.ownerName&&<span style={{fontSize:10,color:D.textMuted}}>{r.ownerName}</span>}
                </div>
                <div style={{padding:"14px",background:D.cardEl,display:"flex",alignItems:"center",gap:8}}>
                  {[{s:r.scoreA,n:r.teamALabel||"Team A",t:"A",serving:r.servingTeam==="A",col:D.teamA},{s:r.scoreB,n:r.teamBLabel||"Team B",t:"B",serving:r.servingTeam==="B",col:D.teamB}].map(tm=>(
                    <div key={tm.t} style={{flex:1,textAlign:"center"}}>
                      <div style={{fontSize:42,fontWeight:900,color:done&&r.winner===tm.t?D.amber:tm.serving?tm.col:D.textMuted,lineHeight:1}}>{tm.s}</div>
                      <div style={{fontSize:10,color:D.textSecondary,marginTop:4,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{tm.n}</div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {confirmHoldId&&(
        <ConfirmDialog title="Put this match on hold?"
          message="It leaves the court and moves to On Hold with its score kept — assign it to a court later to continue."
          confirmLabel="Put on Hold"
          onConfirm={()=>{holdMatch(confirmHoldId);setConfirmHoldId(null);}}
          onCancel={()=>setConfirmHoldId(null)}/>
      )}
      {confirmCancelId&&(
        <ConfirmDialog title="Cancel this match?" message="This cannot be undone." confirmLabel="Cancel Match" destructive
          onConfirm={()=>{cancelMatch(confirmCancelId);setConfirmCancelId(null);}}
          onCancel={()=>setConfirmCancelId(null)}/>
      )}
    </div>
  );
}
