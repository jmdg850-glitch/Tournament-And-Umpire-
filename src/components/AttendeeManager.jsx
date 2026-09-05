import { PLAY_META, ROLE_OPTS, PAY_OPTS, TEAM_COLORS } from "../screens/calendar/constants.js";
import { useState } from "react";
import { D } from "../theme/tokens.js";
import { FilterChipGroup } from "./ui/FilterChip.jsx";
import { Card } from "./ui/Card.jsx";


export function AttendeeManager({a,event,index,nameFor,onUpdate,onMakeParticipant,onRemove}){
  const [open,setOpen]=useState(false);
  const isPending=a.status==="pending";
  const ps=isPending?"pending":(a.playStatus||"confirmed");
  const meta=PLAY_META[ps]||PLAY_META.confirmed;
  const roles=a.roles||[];
  const label=a.isGuest?`${a.userName||"Guest"} · +1 of ${nameFor(a.guestOf)}`:(a.userName||nameFor(a.userId));
  const courtCount=event.capacity===Infinity||event.capacity==null?6:Math.max(4,Math.ceil(event.capacity/2));
  const toggleRole=(r)=>{ const has=roles.includes(r); onUpdate(a.userId,{roles:has?roles.filter(x=>x!==r):[...roles,r]}); };

  return(
    <Card padding={0} style={{marginBottom:8,overflow:"hidden"}}>
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px"}}>
        {index!=null&&<div style={{width:20,fontSize:11,fontWeight:800,color:D.textMuted,textAlign:"center",flexShrink:0}}>{index}</div>}
        <div style={{width:36,height:36,borderRadius:18,background:a.isGuest?D.amberBg:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,color:a.isGuest?D.amber:D.accent,fontSize:13,flexShrink:0}}>{a.isGuest?"+1":(label||"?").slice(0,2).toUpperCase()}</div>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
          <div style={{display:"flex",gap:5,alignItems:"center",marginTop:2,flexWrap:"wrap"}}>
            <span style={{fontSize:9,fontWeight:800,color:meta.color,background:meta.bg,borderRadius:8,padding:"1px 7px"}}>{meta.label}</span>
            {roles.map(r=><span key={r} style={{fontSize:9,fontWeight:700,color:D.purple,background:D.purpleBg,borderRadius:8,padding:"1px 6px"}}>{r}</span>)}
            {a.team&&<span style={{fontSize:9,fontWeight:700,color:"#fff",background:(TEAM_COLORS.find(t=>t.k===a.team)||{}).c||D.textMuted,borderRadius:8,padding:"1px 6px"}}>{a.team}</span>}
            {a.court&&<span style={{fontSize:9,fontWeight:700,color:D.blue,background:D.blueBg,borderRadius:8,padding:"1px 6px"}}>Court {a.court}</span>}
            {a.payment&&<span style={{fontSize:9,fontWeight:700,color:D.green,background:D.greenBg,borderRadius:8,padding:"1px 6px"}}>{a.payment}</span>}
          </div>
        </div>
        {isPending
          ? <button onClick={()=>onMakeParticipant(a.userId)} style={{padding:"7px 12px",background:D.accent,border:"none",borderRadius:20,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>Make Participant</button>
          : <button onClick={()=>setOpen(!open)} style={{padding:"6px 10px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:20,color:D.textSecondary,fontWeight:700,fontSize:11,cursor:"pointer",flexShrink:0}}>{open?"Close":"Manage"}</button>}
        <button onClick={()=>onRemove(a.userId)} style={{width:30,height:30,borderRadius:15,background:"transparent",border:"1px solid "+D.border,color:D.textMuted,fontSize:13,cursor:"pointer",flexShrink:0}}>✕</button>
      </div>

      {open&&!isPending&&(
        <div style={{padding:"4px 12px 14px",borderTop:"1px solid "+D.border}}>
          {/* Play status */}
          <div style={{fontSize:9,fontWeight:800,color:D.textMuted,letterSpacing:"1px",margin:"12px 0 6px"}}>STATUS</div>
          <FilterChipGroup
            options={[
              {value:"confirmed",label:"Confirmed to play",color:PLAY_META.confirmed.color},
              {value:"waitlist",label:"Put in waitlist",color:PLAY_META.waitlist.color},
              {value:"hold",label:"On Hold",color:PLAY_META.hold.color},
            ]}
            value={ps}
            onChange={(k)=>{
              if(k==="confirmed") onMakeParticipant(a.userId);
              else onUpdate(a.userId,{status:"going",playStatus:k});
            }}
            style={{flexWrap:"wrap"}}
          />
          {/* Roles */}
          <div style={{fontSize:9,fontWeight:800,color:D.textMuted,letterSpacing:"1px",margin:"12px 0 6px"}}>ROLES</div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
            {ROLE_OPTS.map(r=>(
              <button key={r} onClick={()=>toggleRole(r)} style={{padding:"6px 12px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",
                border:"1px solid "+(roles.includes(r)?D.purple:D.border),background:roles.includes(r)?D.purpleBg:D.surface,color:roles.includes(r)?D.purple:D.textSecondary}}>{r}</button>
            ))}
          </div>
          {/* Team */}
          <div style={{fontSize:9,fontWeight:800,color:D.textMuted,letterSpacing:"1px",margin:"12px 0 6px"}}>ASSIGN A TEAM</div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {TEAM_COLORS.map(t=>(
              <button key={t.k} onClick={()=>onUpdate(a.userId,{team:a.team===t.k?null:t.k})} title={t.k} style={{width:34,height:34,borderRadius:9,cursor:"pointer",background:t.c,
                border:a.team===t.k?"3px solid "+D.textPrimary:"1px solid "+D.border}}/>
            ))}
          </div>
          {/* Court */}
          <div style={{fontSize:9,fontWeight:800,color:D.textMuted,letterSpacing:"1px",margin:"12px 0 6px"}}>ASSIGN A COURT</div>
          <FilterChipGroup
            options={Array.from({length:courtCount}).map((_,i)=>({value:String(i+1),label:String(i+1)}))}
            value={a.court}
            onChange={(n)=>onUpdate(a.userId,{court:a.court===n?null:n})}
            color={D.blue}
            style={{flexWrap:"wrap"}}
          />
          {/* Payment */}
          <div style={{fontSize:9,fontWeight:800,color:D.textMuted,letterSpacing:"1px",margin:"12px 0 6px"}}>PAYMENT</div>
          <FilterChipGroup
            options={PAY_OPTS.map(p=>({value:p,label:p}))}
            value={a.payment}
            onChange={(p)=>onUpdate(a.userId,{payment:a.payment===p?null:p})}
            color={D.green}
            style={{flexWrap:"wrap"}}
          />
        </div>
      )}
    </Card>
  );
}
