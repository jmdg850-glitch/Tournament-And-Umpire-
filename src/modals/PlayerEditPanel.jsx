import { useState, useRef } from "react";
import { Avatar } from "../components/ui/Avatar.jsx";
import { Panel } from "../components/ui/Panel.jsx";
import { ConfirmDialog } from "../components/ui/ConfirmDialog.jsx";
import { Card } from "../components/ui/Card.jsx";
import { Dupr } from "../lib/dupr.js";
import { clamp } from "../lib/utils.js";
import { D } from "../theme/tokens.js";


// ================================================================
// PLAYER EDIT PANEL
// ================================================================
export function PlayerEditPanel({player,onUpdate,onDelete,onClose,notify,categories=[],teams=[],directory=[],onLinkAccount}){
  const [form,setForm]=useState({...player});
  const set=(k,v)=>setForm(f=>({...f,[k]:v}));
  const save=()=>{onUpdate(player.id,form);onClose();notify("Player saved");};
  const photoRef=useRef(null);
  const handlePhoto=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>set("photo",ev.target.result);r.readAsDataURL(f);};
  const [linkQuery,setLinkQuery]=useState("");
  const [showLinkSearch,setShowLinkSearch]=useState(false);
  const linkResults=(directory||[]).filter(d=>
    (linkQuery.trim()===""||(d.name||"").toLowerCase().includes(linkQuery.toLowerCase())||(d.email||"").toLowerCase().includes(linkQuery.toLowerCase())));
  const [showDuprSearch,setShowDuprSearch]=useState(false);
  const [duprQuery,setDuprQuery]=useState("");
  const [duprHits,setDuprHits]=useState(null);
  const [duprBusy,setDuprBusy]=useState(false);
  const [duprErr,setDuprErr]=useState("");
  const [duprId,setDuprId]=useState(player.duprId||null);
  const [confirmLinkAccount,setConfirmLinkAccount]=useState(null);
  const [confirmDeletePlayer,setConfirmDeletePlayer]=useState(false);
  // The real DUPR API has no email-lookup endpoint — search by name and let
  // the organizer pick the correct player from results instead.
  const searchDupr=async()=>{
    const q=duprQuery.trim();
    if(!q){setDuprErr("Enter the player's name.");return;}
    setDuprBusy(true);setDuprErr("");setDuprHits(null);
    const res=await Dupr.searchPlayers(q);
    setDuprBusy(false);
    if(res?.ok) setDuprHits(res.hits||[]);
    else setDuprErr(res?.error||"DUPR search failed.");
  };
  const pickDupr=async(hit)=>{
    setDuprBusy(true);setDuprErr("");
    const res=await Dupr.linkGuest(player.id,hit.duprId);
    setDuprBusy(false);
    if(res?.ok){ setDuprId(res.duprId); setShowDuprSearch(false); notify("DUPR ID linked ✓"); }
    else setDuprErr(res?.error||"Couldn't link that DUPR account.");
  };
  return(
    <Panel title="Edit Player" onClose={onClose}
      headerRight={<button onClick={save} style={{padding:"8px 18px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>Save</button>}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
          <div style={{position:"relative",cursor:"pointer"}} onClick={()=>photoRef.current?.click()}
            role="button" aria-label="Upload player photo" tabIndex={0}
            onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();photoRef.current?.click();}}}>
            <Avatar name={form.name} photo={form.photo} size={76} color={D.accent}/>
            <div style={{position:"absolute",bottom:0,right:0,width:24,height:24,borderRadius:12,background:D.accent,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,border:"2px solid "+D.bg}}>✏️</div>
            <input ref={photoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
          </div>
        </div>
        {[{l:"FULL NAME",k:"name",p:"Player name"},{l:"EMAIL",k:"email",p:"email@example.com"},{l:"PHONE",k:"phone",p:"+63 912 345 6789"}].map(f=>(
          <div key={f.k} style={{marginBottom:13}}>
            <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>{f.l}</div>
            <input value={form[f.k]||""} onChange={e=>set(f.k,e.target.value)} placeholder={f.p} style={{width:"100%",background:D.surface,border:"1px solid "+D.border,borderRadius:10,padding:"11px 13px",color:D.textPrimary,fontSize:13,outline:"none"}}/>
          </div>
        ))}
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>PLAYING HAND</div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>set("hand","Right")} style={{flex:1,padding:"10px",borderRadius:22,border:"1.5px solid "+(form.hand==="Right"?D.accent:D.border),background:form.hand==="Right"?D.accentBg:"transparent",color:form.hand==="Right"?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>Right Hand</button>
            <button onClick={()=>set("hand","Left")} style={{flex:1,padding:"10px",borderRadius:22,border:"1.5px solid "+(form.hand==="Left"?D.accent:D.border),background:form.hand==="Left"?D.accentBg:"transparent",color:form.hand==="Left"?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>Left Hand</button>
          </div>
        </div>
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>GENDER</div>
          <div style={{display:"flex",gap:8}}>
            {["Male","Female","Other"].map(g=>(
              <button key={g} onClick={()=>set("gender",form.gender===g?"":g)} style={{flex:1,padding:"10px",borderRadius:22,border:"1.5px solid "+(form.gender===g?D.accent:D.border),background:form.gender===g?D.accentBg:"transparent",color:form.gender===g?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>{g}</button>
            ))}
          </div>
        </div>
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>SKILL LEVEL (OPTIONAL) · 2.0 – 8.0</div>
          <input type="number" step="0.1" min="2" max="8" value={form.singlesRating??3}
            onChange={e=>{const v=clamp(parseFloat(e.target.value)||3,2,8);setForm(f=>({...f,rating:v,singlesRating:v,doublesRating:v}));}}
            style={{width:"100%",background:D.surface,border:"1px solid "+D.border,borderRadius:10,padding:"11px 13px",color:D.textPrimary,fontSize:13,outline:"none"}}/>
        </div>
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>CATEGORIES (a player can belong to more than one)</div>
          {categories.length===0
            ? <div style={{fontSize:11,color:D.textMuted}}>No categories yet — create one from New Match → Categories.</div>
            : <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {categories.map(c=>{
                  const on=(form.categories||[]).includes(c.id);
                  return(
                    <button key={c.id} onClick={()=>set("categories", on?(form.categories||[]).filter(x=>x!==c.id):[...(form.categories||[]),c.id])} style={{padding:"7px 13px",borderRadius:22,border:"1.5px solid "+(on?D.accent:D.border),background:on?D.accentBg:"transparent",color:on?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                      <span style={{width:8,height:8,borderRadius:4,background:c.color||D.accent,display:"inline-block"}}/>{c.name}
                    </button>
                  );
                })}
              </div>}
        </div>
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>TEAM</div>
          {teams.length===0
            ? <div style={{fontSize:11,color:D.textMuted}}>No teams yet — create one from New Match → Teams.</div>
            : <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                <button onClick={()=>set("teamId",null)} style={{padding:"7px 13px",borderRadius:22,border:"1.5px solid "+(!form.teamId?D.accent:D.border),background:!form.teamId?D.accentBg:"transparent",color:!form.teamId?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>None</button>
                {teams.map(t=>(
                  <button key={t.id} onClick={()=>set("teamId",t.id)} style={{padding:"7px 13px",borderRadius:22,border:"1.5px solid "+(form.teamId===t.id?D.accent:D.border),background:form.teamId===t.id?D.accentBg:"transparent",color:form.teamId===t.id?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
                    <span style={{width:8,height:8,borderRadius:4,background:t.color||D.blue,display:"inline-block"}}/>{t.name}
                  </button>
                ))}
              </div>}
        </div>
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>ACCOUNT LINK</div>
          {player.linkedUserId ? (
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 13px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:10,color:D.accent,fontWeight:700,fontSize:12}}>
              🔗 Linked to a registered account
            </div>
          ) : !showLinkSearch ? (
            <button onClick={()=>setShowLinkSearch(true)} style={{width:"100%",padding:"10px",borderRadius:22,border:"1.5px solid "+D.border,background:D.surface,color:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>🔍 Link to Registered Account</button>
          ) : (
            <Card padding={12}>
              <input value={linkQuery} onChange={e=>setLinkQuery(e.target.value)} placeholder="Search by name or email…"
                style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"9px 12px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:8}}/>
              {linkResults.length===0&&<div style={{fontSize:12,color:D.textMuted,padding:"6px 2px"}}>No registered accounts found.</div>}
              {linkResults.slice(0,20).map((d,i)=>(
                <div key={d.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 2px",borderTop:i?"1px solid "+D.border:"none"}}>
                  <Avatar name={d.name} photo={d.photo} size={30} color={D.accent}/>
                  <div style={{flex:1,minWidth:0,fontSize:13,fontWeight:600,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{d.name}</div>
                  <button onClick={()=>setConfirmLinkAccount(d)} style={{padding:"6px 12px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>Link</button>
                </div>
              ))}
            </Card>
          )}
        </div>
        <div style={{marginBottom:13}}>
          <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:8}}>DUPR ID</div>
          {duprId ? (
            <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 13px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:10,color:D.accent,fontWeight:700,fontSize:12}}>
              🏓 Linked to DUPR ({duprId})
            </div>
          ) : !showDuprSearch ? (
            <button onClick={()=>setShowDuprSearch(true)} style={{width:"100%",padding:"10px",borderRadius:22,border:"1.5px solid "+D.border,background:D.surface,color:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>🔍 Search DUPR by Name</button>
          ) : (
            <Card padding={12}>
              <input value={duprQuery} onChange={e=>setDuprQuery(e.target.value)} placeholder="Player's full name…"
                onKeyDown={e=>e.key==="Enter"&&searchDupr()}
                style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:10,padding:"9px 12px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box",marginBottom:8}}/>
              {duprErr&&<div style={{fontSize:11,color:D.red,marginBottom:8}}>{duprErr}</div>}
              <button onClick={searchDupr} disabled={duprBusy} style={{width:"100%",padding:"9px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:12,cursor:duprBusy?"default":"pointer",opacity:duprBusy?.7:1,marginBottom:duprHits?8:0}}>{duprBusy?"Working…":"Search"}</button>
              {duprHits!==null && duprHits.length===0 && <div style={{fontSize:12,color:D.textMuted,padding:"4px 2px"}}>No DUPR players found for that name.</div>}
              {duprHits&&duprHits.map((hit,i)=>(
                <div key={hit.duprId} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 2px",borderTop:i?"1px solid "+D.border:"none"}}>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:600,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{hit.fullName}</div>
                    <div style={{fontSize:11,color:D.textMuted}}>DUPR {hit.duprId}{hit.doublesRating?" · "+hit.doublesRating+" DBL":""}{hit.singlesRating?" · "+hit.singlesRating+" SGL":""}</div>
                  </div>
                  <button onClick={()=>pickDupr(hit)} disabled={duprBusy} style={{padding:"6px 12px",background:D.accent,border:"none",borderRadius:18,color:"#fff",fontWeight:700,fontSize:11,cursor:duprBusy?"default":"pointer",flexShrink:0}}>Link</button>
                </div>
              ))}
            </Card>
          )}
        </div>
        <button onClick={()=>setConfirmDeletePlayer(true)} style={{width:"100%",padding:"11px",background:D.redBg,border:"1px solid "+D.red,borderRadius:22,color:D.red,fontWeight:700,fontSize:13,cursor:"pointer",marginTop:8}}>Remove Player</button>
      {confirmLinkAccount&&(
        <ConfirmDialog title={"Link "+player.name+" to "+confirmLinkAccount.name+"'s account?"}
          message="This carries forward all match history and cannot be undone." confirmLabel="Link Account"
          onConfirm={()=>{const d=confirmLinkAccount;setConfirmLinkAccount(null);onLinkAccount&&onLinkAccount(player.id,d.id);onClose();}}
          onCancel={()=>setConfirmLinkAccount(null)}/>
      )}
      {confirmDeletePlayer&&(
        <ConfirmDialog title={"Remove "+(player.name||"this player")+"?"} confirmLabel="Remove Player" destructive
          onConfirm={()=>{setConfirmDeletePlayer(false);onDelete(player.id);}}
          onCancel={()=>setConfirmDeletePlayer(false)}/>
      )}
    </Panel>
  );
}
