import { useState } from "react";
import { motion } from "framer-motion";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { Cloud } from "../../lib/cloud.js";
import { D } from "../../theme/tokens.js";
import { listVariants, itemVariants } from "../../theme/motion.js";


// ================================================================
// PLAYERS SCREEN — light theme network view
// ================================================================
export function PlayersScreen({nearby,doneMatches,onView,friends,onFriendReq,currentUser,onAccept,onDecline,onRemove}){
  const [tab,setTab]=useState("discover");
  const [q,setQ]=useState("");
  const COLS=[D.accent,D.blue,D.amber,D.purple,D.green,D.red];

  // pending requests TO current user
  const incoming=friends.filter(f=>f.to===currentUser?.id&&f.status==="pending");
  // accepted friends
  const myFriends=friends.filter(f=>(f.from===currentUser?.id||f.to===currentUser?.id)&&f.status==="accepted");
  const friendIds=new Set(myFriends.map(f=>f.from===currentUser?.id?f.to:f.from));
  // sent requests
  const sentIds=new Set(friends.filter(f=>f.from===currentUser?.id&&f.status==="pending").map(f=>f.to));

  const getFriendStatus=(pid)=>{
    if(friendIds.has(pid)) return "friends";
    if(sentIds.has(pid)) return "sent";
    const inc=friends.find(f=>f.from===pid&&f.to===currentUser?.id&&f.status==="pending");
    if(inc) return "incoming";
    return "none";
  };

  const filtered=nearby.filter(p=>
    p.name.toLowerCase().includes(q.toLowerCase())||
    (p.email||"").toLowerCase().includes(q.toLowerCase())
  );

  return(
    <div style={{background:D.bg,height:"100%",display:"flex",flexDirection:"column"}}>
      {/* Search bar */}
      <div style={{padding:"14px 14px 0",background:D.surface,borderBottom:"1px solid "+D.border,flexShrink:0}}>
        <div style={{fontWeight:900,fontSize:20,color:D.textPrimary,marginBottom:10}}>My Network</div>
        <div style={{position:"relative",marginBottom:12}}>
          <svg style={{position:"absolute",left:12,top:"50%",transform:"translateY(-50%)",color:D.textMuted}} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input value={q} onChange={e=>setQ(e.target.value)} placeholder="Search players by name or email..."
            style={{width:"100%",background:D.cardEl,border:"1px solid "+D.border,borderRadius:24,padding:"10px 14px 10px 36px",color:D.textPrimary,fontSize:13,outline:"none",boxSizing:"border-box"}}/>
        </div>
        {/* Tabs */}
        <div style={{display:"flex",gap:0}}>
          {[{id:"discover",l:"Nearby Players"},{id:"friends",l:"Friends"+(myFriends.length?" ("+myFriends.length+")":"")},{id:"requests",l:"Requests"+(incoming.length?" ("+incoming.length+")":"")}].map(t=>(
            <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"10px 4px 9px",background:"transparent",border:"none",borderBottom:"2px solid "+(tab===t.id?D.accent:"transparent"),color:tab===t.id?D.accent:D.textSecondary,fontWeight:tab===t.id?700:500,fontSize:12,cursor:"pointer",position:"relative"}}>
              {t.l}
              {t.id==="requests"&&incoming.length>0&&<span style={{position:"absolute",top:6,right:8,width:8,height:8,borderRadius:4,background:D.red,display:"inline-block"}}/>}
            </button>
          ))}
        </div>
      </div>

      <div style={{flex:1,overflowY:"auto",padding:"12px 14px 80px"}}>
        {/* NEARBY PLAYERS tab — registered accounts only, friend-add only */}
        {tab==="discover"&&(
          <>
            <div style={{fontSize:11,color:Cloud.enabled?D.green:D.textMuted,marginBottom:10,fontWeight:600,display:"flex",alignItems:"center",gap:6}}>
              <span style={{width:7,height:7,borderRadius:4,background:Cloud.enabled?D.green:D.textLight,display:"inline-block"}}/>
              {Cloud.enabled?"Synced · showing registered players across all devices":"Local only · connect Supabase to find registered players"}
            </div>
            {filtered.length===0&&(
              <Card padding="40px 20px" style={{textAlign:"center"}}>
                <div style={{fontSize:40,marginBottom:10}}>👥</div>
                <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>{q?"No matches":"No nearby players yet"}</div>
                <div style={{fontSize:12,color:D.textSecondary}}>{q?"Try a different search.":"Registered players will show up here once they join."}</div>
              </Card>
            )}
            <motion.div variants={listVariants} initial="hidden" animate="show">
            {filtered.map((p,i)=>{
              const status=getFriendStatus(p.id);
              const col=COLS[i%COLS.length];
              const pMatches=doneMatches.filter(m=>[...(m.teamA||[]),...(m.teamB||[])].includes(p.id));
              const wins=pMatches.filter(m=>(m.winner==="A"&&m.teamA?.includes(p.id))||(m.winner==="B"&&m.teamB?.includes(p.id))).length;
              return(
                <motion.div key={p.id} variants={itemVariants} style={{background:D.surface,border:"1px solid "+D.border,borderRadius:14,padding:"13px 14px",marginBottom:8,display:"flex",alignItems:"center",gap:12,boxShadow:"0 1px 3px rgba(0,0,0,.05)"}}>
                  <div style={{cursor:"pointer",flexShrink:0}} onClick={()=>onView(p.id)}>
                    <Avatar name={p.name} photo={p.photo} size={46} color={col}/>
                  </div>
                  <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>onView(p.id)}>
                    <div style={{fontSize:14,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                    <div style={{fontSize:11,color:D.textSecondary}}>{wins}W · {pMatches.length-wins}L · {(+p.singlesRating||3).toFixed(2)} rating</div>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    {status==="none"&&<button onClick={()=>onFriendReq(currentUser.id,p.id)} style={{padding:"7px 13px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:20,color:D.accent,fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>+ Add</button>}
                    {status==="sent"&&<span style={{padding:"7px 13px",background:D.cardEl,border:"1px solid "+D.border,borderRadius:20,color:D.textMuted,fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>Sent</span>}
                    {status==="friends"&&<span style={{padding:"7px 13px",background:D.greenBg,border:"1px solid "+D.green,borderRadius:20,color:D.green,fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>Friends</span>}
                    {status==="incoming"&&<button onClick={()=>{const fr=friends.find(f=>f.from===p.id&&f.to===currentUser?.id);if(fr)onAccept(fr.id);}} style={{padding:"7px 13px",background:D.accent,border:"none",borderRadius:20,color:"#fff",fontWeight:700,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>Accept</button>}
                  </div>
                </motion.div>
              );
            })}
            </motion.div>
          </>
        )}

        {/* FRIENDS tab */}
        {tab==="friends"&&(
          <>
            {myFriends.length===0?(
              <Card padding="40px 20px" style={{textAlign:"center"}}>
                <div style={{fontSize:40,marginBottom:10}}>🤝</div>
                <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>No friends yet</div>
                <div style={{fontSize:12,color:D.textSecondary}}>Go to Nearby Players and add other players as friends.</div>
              </Card>
            ):myFriends.map(fr=>{
              const fId=fr.from===currentUser?.id?fr.to:fr.from;
              const p=nearby.find(x=>x.id===fId);
              if(!p)return null;
              const i=nearby.indexOf(p);
              const col=COLS[i%COLS.length];
              const pMatches=doneMatches.filter(m=>[...(m.teamA||[]),...(m.teamB||[])].includes(p.id));
              const wins=pMatches.filter(m=>(m.winner==="A"&&m.teamA?.includes(p.id))||(m.winner==="B"&&m.teamB?.includes(p.id))).length;
              return(
                <Card key={fr.id} padding="13px 14px" style={{marginBottom:8,display:"flex",alignItems:"center",gap:12}}>
                  <div style={{cursor:"pointer",flexShrink:0}} onClick={()=>onView(p.id)}>
                    <Avatar name={p.name} photo={p.photo} size={46} color={col}/>
                  </div>
                  <div style={{flex:1,minWidth:0,cursor:"pointer"}} onClick={()=>onView(p.id)}>
                    <div style={{fontSize:14,fontWeight:700,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.name}</div>
                    <div style={{fontSize:11,color:D.textSecondary}}>{wins}W · {pMatches.length-wins}L · {(+p.singlesRating||3).toFixed(2)}</div>
                  </div>
                  <button onClick={()=>onRemove(fr.id)} style={{padding:"7px 12px",background:D.redBg,border:"1px solid "+D.red,borderRadius:20,color:D.red,fontWeight:600,fontSize:11,cursor:"pointer",whiteSpace:"nowrap"}}>Remove</button>
                </Card>
              );
            })}
          </>
        )}

        {/* REQUESTS tab */}
        {tab==="requests"&&(
          <>
            {incoming.length===0?(
              <Card padding="40px 20px" style={{textAlign:"center"}}>
                <div style={{fontSize:40,marginBottom:10}}>📬</div>
                <div style={{fontWeight:700,color:D.textPrimary,marginBottom:4}}>No pending requests</div>
                <div style={{fontSize:12,color:D.textSecondary}}>Friend requests sent to you will appear here.</div>
              </Card>
            ):incoming.map(fr=>{
              const p=nearby.find(x=>x.id===fr.from);
              if(!p)return null;
              const i=nearby.indexOf(p);
              const col=COLS[i%COLS.length];
              return(
                <Card key={fr.id} style={{marginBottom:8}}>
                  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
                    <Avatar name={p.name} photo={p.photo} size={46} color={col}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:700,color:D.textPrimary}}>{p.name}</div>
                      <div style={{fontSize:11,color:D.textSecondary}}>Wants to be your friend</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>onAccept(fr.id)} style={{flex:1,padding:"9px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>Accept</button>
                    <button onClick={()=>onDecline(fr.id)} style={{flex:1,padding:"9px",background:D.surface,border:"1px solid "+D.border,borderRadius:22,color:D.textSecondary,fontWeight:600,fontSize:13,cursor:"pointer"}}>Decline</button>
                  </div>
                </Card>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
