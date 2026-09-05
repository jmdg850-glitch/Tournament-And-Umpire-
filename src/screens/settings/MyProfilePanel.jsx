import { useState, useRef } from "react";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { Btn } from "../../components/ui/Btn.jsx";
import { Input } from "../../components/ui/Input.jsx";
import { FieldLabel, SectionLabel } from "../../components/ui/Labels.jsx";
import { Panel } from "../../components/ui/Panel.jsx";
import { RatingHistorySpark } from "../../components/ui/RatingHistorySpark.jsx";
import { StatusBadge } from "../../components/ui/StatusBadge.jsx";
import { TogBtn } from "../../components/ui/TogBtn.jsx";
import { FilterChipGroup } from "../../components/ui/FilterChip.jsx";
import { DuprConnectionCard } from "./DuprConnectionCard.jsx";
import { buildStandings, getRankingPosition, ratingStatsFor } from "../../lib/standings.js";
import { fmtDate, ini, isStrongPassword, PASSWORD_HINT } from "../../lib/utils.js";
import { D, alpha } from "../../theme/tokens.js";



// =
// MY PROFILE PANEL — logged-in user's own profile
// =

export function MyProfilePanel({currentUser,doneMatches,players,onUpdate,onLogOut,onClose,notify,myIds=[]}){
  const [tab,setTab]=useState("profile");
  const [name,setName]=useState(currentUser.name||"");
  const [email,setEmail]=useState(currentUser.email||"");
  const [hand,setHand]=useState(currentUser.hand||"Right");
  const [photo,setPhoto]=useState(currentUser.photo||null);
  const [oldPw,setOldPw]=useState("");
  const [newPw,setNewPw]=useState("");
  const [newPw2,setNewPw2]=useState("");
  const [pwErr,setPwErr]=useState("");
  const photoRef=useRef(null);
  const pMatches=doneMatches.filter(m=>[...(m.teamA||[]),...(m.teamB||[])].some(id=>myIds.includes(id)));
  const wins=pMatches.filter(m=>(m.winner==="A"&&m.teamA?.some(id=>myIds.includes(id)))||(m.winner==="B"&&m.teamB?.some(id=>myIds.includes(id)))).length;
  // The `players[]` entry (not `currentUser`) is what endMatch() actually writes ratingHistory
  // to — look it up for confidence/highest/lowest/trend, alongside the live-derived pMatches/wins.
  const myPlayerEntry=players.find(p=>p.id===currentUser.id)||currentUser;
  const myStats=ratingStatsFor(myPlayerEntry,"singles");
  const myRank=getRankingPosition(currentUser.id, buildStandings(players, doneMatches, "singles"));
  const handlePhoto=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setPhoto(ev.target.result);r.readAsDataURL(f);};
  const saveProfile=()=>{
    if(!name.trim()){ notify("Full name is required.","err"); return; }
    onUpdate({name:name.trim(),email:email.trim(),hand,photo}); onClose();
  };
  const changePw=()=>{
    setPwErr("");
    if(!oldPw||!newPw){setPwErr("Fill in all password fields.");return;}
    if(oldPw!==currentUser.password){setPwErr("Current password is incorrect.");return;}
    if(!isStrongPassword(newPw)){setPwErr(PASSWORD_HINT);return;}
    if(newPw!==newPw2){setPwErr("New passwords don't match.");return;}
    onUpdate({password:newPw});
    setOldPw("");setNewPw("");setNewPw2("");
    notify("Password changed ✓");
  };
  return(
    <Panel title="My Profile" onClose={onClose}
      headerRight={
        <button onClick={()=>{onLogOut();onClose();}} className="press"
          style={{padding:"6px 12px",background:alpha(D.red,8),border:"1px solid "+alpha(D.red,21),borderRadius:8,color:D.red,fontSize:12,fontWeight:700,cursor:"pointer"}}>
          Sign Out
        </button>
      }>
      {/* Tabs */}
      <div style={{marginBottom:18}}>
        <FilterChipGroup
          options={[{value:"profile",label:"Profile"},{value:"stats",label:"My Stats"},{value:"password",label:"Password"}]}
          value={tab} onChange={setTab}
        />
      </div>

      {tab==="profile"&&(
        <>
          {/* Admin badge */}
          {currentUser.role==="admin"&&(
            <div style={{background:`${alpha(D.amber,7)}`,border:`1px solid ${alpha(D.amber,19)}`,borderRadius:14,padding:"14px 16px",marginBottom:16,display:"flex",alignItems:"center",gap:12}}>
              <div style={{width:40,height:40,borderRadius:10,background:`${alpha(D.amber,13)}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>⭐</div>
              <div>
                <div style={{fontWeight:800,fontSize:14,color:D.amber,marginBottom:2}}>Administrator Account</div>
                <div style={{fontSize:11,color:D.muted}}>Full system access · All features unlocked</div>
              </div>
            </div>
          )}
          {/* Avatar */}
          <div style={{display:"flex",justifyContent:"center",marginBottom:18}}>
            <div style={{position:"relative",cursor:"pointer"}} onClick={()=>photoRef.current?.click()}
              role="button" aria-label="Upload profile photo" tabIndex={0}
              onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();photoRef.current?.click();}}}>
              {photo
                ?<img src={photo} alt="" style={{width:80,height:80,borderRadius:40,objectFit:"cover",border:`3px solid ${D.blue}`}}/>
                :<div style={{width:80,height:80,borderRadius:40,background:`${alpha(D.blue,13)}`,border:`2px dashed ${D.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,fontWeight:800,color:D.blue}}>
                  {ini(name||"?")}
                </div>}
              <div style={{position:"absolute",bottom:0,right:0,width:24,height:24,borderRadius:12,background:D.blue,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,border:`2px solid ${D.bg}`}}>✏️</div>
              <input ref={photoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
            </div>
          </div>
          <Input label="FULL NAME" value={name} onChange={setName} placeholder="Your name"/>
          <Input label="EMAIL ADDRESS" value={email} onChange={setEmail} type="email" placeholder="you@email.com"/>
          <div style={{marginBottom:16}}>
            <FieldLabel>PLAYING HAND</FieldLabel>
            <div style={{display:"flex",gap:8}}>
              <TogBtn active={hand==="Right"} onClick={()=>setHand("Right")}>✋ Right</TogBtn>
              <TogBtn active={hand==="Left"} color={D.green} onClick={()=>setHand("Left")}>🤚 Left</TogBtn>
            </div>
          </div>
          <Btn label="Save Profile" onClick={saveProfile} full/>

          <div style={{marginTop:20,marginBottom:4}}><SectionLabel>DUPR</SectionLabel></div>
          <DuprConnectionCard notify={notify}/>

          <div style={{marginTop:12,padding:"12px 14px",background:`${alpha(D.red,3)}`,border:`1px solid ${alpha(D.red,15)}`,borderRadius:12}}>
            <div style={{fontSize:11,color:D.muted,marginBottom:8}}>Sign out of your account on this device.</div>
            <Btn label="Sign Out" onClick={()=>{onLogOut();onClose();}} outline color={D.red} full small/>
          </div>
        </>
      )}

      {tab==="stats"&&(
        <>
          <div style={{background:`${alpha(D.blue,7)}`,border:`1px solid ${alpha(D.blue,15)}`,borderRadius:14,padding:"18px",marginBottom:16,textAlign:"center"}}>
            <Avatar name={currentUser.name} photo={currentUser.photo} size={60} color={D.blue}/>
            <div style={{fontWeight:800,fontSize:18,color:D.white,marginTop:10,marginBottom:2}}>{currentUser.name}</div>
            <div style={{fontSize:11,color:D.muted}}>{currentUser.email}</div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
            {[{l:"Singles Rating",v:(+currentUser.singlesRating||3).toFixed(3),c:D.blue},
              {l:"Doubles Rating",v:(+currentUser.doublesRating||3).toFixed(3),c:D.green},
              {l:"Wins",v:wins,c:D.green},{l:"Losses",v:pMatches.length-wins,c:D.red},
              {l:"Matches Played",v:pMatches.length,c:D.amber},
              {l:"Win Rate",v:pMatches.length?Math.round((wins/pMatches.length)*100)+"%":"—",c:D.purple},
              {l:"Confidence",v:myStats.confidence+"%",c:D.purple},
              {l:"Rank",v:"#"+(myRank||"—"),c:D.blue},
              {l:"Highest Rating",v:myStats.highest.toFixed(3),c:D.green},
              {l:"Lowest Rating",v:myStats.lowest.toFixed(3),c:D.red}].map(s=>(
              <div key={s.l} style={{background:D.card,border:`1px solid ${D.border}`,borderRadius:12,padding:"13px",textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:900,color:s.c,lineHeight:1,marginBottom:4}}>{s.v}</div>
                <div style={{fontSize:9,color:D.muted,fontWeight:700,letterSpacing:"0.5px"}}>{s.l.toUpperCase()}</div>
              </div>
            ))}
          </div>
          {myPlayerEntry?.ratingHistory?.filter(h=>h.type==="singles").length>=2&&(
            <div style={{display:"flex",alignItems:"center",gap:12,background:D.card,border:`1px solid ${D.border}`,borderRadius:12,padding:"13px",marginBottom:16}}>
              <RatingHistorySpark history={myPlayerEntry.ratingHistory} type="singles" color={D.blue}/>
              <div style={{fontSize:11,color:D.muted,fontWeight:700}}>
                Singles rating trend · {myStats.trend==="up"?"📈 Trending up":myStats.trend==="down"?"📉 Trending down":"➡️ Stable"}
              </div>
            </div>
          )}
          <SectionLabel>RECENT MATCH HISTORY</SectionLabel>
          {pMatches.slice(0,6).map(m=>{
            const won=(m.winner==="A"&&m.teamA?.some(id=>myIds.includes(id)))||(m.winner==="B"&&m.teamB?.some(id=>myIds.includes(id)));
            const ws=m.winner==="A"?(m.finalScoreA||m.scoreA):(m.finalScoreB||m.scoreB);
            const ls=m.winner==="A"?(m.finalScoreB||m.scoreB):(m.finalScoreA||m.scoreA);
            return(
              <div key={m.id} style={{background:D.card,border:`1px solid ${D.border}`,borderRadius:11,padding:"10px 13px",marginBottom:6,display:"flex",alignItems:"center",gap:10}}>
                <StatusBadge status={won?"WIN":"LOSS"}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:12,fontWeight:600,color:D.off,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {m.isDoubles?"Doubles":"Singles"} · {m.courtName}
                  </div>
                  <div style={{fontSize:10,color:D.muted}}>{fmtDate(m.date)}</div>
                </div>
                <div style={{fontVariantNumeric:"tabular-nums",flexShrink:0}}>
                  <span style={{fontSize:15,fontWeight:900,color:won?D.green:D.red}}>{ws}</span>
                  <span style={{color:D.muted,margin:"0 3px",fontSize:11}}>–</span>
                  <span style={{fontSize:15,fontWeight:900,color:D.muted}}>{ls}</span>
                </div>
              </div>
            );
          })}
          {pMatches.length===0&&<div style={{textAlign:"center",padding:"24px",color:D.muted,fontSize:13}}>No matches yet — get on the court!</div>}
        </>
      )}

      {tab==="password"&&(
        <div>
          <div style={{background:`${alpha(D.amber,6)}`,border:`1px solid ${alpha(D.amber,15)}`,borderRadius:12,padding:"12px 14px",marginBottom:16}}>
            <div style={{fontSize:12,color:D.muted,lineHeight:1.6}}>🔒 {PASSWORD_HINT}</div>
          </div>
          <Input label="CURRENT PASSWORD" value={oldPw} onChange={setOldPw} type="password" placeholder="••••••••"/>
          <Input label="NEW PASSWORD" value={newPw} onChange={setNewPw} type="password" placeholder="Min. 8 characters, mixed case + number"/>
          <Input label="CONFIRM NEW PASSWORD" value={newPw2} onChange={setNewPw2} type="password" placeholder="Re-enter new password"/>
          {pwErr&&<div style={{background:`${alpha(D.red,7)}`,border:`1px solid ${alpha(D.red,19)}`,borderRadius:9,padding:"10px 12px",color:D.red,fontSize:12,marginBottom:12,fontWeight:600}}>{pwErr}</div>}
          <Btn label="Change Password" onClick={changePw} full/>
        </div>
      )}
    </Panel>
  );
}
