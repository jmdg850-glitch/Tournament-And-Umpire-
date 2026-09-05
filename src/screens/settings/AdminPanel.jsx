import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { OverlayShell } from "../../components/ui/OverlayShell.jsx";
import { Toggle } from "../../components/ui/Toggle.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { RatingEngine } from "../../lib/ratingEngine.js";
import { clamp, fmtDate, today } from "../../lib/utils.js";
import { LogViewer } from "./LogsPanel.jsx";
import { D } from "../../theme/tokens.js";

// See Panel.jsx for why: caps this full-bleed drill-down surface on the
// Electron desktop shell so it doesn't stretch edge-to-edge on a maximized
// window.
const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

// ================================================================
// ADMIN PANEL
// ================================================================
// Access to this panel is gated at the render site in App.jsx
// (currentUser?.role==="admin"), backed server-side by RLS + is_admin().
export function AdminPanel({players,matches,setAdminMode,onClose:onCloseProp,onBan,onUnban,onDelete,notify,ratingConfig,onSetRatingConfig}){
  const [open,setOpen]=useState(true);
  const onClose=()=>setOpen(false);
  const [tab,setTab]=useState("dashboard");
  const [baseRatingInput,setBaseRatingInput]=useState(()=>String((+ratingConfig?.baseRating||RatingEngine.BASE).toFixed(3)));
  const [confirmDeletePlayer,setConfirmDeletePlayer]=useState(null);
  return(
    <OverlayShell open={open} onRequestClose={onClose} onExitComplete={onCloseProp} variant="panel" label="Admin Command Center"
      style={{position:"fixed",inset:0,zIndex:500,background:D.bg,display:"flex",flexDirection:"column",paddingTop:"env(safe-area-inset-top)",
        ...(hasElectron?{maxWidth:720,margin:"0 auto",borderLeft:`1px solid ${D.border}`,borderRight:`1px solid ${D.border}`}:{})}}>
      <div style={{height:56,display:"flex",alignItems:"center",gap:12,padding:"0 16px",borderBottom:"1px solid "+D.border,background:D.surface,flexShrink:0}}>
        <button onClick={onClose} aria-label="Close" style={{width:36,height:36,borderRadius:18,background:D.cardEl,border:"none",color:D.textSecondary,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
        <div style={{flex:1,fontWeight:800,fontSize:16,color:D.textPrimary}}>Admin Command Center</div>
        <button onClick={()=>setAdminMode(false)} style={{padding:"6px 12px",background:D.redBg,border:"1px solid "+D.red,borderRadius:20,color:D.red,fontSize:12,fontWeight:700,cursor:"pointer"}}>Exit</button>
      </div>
      <div style={{display:"flex",background:D.surface,borderBottom:"1px solid "+D.border,flexShrink:0}}>
        {["dashboard","users","matches","ratings","logs"].map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:"11px 4px",background:"transparent",border:"none",borderBottom:"2px solid "+(tab===t?D.accent:"transparent"),color:tab===t?D.accent:D.textSecondary,fontWeight:tab===t?700:400,fontSize:12,cursor:"pointer",textTransform:"capitalize"}}>{t}</button>
        ))}
      </div>
      <div style={{flex:1,overflowY:"auto",padding:"14px 14px 80px"}}>
        {tab==="dashboard"&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            {[{l:"Total Players",v:players.length,c:D.accent,i:"👥"},{l:"Total Matches",v:matches.length,c:D.blue,i:"📋"},{l:"Today",v:matches.filter(m=>m.date===today()).length,c:D.amber,i:"⚡"},{l:"Banned",v:players.filter(p=>p.banned).length,c:D.red,i:"🚫"}].map(s=>(
              <Card key={s.l} style={{textAlign:"center"}}>
                <div style={{fontSize:24,marginBottom:6}}>{s.i}</div>
                <div style={{fontSize:28,fontWeight:900,color:s.c}}>{s.v}</div>
                <div style={{fontSize:10,color:D.textMuted,fontWeight:600,marginTop:3}}>{s.l.toUpperCase()}</div>
              </Card>
            ))}
          </div>
        )}
        {tab==="users"&&players.map(p=>(
          <div key={p.id} style={{background:D.surface,border:"1px solid "+(p.banned?D.red:D.border),borderRadius:13,padding:"12px 14px",marginBottom:8}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
              <Avatar name={p.name} photo={p.photo} size={38} color={D.accent}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700,fontSize:13,color:p.banned?D.red:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                <div style={{fontSize:10,color:D.textSecondary}}>{p.email||"No email"} · Joined {fmtDate(p.joinDate)}</div>
              </div>
              {p.banned&&<span style={{fontSize:9,fontWeight:800,color:D.red,background:D.redBg,borderRadius:10,padding:"2px 7px",flexShrink:0}}>BANNED</span>}
            </div>
            <div style={{display:"flex",gap:6}}>
              {p.banned
                ?<button onClick={()=>{onUnban(p.id);notify("Unbanned");}} style={{flex:1,padding:"6px",background:D.greenBg,border:"1px solid "+D.green,borderRadius:20,color:D.green,fontSize:11,fontWeight:700,cursor:"pointer"}}>Unban</button>
                :<button onClick={()=>{onBan(p.id);notify("Banned");}} style={{flex:1,padding:"6px",background:D.amberBg,border:"1px solid "+D.amber,borderRadius:20,color:D.amber,fontSize:11,fontWeight:700,cursor:"pointer"}}>Ban</button>}
              <button onClick={()=>setConfirmDeletePlayer(p)} style={{flex:1,padding:"6px",background:D.redBg,border:"1px solid "+D.red,borderRadius:20,color:D.red,fontSize:11,fontWeight:700,cursor:"pointer"}}>Delete</button>
            </div>
          </div>
        ))}
        {tab==="matches"&&matches.map(m=>{
          const wl=m.winner==="A"?[...(m.teamA||[])].map(id=>players.find(p=>p.id===id)?.name||"?").join(" & "):[...(m.teamB||[])].map(id=>players.find(p=>p.id===id)?.name||"?").join(" & ");
          return(
            <Card key={m.id} padding="11px 13px" style={{marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>🏆 {wl}</div>
                <div style={{fontSize:10,color:D.textSecondary}}>{m.courtName} · {fmtDate(m.date)} · {m.isDoubles?"Doubles":"Singles"}</div>
              </div>
              <div style={{fontWeight:700,color:D.textPrimary,flexShrink:0,fontSize:14}}>{m.finalScoreA||m.scoreA}–{m.finalScoreB||m.scoreB}</div>
            </Card>
          );
        })}
        {tab==="ratings"&&(
          <div>
            <Card style={{marginBottom:12}}>
              <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,marginBottom:4}}>Rating Engine</div>
              <div style={{fontSize:12,color:D.textSecondary,lineHeight:1.6,marginBottom:14}}>
                The starting rating assigned to every brand-new player (registered sign-up, quick-add, or Excel import). Existing players' ratings are never changed by this setting.
              </div>
              <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>DEFAULT STARTING RATING · 2.000 – 8.000</div>
              <div style={{display:"flex",gap:8}}>
                <input type="number" step="0.001" min="2" max="8" value={baseRatingInput}
                  onChange={e=>setBaseRatingInput(e.target.value)}
                  style={{flex:1,background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"11px 13px",color:D.textPrimary,fontSize:14,outline:"none",fontVariantNumeric:"tabular-nums"}}/>
                <button onClick={()=>{
                  const v=clamp(parseFloat(baseRatingInput)||RatingEngine.BASE,2,8);
                  setBaseRatingInput(String(v.toFixed(3)));
                  onSetRatingConfig&&onSetRatingConfig({baseRating:v});
                }} style={{padding:"11px 20px",background:D.accent,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>Save</button>
              </div>
              <div style={{fontSize:11,color:D.textMuted,marginTop:10}}>Current: <b style={{color:D.accent}}>{RatingEngine.format(ratingConfig?.baseRating)}</b></div>
            </Card>
            <Card style={{marginBottom:12,display:"flex",alignItems:"center",gap:12}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,marginBottom:4}}>Auto-submit to DUPR</div>
                <div style={{fontSize:12,color:D.textSecondary,lineHeight:1.6}}>When on, every completed match with DUPR-linked players submits automatically. Off by default — organizers submit manually per match from History instead.</div>
              </div>
              <Toggle value={!!ratingConfig?.duprAutoSubmit} onChange={v=>onSetRatingConfig&&onSetRatingConfig({duprAutoSubmit:v})} label="Auto-submit to DUPR"/>
            </Card>
            <Card>
              <div style={{fontWeight:800,fontSize:14,color:D.textPrimary,marginBottom:8}}>How ratings move</div>
              <div style={{fontSize:12,color:D.textSecondary,lineHeight:1.7}}>
                Every completed match automatically updates both players'/teams' ratings via an original, DUPR-inspired engine — the same engine for registered accounts and guest/imported players. New players (low Confidence) move faster; established players (high Confidence) move more gradually. Confidence and rating history are visible on each player's profile.
              </div>
            </Card>
          </div>
        )}
        {tab==="logs"&&<LogViewer notify={notify}/>}
      </div>
      {confirmDeletePlayer&&(
        <ConfirmDialog title={"Delete "+confirmDeletePlayer.name+"?"} confirmLabel="Delete Player" destructive
          onConfirm={()=>{const p=confirmDeletePlayer;setConfirmDeletePlayer(null);onDelete(p.id);}}
          onCancel={()=>setConfirmDeletePlayer(null)}/>
      )}
    </OverlayShell>
  );
}

