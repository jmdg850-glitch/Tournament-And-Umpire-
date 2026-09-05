import { useState } from "react";
import { readErr } from "../../lib/cloud.js";
import { Panel } from "../../components/ui/Panel.jsx";
import { D } from "../../theme/tokens.js";
import { isStrongPassword, PASSWORD_HINT } from "../../lib/utils.js";


export function SettingsPasswordPanel({currentUser,onChangePassword,onClose,notify}){
  const [nw,setNw]=useState(""); const [nw2,setNw2]=useState("");
  const [done,setDone]=useState(false);
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);

  const save=async()=>{
    setErr("");
    if(!isStrongPassword(nw))return setErr(PASSWORD_HINT);
    if(nw!==nw2)return setErr("New passwords don't match.");
    setLoading(true);
    try{
      const r=await onChangePassword(nw);
      if(r&&r.err){ setErr(r.err); setLoading(false); return; }
      setDone(true); notify&&notify("Password changed ✓");
    }catch{ setErr("Could not update the password."); }
    setLoading(false);
  };

  const inp={width:"100%",background:D.surface,border:"1px solid "+D.border,borderRadius:10,padding:"12px 13px",color:D.textPrimary,fontSize:14,outline:"none",marginBottom:12,boxSizing:"border-box"};
  return(
    <Panel title="Change Password" onClose={onClose}>
        {done?(
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div style={{fontSize:16,fontWeight:800,color:D.textPrimary,marginBottom:6}}>Password changed</div>
            <div style={{fontSize:13,color:D.textSecondary,marginBottom:22}}>You can use it if you sign in with a password.</div>
            <button onClick={onClose} style={{width:"100%",padding:"13px",background:D.accent,border:"none",borderRadius:12,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer"}}>Done</button>
          </div>
        ):(
          <>
            <div style={{fontSize:13,color:D.textSecondary,marginBottom:18,lineHeight:1.5}}>Set a new password for <b style={{color:D.textPrimary}}>{currentUser?.email}</b>.</div>
            <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>NEW PASSWORD</div>
            <input type="password" value={nw} onChange={e=>setNw(e.target.value)} aria-label="New Password" style={inp}/>
            <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1px",marginBottom:6}}>CONFIRM NEW PASSWORD</div>
            <input type="password" value={nw2} onChange={e=>setNw2(e.target.value)} aria-label="Confirm New Password" style={{...inp,border:"1px solid "+(nw2&&nw!==nw2?D.red:D.border)}}/>
            <button onClick={save} disabled={loading} style={{width:"100%",padding:"13px",background:D.accent,border:"none",borderRadius:12,color:"#fff",fontWeight:800,fontSize:14,cursor:"pointer",opacity:loading?.7:1}}>{loading?"Saving…":"Change Password"}</button>
            {err&&<div style={{background:D.redBg,border:"1px solid "+D.red,borderRadius:10,padding:"10px 12px",color:D.red,fontSize:12,marginTop:14}}>{readErr(err,"Something went wrong.")}</div>}
          </>
        )}
    </Panel>
  );
}
