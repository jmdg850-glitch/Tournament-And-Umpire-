import { useState, useRef } from "react";
import { ini } from "../../lib/utils.js";
import { Panel } from "../../components/ui/Panel.jsx";
import { D, alpha } from "../../theme/tokens.js";


// Settings sub-panel: edit name/photo/phone/hand.
export function SettingsProfilePanel({currentUser,onUpdate,onClose,notify}){
  const [name,setName]=useState(currentUser.name||"");
  const [photo,setPhoto]=useState(currentUser.photo||null);
  const [hand,setHand]=useState(currentUser.hand||"Right");
  const [phone,setPhone]=useState(currentUser.phone||"");
  const photoRef=useRef(null);
  const handlePhoto=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setPhoto(ev.target.result);r.readAsDataURL(f);};
  const inp={width:"100%",background:D.cardEl,border:`1px solid ${D.border}`,borderRadius:"var(--r-sm)",padding:"11px 13px",color:D.textPrimary,fontSize:13,outline:"none",marginBottom:12};
  return(
    <Panel title="Edit Profile" onClose={onClose}
      headerRight={<button onClick={()=>{if(!name.trim()){notify("Full name is required.","err");return;}onUpdate({name:name.trim(),photo,hand,phone});notify("Profile saved ✓");}} className="press" style={{padding:"8px 18px",background:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-sm)",color:"#fff",fontWeight:800,fontSize:13,cursor:"pointer"}}>Save</button>}>
        <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
          <div style={{position:"relative",cursor:"pointer"}} onClick={()=>photoRef.current?.click()}
            role="button" aria-label="Upload profile photo" tabIndex={0}
            onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();photoRef.current?.click();}}}>
            {photo?<img src={photo} style={{width:80,height:80,borderRadius:40,objectFit:"cover",border:`3px solid ${D.accent}`}}/>
              :<div style={{width:80,height:80,borderRadius:40,background:alpha(D.accent,13),border:`2px dashed ${D.border}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,fontWeight:800,color:D.accent}}>{ini(name||"?")}</div>}
            <div style={{position:"absolute",bottom:0,right:0,width:24,height:24,borderRadius:12,background:D.accent,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,border:`2px solid ${D.surface}`}}>✏️</div>
            <input ref={photoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
          </div>
        </div>
        <div style={{fontSize:10,fontWeight:700,color:D.textSecondary,letterSpacing:"1px",marginBottom:6}}>FULL NAME</div>
        <input value={name} onChange={e=>setName(e.target.value)} placeholder="Your full name" aria-label="Full Name" style={inp}/>
        <div style={{fontSize:10,fontWeight:700,color:D.textSecondary,letterSpacing:"1px",marginBottom:6}}>PHONE</div>
        <input value={phone} onChange={e=>setPhone(e.target.value)} placeholder="+63 912 345 6789" aria-label="Phone" style={inp}/>
        <div style={{fontSize:10,fontWeight:700,color:D.textSecondary,letterSpacing:"1px",marginBottom:8}}>PLAYING HAND</div>
        <div style={{display:"flex",gap:8}}>
          {["Right","Left"].map(h=><button key={h} onClick={()=>setHand(h)} className="press" style={{flex:1,padding:"10px",borderRadius:"var(--r-sm)",border:`1.5px solid ${hand===h?D.accent:D.border}`,background:hand===h?alpha(D.accent,9):D.cardEl,color:hand===h?D.accent:D.textSecondary,fontWeight:700,fontSize:12,cursor:"pointer"}}>{h==="Right"?"✋ Right":"🤚 Left"}</button>)}
        </div>
    </Panel>
  );
}
