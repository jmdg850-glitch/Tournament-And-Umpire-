import { useState } from "react";
import logo from "../../assets/logo.png";
import { readErr } from "../../lib/cloud.js";
import { D, alpha } from "../../theme/tokens.js";
import { isStrongPassword, PASSWORD_HINT } from "../../lib/utils.js";


// =
// RESET PASSWORD SCREEN — opened from the Supabase recovery email link
// =
export function ResetPasswordScreen({onSubmit,onDone,initialError}){
  const [nw,setNw]=useState(""); const [nw2,setNw2]=useState("");
  const [err,setErr]=useState(initialError||""); const [loading,setLoading]=useState(false); const [done,setDone]=useState(false);
  const linkBad=/invalid|expired|already used/i.test(initialError||"");
  const save=async()=>{
    setErr("");
    if(!isStrongPassword(nw)){setErr(PASSWORD_HINT);return;}
    if(nw!==nw2){setErr("Passwords do not match.");return;}
    setLoading(true);
    try{ const r=await onSubmit(nw); if(r&&r.err){ setErr(r.err); setLoading(false); return; } setDone(true); }
    catch{ setErr("Couldn't update the password."); }
    setLoading(false);
  };
  const inp=(b)=>({width:"100%",background:D.darkCard,border:"1.5px solid "+(b?alpha(D.red,38):alpha(D.border,19)),borderRadius:"var(--r-md)",padding:"13px 15px",color:D.darkText,fontSize:14,outline:"none",boxSizing:"border-box",marginBottom:12});
  return(
    <div style={{background:`linear-gradient(160deg,${D.blueBg} 0%,${D.bg} 50%,${D.accentBg} 100%)`,minHeight:"100dvh",height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px",fontFamily:"var(--font-sans)",overflow:"hidden"}}>
      <div style={{textAlign:"center",marginBottom:28}}>
        <div style={{width:72,height:72,borderRadius:"var(--r-xl)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",boxShadow:`0 12px 40px ${alpha(D.accent,25)}`}}>
          <img src={logo} alt="PickleLive" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
        </div>
        <div style={{fontWeight:900,fontSize:24,color:D.textPrimary,letterSpacing:"-0.5px"}}>Reset Password</div>
      </div>
      <div style={{width:"100%",maxWidth:380,background:D.dark,borderRadius:"var(--r-xl)",padding:"28px 24px 24px",boxShadow:"var(--sh-3)"}}>
        {done?(
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:12}}>✅</div>
            <div style={{fontSize:18,fontWeight:900,color:D.darkText,marginBottom:6}}>Password changed successfully</div>
            <div style={{fontSize:13,color:D.darkTextMuted,marginBottom:22}}>You can now sign in with your new password.</div>
            <button onClick={onDone} className="press" style={{width:"100%",padding:"14px",background:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-md)",color:"#fff",fontWeight:800,fontSize:15,cursor:"pointer"}}>Go to Sign In</button>
          </div>
        ):linkBad?(
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:44,marginBottom:12}}>⚠️</div>
            <div style={{fontSize:17,fontWeight:900,color:D.darkText,marginBottom:8}}>Reset link problem</div>
            <div style={{fontSize:13,color:D.darkRed,marginBottom:20,lineHeight:1.5}}>{readErr(initialError,"This reset link is invalid, already used, or expired.")}</div>
            <button onClick={onDone} className="press" style={{width:"100%",padding:"14px",background:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-md)",color:"#fff",fontWeight:800,fontSize:15,cursor:"pointer"}}>Back to Sign In</button>
          </div>
        ):(
          <>
            <div style={{fontWeight:900,fontSize:20,color:D.darkText,marginBottom:4}}>Choose a new password</div>
            <div style={{fontSize:13,color:D.darkTextMuted,marginBottom:22}}>Enter and confirm your new password.</div>
            <div style={{fontSize:10,fontWeight:700,color:D.darkTextMuted,letterSpacing:"1.5px",marginBottom:7}}>NEW PASSWORD</div>
            <input type="password" value={nw} onChange={e=>{setNw(e.target.value);setErr("");}} aria-label="New Password" style={inp(err)}/>
            <div style={{fontSize:10,fontWeight:700,color:D.darkTextMuted,letterSpacing:"1.5px",marginBottom:7}}>CONFIRM PASSWORD</div>
            <input type="password" value={nw2} onChange={e=>{setNw2(e.target.value);setErr("");}} aria-label="Confirm Password" style={inp(nw2&&nw!==nw2)}/>
            {err&&(
              <div style={{background:alpha(D.red,9),border:"1px solid "+alpha(D.red,31),borderRadius:"var(--r-sm)",padding:"11px 14px",color:D.darkRed,fontSize:12,marginBottom:14,fontWeight:600,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:15}}>⚠️</span> {readErr(err,"Something went wrong.")}
              </div>
            )}
            <button onClick={save} disabled={loading} className="press" style={{width:"100%",padding:"14px",background:loading?D.darkDisabled:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-md)",color:"#fff",fontWeight:800,fontSize:15,cursor:loading?"default":"pointer",boxShadow:loading?"none":`0 6px 20px ${alpha(D.accent,25)}`}}>
              {loading?"Saving…":"Change Password"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
