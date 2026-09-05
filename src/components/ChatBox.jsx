import { useState, useEffect, useRef } from "react";
import { D } from "../theme/tokens.js";
import { Card } from "./ui/Card.jsx";


// ================================================================
// CALENDAR / EVENTS — Reclub-style shared calendar (cloud events)
// ================================================================
// ================================================================
// CHAT BOX — shared chat for events & clubs (visible to everyone)
// ================================================================
export function ChatBox({scope,scopeId,messages,currentUser,onSend,height}){
  const [text,setText]=useState("");
  const endRef=useRef(null);
  const msgs=(messages||[]).filter(m=>m.scope===scope && m.scopeId===scopeId)
    .sort((a,b)=>String(a.ts||"").localeCompare(String(b.ts||"")));
  useEffect(()=>{ try{ endRef.current&&endRef.current.scrollIntoView({behavior:"smooth"}); }catch{ /* best-effort, safe to ignore */ } },[msgs.length]);
  const send=()=>{ const t=text.trim(); if(!t)return; onSend&&onSend(scope,scopeId,t); setText(""); };
  const timeOf=(ts)=>{ try{return new Date(ts).toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit"});}catch{return"";} };
  return(
    <Card padding={0} style={{display:"flex",flexDirection:"column",height:height||360,overflow:"hidden"}}>
      <div style={{flex:1,overflowY:"auto",padding:"12px"}}>
        {msgs.length===0&&<div style={{textAlign:"center",color:D.textMuted,fontSize:12,padding:"30px 10px"}}>💬 No messages yet. Say hello!</div>}
        {msgs.map(m=>{
          const mine=m.userId===currentUser?.id;
          return(
            <div key={m.id} style={{display:"flex",flexDirection:"column",alignItems:mine?"flex-end":"flex-start",marginBottom:10}}>
              {!mine&&<div style={{fontSize:10,fontWeight:700,color:D.textMuted,marginBottom:2,paddingLeft:4}}>{m.userName||"Player"}</div>}
              <div style={{maxWidth:"78%",padding:"8px 12px",borderRadius:14,fontSize:13,lineHeight:1.4,
                background:mine?D.accent:D.cardEl,color:mine?"#fff":D.textPrimary,
                borderBottomRightRadius:mine?4:14,borderBottomLeftRadius:mine?14:4,wordBreak:"break-word"}}>{m.text}</div>
              <div style={{fontSize:9,color:D.textLight,marginTop:2,padding:"0 4px"}}>{timeOf(m.ts)}</div>
            </div>
          );
        })}
        <div ref={endRef}/>
      </div>
      <div style={{display:"flex",gap:8,padding:"10px",borderTop:"1px solid "+D.border,background:D.bg}}>
        <input value={text} onChange={e=>setText(e.target.value)} onKeyDown={e=>e.key==="Enter"&&send()}
          placeholder="Type a message…" style={{flex:1,background:D.surface,border:"1px solid "+D.border,borderRadius:20,padding:"9px 14px",color:D.textPrimary,fontSize:13,outline:"none"}}/>
        <button onClick={send} style={{width:40,height:40,borderRadius:20,background:D.accent,border:"none",color:"#fff",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </Card>
  );
}
