import { useState, useRef } from "react";
import logo from "../../assets/logo.png";
import { COUNTRIES, COUNTRY_CODES } from "./countries.js";
import { D, alpha } from "../../theme/tokens.js";
import { isStrongPassword, PASSWORD_HINT } from "../../lib/utils.js";



// =
// SIGN-UP SCREEN — Full Name, Username, Email, Password, Confirm Password
// =
export function SignUpScreen({onSignUp,onGoLogin}){
  // Form fields
  const [name,setName]=useState("");
  const [username,setUsername]=useState("");
  const [email,setEmail]=useState("");
  const [pass,setPass]=useState("");
  const [pass2,setPass2]=useState("");
  const [showPw,setShowPw]=useState(false);
  const [age,setAge]=useState("");
  const [sex,setSex]=useState("");
  const [address,setAddress]=useState("");
  const [country,setCountry]=useState("Philippines");
  const [countryCode,setCountryCode]=useState("+63");
  const [phone,setPhone]=useState("");
  const [terms,setTerms]=useState(false);
  const [showCcPicker,setShowCcPicker]=useState(false);
  const [showCountryPicker,setShowCountryPicker]=useState(false);
  const [photo,setPhoto]=useState(null);
  const [err,setErr]=useState("");
  const [loading,setLoading]=useState(false);
  const [confirm,setConfirm]=useState(false);
  const photoRef=useRef(null);

  const handlePhoto=e=>{const f=e.target.files?.[0];if(!f)return;const r=new FileReader();r.onload=ev=>setPhoto(ev.target.result);r.readAsDataURL(f);};

  const handleSubmit=async()=>{
    setErr("");
    if(!name.trim())return setErr("Full name is required.");
    if(!username.trim())return setErr("Username is required.");
    if(!/^[a-zA-Z0-9_.]{3,20}$/.test(username.trim()))return setErr("Username must be 3–20 letters, numbers, _ or .");
    if(!email.trim()||!email.includes("@"))return setErr("Valid email address required.");
    if(!isStrongPassword(pass))return setErr(PASSWORD_HINT);
    if(pass!==pass2)return setErr("Passwords do not match.");
    if(!age||isNaN(age)||+age<5||+age>120)return setErr("Please enter a valid age.");
    if(!sex)return setErr("Please select your sex.");
    if(!address.trim())return setErr("Address is required.");
    if(!phone.trim())return setErr("Phone number is required.");
    if(!terms)return setErr("You must agree to the Terms and Conditions.");
    setLoading(true);
    try {
      const res=await onSignUp({name:name.trim(),username:username.trim(),email:email.trim(),password:pass,
        age:+age,sex,address:address.trim(),country,phone:`${countryCode}${phone}`,photo,hand:"Right"});
      if(res&&res.err){ setErr(res.err); return; }
      if(res&&res.confirm){ setConfirm(true); return; }
      // else: signUp set currentUser and the app moves on automatically.
    } catch {
      setErr("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const ini2=n=>!n?.trim()?"📷":n.trim().split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase();

  const S={ // local style helpers
    page:{background:D.bg,minHeight:"100dvh",overflowY:"auto",fontFamily:"var(--font-sans)"},
    card:{background:D.dark,border:"1px solid rgba(255,255,255,.08)",borderRadius:"var(--r-xl)",padding:"24px 20px",width:"100%",maxWidth:400,boxShadow:"var(--sh-3)"},
    label:{fontSize:10,fontWeight:700,color:D.darkTextMuted,letterSpacing:"1px",marginBottom:5,display:"block"},
    input:{width:"100%",background:D.darkCard,border:"1px solid rgba(255,255,255,.08)",borderRadius:"var(--r-sm)",padding:"11px 13px",color:D.darkText,fontSize:13,outline:"none",boxSizing:"border-box"},
    btn:{width:"100%",padding:"13px",background:`linear-gradient(135deg,${D.accent},${D.accentHi})`,border:"none",borderRadius:"var(--r-md)",color:"#fff",fontWeight:800,fontSize:15,cursor:"pointer",boxShadow:`0 4px 16px ${alpha(D.accent,25)}`},
    err:{background:alpha(D.red,9),border:"1px solid "+alpha(D.red,25),borderRadius:"var(--r-sm)",padding:"10px 12px",color:D.red,fontSize:12,marginBottom:14,fontWeight:600},
  };

  if(confirm) return(
    <div style={{...S.page,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px"}}>
      <div style={S.card}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:46,marginBottom:14}}>📬</div>
          <div style={{fontWeight:900,fontSize:20,color:D.darkText,marginBottom:8}}>Confirm your email</div>
          <div style={{fontSize:13,color:D.darkTextMuted,lineHeight:1.6,marginBottom:18}}>
            Your account was created. We sent a confirmation link to<br/>
            <strong style={{color:D.darkText}}>{email}</strong>.<br/>
            Tap it, then sign in with your username or email and password.
          </div>
          <button onClick={onGoLogin} className="press" style={{...S.btn}}>Go to Sign In</button>
        </div>
      </div>
    </div>
  );

  return(
    <div style={{...S.page,padding:"20px 20px 60px"}}>
      <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
        {/* Logo */}
        <div style={{textAlign:"center",padding:"24px 0 20px"}}>
          <div style={{width:52,height:52,borderRadius:"var(--r-lg)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 10px",boxShadow:`0 6px 24px ${alpha(D.accent,25)}`}}>
            <img src={logo} alt="PickleLive" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
          </div>
          <div style={{fontWeight:900,fontSize:22,color:D.textPrimary}}>Create Account</div>
          <div style={{fontSize:12,color:D.textSecondary,marginTop:3}}>Join PickleLive Pro · It's free</div>
        </div>
        <div style={S.card}>
          {/* Avatar */}
          <div style={{display:"flex",justifyContent:"center",marginBottom:20}}>
            <div style={{position:"relative",cursor:"pointer"}} onClick={()=>photoRef.current?.click()}
              role="button" aria-label="Upload profile photo" tabIndex={0}
              onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();photoRef.current?.click();}}}>
              {photo
                ?<img src={photo} alt="" style={{width:76,height:76,borderRadius:38,objectFit:"cover",border:`3px solid ${D.accent}`}}/>
                :<div style={{width:76,height:76,borderRadius:38,background:D.darkCard,border:"2px dashed rgba(255,255,255,.15)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:name?18:22,fontWeight:800,color:D.accent}}>
                  {ini2(name)}
                </div>}
              <div style={{position:"absolute",bottom:0,right:0,width:24,height:24,borderRadius:12,background:D.accent,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,border:`2px solid ${D.dark}`}}>✏️</div>
              <input ref={photoRef} type="file" accept="image/*" style={{display:"none"}} onChange={handlePhoto}/>
            </div>
          </div>

          {/* Full Name */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-name" style={S.label}>FULL NAME <span style={{color:D.red}}>*</span></label>
            <input id="su-name" value={name} onChange={e=>setName(e.target.value)} placeholder="Juan dela Cruz" style={S.input}/>
          </div>

          {/* Username */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-username" style={S.label}>USERNAME <span style={{color:D.red}}>*</span></label>
            <input id="su-username" value={username} onChange={e=>setUsername(e.target.value.replace(/\s/g,""))} placeholder="juandc" style={S.input}/>
          </div>

          {/* Email */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-email" style={S.label}>EMAIL ADDRESS <span style={{color:D.red}}>*</span></label>
            <input id="su-email" type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@email.com" style={S.input}/>
          </div>

          {/* Password */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-pass" style={S.label}>PASSWORD <span style={{color:D.red}}>*</span></label>
            <div style={{position:"relative"}}>
              <input id="su-pass" type={showPw?"text":"password"} value={pass} onChange={e=>setPass(e.target.value)} placeholder="Min. 8 characters, mixed case + number" style={{...S.input,paddingRight:50}}/>
              <button onClick={()=>setShowPw(s=>!s)} aria-label={showPw?"Hide password":"Show password"} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:D.darkTextMuted,cursor:"pointer",fontSize:12,fontWeight:600}}>{showPw?"Hide":"Show"}</button>
            </div>
          </div>

          {/* Confirm Password */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-pass2" style={S.label}>CONFIRM PASSWORD <span style={{color:D.red}}>*</span></label>
            <input id="su-pass2" type="password" value={pass2} onChange={e=>setPass2(e.target.value)} placeholder="Re-enter password"
              style={{...S.input,border:`1px solid ${pass2&&pass!==pass2?D.red:"rgba(255,255,255,.08)"}`}}/>
            {pass2&&pass!==pass2&&<div style={{fontSize:11,color:D.red,marginTop:3}}>Passwords don't match</div>}
          </div>

          {/* Age + Sex row */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
            <div>
              <label htmlFor="su-age" style={S.label}>AGE <span style={{color:D.red}}>*</span></label>
              <input id="su-age" type="number" value={age} onChange={e=>setAge(e.target.value)} placeholder="25" min={5} max={120} style={S.input}/>
            </div>
            <div>
              <label htmlFor="su-sex" style={S.label}>SEX <span style={{color:D.red}}>*</span></label>
              <select id="su-sex" value={sex} onChange={e=>setSex(e.target.value)}
                style={{...S.input,appearance:"none",cursor:"pointer"}}>
                <option value="">Select…</option>
                <option value="Male">Male</option>
                <option value="Female">Female</option>
                <option value="Non-binary">Non-binary</option>
                <option value="Prefer not to say">Prefer not to say</option>
              </select>
            </div>
          </div>

          {/* Address */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-address" style={S.label}>ADDRESS <span style={{color:D.red}}>*</span></label>
            <input id="su-address" value={address} onChange={e=>setAddress(e.target.value)} placeholder="Street, City, Province" style={S.input}/>
          </div>

          {/* Country */}
          <div style={{marginBottom:12,position:"relative"}}>
            <label htmlFor="su-country" style={S.label}>COUNTRY <span style={{color:D.red}}>*</span></label>
            <button id="su-country" onClick={()=>setShowCountryPicker(s=>!s)} style={{...S.input,display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer",color:country?D.darkText:D.darkTextMuted}}>
              <span>{country||"Select country…"}</span>
              <span style={{fontSize:10,color:D.darkTextMuted}}>{showCountryPicker?"▲":"▼"}</span>
            </button>
            {showCountryPicker&&(
              <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,right:0,background:D.darkCard,border:"1px solid rgba(255,255,255,.08)",borderRadius:"var(--r-md)",maxHeight:180,overflowY:"auto",zIndex:100,boxShadow:"var(--sh-3)"}}>
                {COUNTRIES.map(cn=>(
                  <button key={cn} onClick={()=>{setCountry(cn);setShowCountryPicker(false);}}
                    style={{width:"100%",padding:"10px 14px",background:country===cn?alpha(D.accent,9):"transparent",border:"none",color:country===cn?D.accent:D.darkTextMuted,textAlign:"left",cursor:"pointer",fontSize:13,fontWeight:country===cn?700:400}}>
                    {cn}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Phone with country code picker */}
          <div style={{marginBottom:12}}>
            <label htmlFor="su-phone" style={S.label}>PHONE NUMBER <span style={{color:D.red}}>*</span></label>
            <div style={{display:"flex",gap:8,position:"relative"}}>
              <button onClick={()=>setShowCcPicker(s=>!s)} aria-label={"Country code, currently "+countryCode}
                style={{flexShrink:0,background:D.darkCard,border:"1px solid rgba(255,255,255,.08)",borderRadius:"var(--r-sm)",padding:"11px 12px",color:D.darkText,fontSize:13,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:5,whiteSpace:"nowrap"}}>
                {COUNTRY_CODES.find(c=>c.code===countryCode)?.flag} {countryCode} <span style={{fontSize:10,color:D.darkTextMuted}}>{showCcPicker?"▲":"▼"}</span>
              </button>
              <input id="su-phone" value={phone} onChange={e=>setPhone(e.target.value.replace(/\D/g,""))} placeholder="912 345 6789"
                style={{...S.input,flex:1}}/>
              {showCcPicker&&(
                <div style={{position:"absolute",top:"calc(100% + 4px)",left:0,width:240,background:D.darkCard,border:"1px solid rgba(255,255,255,.08)",borderRadius:"var(--r-md)",maxHeight:200,overflowY:"auto",zIndex:100,boxShadow:"var(--sh-3)"}}>
                  {COUNTRY_CODES.map(cc=>(
                    <button key={cc.code} onClick={()=>{setCountryCode(cc.code);setShowCcPicker(false);}}
                      style={{width:"100%",padding:"9px 14px",background:countryCode===cc.code?alpha(D.accent,9):"transparent",border:"none",color:countryCode===cc.code?D.accent:D.darkTextMuted,textAlign:"left",cursor:"pointer",fontSize:12,display:"flex",gap:8,alignItems:"center"}}>
                      <span>{cc.flag}</span><span style={{fontWeight:700}}>{cc.code}</span><span>{cc.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Terms */}
          <div style={{marginBottom:18}}>
            <label style={{display:"flex",alignItems:"flex-start",gap:10,cursor:"pointer"}}>
              <div onClick={()=>setTerms(t=>!t)} role="checkbox" aria-checked={terms} aria-label="I agree to the Terms and Conditions and Privacy Policy" tabIndex={0}
                onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setTerms(t=>!t);}}}
                style={{width:20,height:20,borderRadius:5,border:`2px solid ${terms?D.accent:"rgba(255,255,255,.2)"}`,background:terms?D.accent:"transparent",flexShrink:0,marginTop:1,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",transition:"all .12s"}}>
                {terms&&<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>}
              </div>
              <span style={{fontSize:12,color:D.darkTextMuted,lineHeight:1.5}}>
                I agree to the <span style={{color:D.accent,fontWeight:700,cursor:"pointer"}}>Terms and Conditions</span> and <span style={{color:D.accent,fontWeight:700,cursor:"pointer"}}>Privacy Policy</span> of PickleLive Pro.
              </span>
            </label>
          </div>

          {err&&<div style={S.err}>{err}</div>}

          <button onClick={handleSubmit} disabled={loading} className="press" style={{...S.btn,marginBottom:14,opacity:loading?.6:1}}>
            {loading?"Creating account…":"Create Account"}
          </button>

          <div style={{textAlign:"center",fontSize:13,color:D.darkTextMuted}}>
            Already have an account?{" "}
            <button onClick={onGoLogin} style={{background:"none",border:"none",color:D.accent,fontWeight:700,cursor:"pointer",fontSize:13}}>Sign In</button>
          </div>
        </div>
      </div>
    </div>
  );
}
