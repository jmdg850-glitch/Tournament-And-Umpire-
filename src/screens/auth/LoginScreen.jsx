import { useState } from "react";
import logo from "../../assets/logo.png";
import { readErr } from "../../lib/cloud.js";
import { D, alpha } from "../../theme/tokens.js";


export function LoginScreen({onLogIn,onForgotPassword,onGoSignUp}){
  const [mode,setMode]=useState("login"); // login | forgot | forgotSent
  const [identifier,setIdentifier]=useState("");
  const [pass,setPass]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [fEmail,setFEmail]=useState("");
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);

  const submitLogin=async()=>{
    setErr("");
    if(!identifier.trim()){setErr("Please enter your username or email.");return;}
    if(!pass){setErr("Please enter your password.");return;}
    setLoading(true);
    try{ const res=await onLogIn({identifier:identifier.trim(),password:pass.trim()}); if(res.err){setErr(res.err);setLoading(false);} }
    catch{ setErr("Something went wrong. Please try again."); setLoading(false); }
  };
  const submitForgot=async()=>{
    setErr("");
    if(!fEmail.trim()||!fEmail.includes("@")){setErr("Please enter your registered email.");return;}
    setLoading(true);
    const r=await onForgotPassword(fEmail.trim());
    setLoading(false);
    if(r&&r.sent){ setMode("forgotSent"); }
    else setErr(readErr(r&&r.error,"Couldn't send the reset email. Please try again."));
  };
  const inp=(borderErr)=>({width:"100%",background:D.darkCard,border:"1.5px solid "+(borderErr?alpha(D.red,38):alpha(D.border,19)),borderRadius:"var(--r-md)",padding:"13px 15px",color:D.darkText,fontSize:14,outline:"none",boxSizing:"border-box",transition:"border-color .15s"});

  return(
    <div style={{background:`linear-gradient(160deg,${D.blueBg} 0%,${D.bg} 50%,${D.accentBg} 100%)`,minHeight:"100dvh",height:"100dvh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px",fontFamily:"var(--font-sans)",overflow:"hidden"}}>

      {/* Logo */}
      <div style={{textAlign:"center",marginBottom:32}}>
        <div style={{width:72,height:72,borderRadius:"var(--r-xl)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",boxShadow:`0 12px 40px ${alpha(D.accent,25)}`}}>
          <img src={logo} alt="PickleLive" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
        </div>
        <div style={{fontWeight:900,fontSize:28,color:D.textPrimary,letterSpacing:"-0.5px"}}>PickleLive</div>
        <div style={{fontSize:11,color:D.textSecondary,fontWeight:700,letterSpacing:"3px",marginTop:4}}>PRO EDITION</div>
      </div>

      {/* Card */}
      <div style={{width:"100%",maxWidth:380,background:D.dark,borderRadius:"var(--r-xl)",padding:"28px 24px 24px",boxShadow:"var(--sh-3)"}}>

        {mode==="forgotSent"?(
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:46,marginBottom:14}}>📬</div>
            <div style={{fontWeight:900,fontSize:22,color:D.darkText,marginBottom:8}}>Check your email</div>
            <div style={{fontSize:14,color:D.darkTextMuted,lineHeight:1.6,marginBottom:20}}>
              We've sent a password reset link to<br/><strong style={{color:D.darkText}}>{fEmail.trim()}</strong>.<br/>
              Open it and choose a new password.
            </div>
            <button onClick={()=>{setMode("login");setErr("");}} style={{background:"none",border:"none",color:D.accent,fontWeight:700,cursor:"pointer",fontSize:13}}>← Back to Sign In</button>
          </div>
        ):mode==="forgot"?(
          <>
            <div style={{fontWeight:900,fontSize:22,color:D.darkText,marginBottom:4}}>Forgot your password?</div>
            <div style={{fontSize:13,color:D.darkTextMuted,marginBottom:24}}>Enter your registered email and we'll send you a secure reset link.</div>
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:700,color:D.darkTextMuted,letterSpacing:"1.5px",marginBottom:7}}>EMAIL ADDRESS</div>
              <input type="email" value={fEmail} onChange={e=>{setFEmail(e.target.value);setErr("");}} placeholder="you@email.com" aria-label="Email Address"
                onKeyDown={e=>e.key==="Enter"&&submitForgot()} style={inp(err)}/>
            </div>
            {err&&(
              <div style={{background:alpha(D.red,9),border:"1px solid "+alpha(D.red,31),borderRadius:"var(--r-sm)",padding:"11px 14px",color:D.darkRed,fontSize:12,marginBottom:16,fontWeight:600,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:15}}>⚠️</span> {readErr(err,"Something went wrong.")}
              </div>
            )}
            <button onClick={submitForgot} disabled={loading}
              style={{width:"100%",padding:"14px",background:loading?D.darkDisabled:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-md)",color:"#fff",fontWeight:800,fontSize:15,cursor:loading?"default":"pointer",marginBottom:14,boxShadow:loading?"none":`0 6px 20px ${alpha(D.accent,25)}`}}>
              {loading?"Sending…":"Send reset link"}
            </button>
            <div style={{textAlign:"center"}}>
              <button onClick={()=>{setMode("login");setErr("");}} style={{background:"none",border:"none",color:D.darkTextMuted,fontWeight:600,cursor:"pointer",fontSize:12}}>← Back to Sign In</button>
            </div>
          </>
        ):(
          <>
            <div style={{fontWeight:900,fontSize:22,color:D.darkText,marginBottom:4}}>Welcome back</div>
            <div style={{fontSize:13,color:D.darkTextMuted,marginBottom:24}}>Sign in to your PickleLive account</div>

            {/* Username or Email */}
            <div style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:700,color:D.darkTextMuted,letterSpacing:"1.5px",marginBottom:7}}>USERNAME OR EMAIL</div>
              <input type="text" value={identifier} onChange={e=>{setIdentifier(e.target.value);setErr("");}} placeholder="username or you@email.com" aria-label="Username or Email"
                onKeyDown={e=>e.key==="Enter"&&submitLogin()} style={inp(err)}/>
            </div>

            {/* Password */}
            <div style={{marginBottom:8}}>
              <div style={{fontSize:10,fontWeight:700,color:D.darkTextMuted,letterSpacing:"1.5px",marginBottom:7}}>PASSWORD</div>
              <div style={{position:"relative"}}>
                <input type={showPw?"text":"password"} value={pass} onChange={e=>{setPass(e.target.value);setErr("");}} placeholder="Your password" aria-label="Password"
                  onKeyDown={e=>e.key==="Enter"&&submitLogin()} style={{...inp(err),padding:"13px 52px 13px 15px"}}/>
                <button onClick={()=>setShowPw(s=>!s)} aria-label={showPw?"Hide password":"Show password"} style={{position:"absolute",right:14,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:D.darkTextMuted,cursor:"pointer",fontSize:13,fontWeight:600,padding:0}}>{showPw?"Hide":"Show"}</button>
              </div>
            </div>

            {/* Forgot password */}
            <div style={{textAlign:"right",marginBottom:18}}>
              <button onClick={()=>{setMode("forgot");setErr("");}} style={{background:"none",border:"none",color:D.accent,fontWeight:600,cursor:"pointer",fontSize:12,padding:0}}>Forgot Password?</button>
            </div>

            {/* Error */}
            {err&&(
              <div style={{background:alpha(D.red,9),border:"1px solid "+alpha(D.red,31),borderRadius:"var(--r-sm)",padding:"11px 14px",color:D.darkRed,fontSize:12,marginBottom:16,fontWeight:600,display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:15}}>⚠️</span> {readErr(err,"Something went wrong.")}
              </div>
            )}

            {/* Sign In */}
            <button onClick={submitLogin} disabled={loading} className="press"
              style={{width:"100%",padding:"14px",background:loading?D.darkDisabled:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-md)",color:"#fff",fontWeight:800,fontSize:15,cursor:loading?"default":"pointer",marginBottom:18,boxShadow:loading?"none":`0 6px 20px ${alpha(D.accent,25)}`}}>
              {loading?"Signing in…":"Sign In"}
            </button>

            {/* Sign Up link */}
            <div style={{textAlign:"center",fontSize:13,color:D.darkTextMuted}}>
              Don't have an account?{" "}
              <button onClick={onGoSignUp} style={{background:"none",border:"none",color:D.accent,fontWeight:700,cursor:"pointer",fontSize:13}}>Sign Up</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
