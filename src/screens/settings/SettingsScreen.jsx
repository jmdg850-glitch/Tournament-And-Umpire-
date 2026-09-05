import { useState, useEffect, useCallback } from "react";
import { Avatar } from "../../components/ui/Avatar.jsx";
import { TogBtn } from "../../components/ui/TogBtn.jsx";
import { ConfirmDialog } from "../../components/ui/ConfirmDialog.jsx";
import { Notify } from "../../lib/notify.js";
import { LS } from "../../lib/storage.js";
import { APP_BUILD, APP_VERSION } from "../../lib/utils.js";
import { useRegisterBackHandler } from "../../navigation/BackHandlerContext.jsx";
import { AboutPanel } from "./AboutPanel.jsx";
import { DuprPanel } from "./DuprPanel.jsx";
import { HelpPanel } from "./HelpPanel.jsx";
import { LogsPanel } from "./LogsPanel.jsx";
import { NotifPanel } from "./NotifPanel.jsx";
import { PrivacyPanel } from "./PrivacyPanel.jsx";
import { SettingsPasswordPanel } from "./SettingsPasswordPanel.jsx";
import { SettingsProfilePanel } from "./SettingsProfilePanel.jsx";
import { TermsPanel } from "./TermsPanel.jsx";
import { D } from "../../theme/tokens.js";


const Row=({icon,label,sub,onPress,chevron=true,color=D.textPrimary,danger=false})=>(
  <button onClick={onPress} style={{width:"100%",padding:"14px 16px",display:"flex",alignItems:"center",gap:12,background:"transparent",border:"none",cursor:"pointer",textAlign:"left",borderBottom:"1px solid "+D.border}}>
    <div style={{width:38,height:38,borderRadius:10,background:danger?D.redBg:D.cardEl,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>{icon}</div>
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:13,fontWeight:700,color:danger?D.red:color,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{label}</div>
      {sub&&<div style={{fontSize:11,color:D.textMuted,marginTop:1}}>{sub}</div>}
    </div>
    {chevron&&<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={D.textMuted} strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>}
  </button>
);

// ================================================================
// SETTINGS SCREEN — clean light theme
// ================================================================
export function SettingsScreen({currentUser,onUpdate,onLogOut,notify,onDeleteAccount,onChangePassword,theme="system",onChangeTheme}){
  const [panel,setPanel]=useState(null);
  const [notifOn,setNotifOn]=useState(()=>{try{return Notify.isEnabled();}catch{return false;}});
  const [notifPrefs,setNotifPrefs]=useState(()=>LS.get("pl6_notif",{matches:true,friends:true,clubs:true,news:false}));
  const [privacy,setPrivacy]=useState(()=>LS.get("pl6_privacy",{profilePublic:true,showRating:true,showHistory:true,allowFriends:true}));
  const [confirmDeleteAccount,setConfirmDeleteAccount]=useState(false);

  useEffect(()=>{try{LS.set("pl6_notif",notifPrefs);}catch{ /* best-effort, safe to ignore */ }},[notifPrefs]);
  useEffect(()=>{try{LS.set("pl6_privacy",privacy);}catch{ /* best-effort, safe to ignore */ }},[privacy]);
  // Swipe-back closes an open sub-panel first, the same setter every sub-panel's own Close
  // button already calls.
  useRegisterBackHandler(useCallback(()=>{
    if(panel){ setPanel(null); return true; }
    return false;
  },[panel]));

  if(panel==="profile")return <SettingsProfilePanel currentUser={currentUser} onUpdate={v=>{onUpdate(v);setPanel(null);}} onClose={()=>setPanel(null)} notify={notify}/>;
  if(panel==="password")return <SettingsPasswordPanel currentUser={currentUser} onChangePassword={onChangePassword} onClose={()=>setPanel(null)} notify={notify}/>;
  if(panel==="notifs")return <NotifPanel prefs={notifPrefs} setPrefs={setNotifPrefs} onClose={()=>setPanel(null)}/>;
  if(panel==="privacy")return <PrivacyPanel prefs={privacy} setPrefs={setPrivacy} onClose={()=>setPanel(null)}/>;
  if(panel==="help")return <HelpPanel onClose={()=>setPanel(null)}/>;
  if(panel==="terms")return <TermsPanel onClose={()=>setPanel(null)}/>;
  if(panel==="about")return <AboutPanel onClose={()=>setPanel(null)}/>;
  if(panel==="logs")return <LogsPanel onClose={()=>setPanel(null)} notify={notify}/>;
  if(panel==="dupr")return <DuprPanel onClose={()=>setPanel(null)} notify={notify}/>;

  return(
    <div style={{background:D.bg,height:"100%",overflowY:"auto",paddingBottom:40}}>
      {/* Profile card */}
      <div style={{background:D.surface,padding:"16px",marginBottom:8,borderBottom:"1px solid "+D.border}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <Avatar name={currentUser?.name} photo={currentUser?.photo} size={58} color={D.accent}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:800,fontSize:17,color:D.textPrimary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser?.name}</div>
            <div style={{fontSize:12,color:D.textSecondary,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser?.email}</div>
            <div style={{fontSize:11,fontWeight:700,color:D.accent,marginTop:2}}>{currentUser?.role==="admin"?"⭐ Administrator":"🏓 Player"}</div>
          </div>
          <button onClick={()=>setPanel("profile")} style={{padding:"7px 14px",background:D.accentBg,border:"1px solid "+D.accent,borderRadius:22,color:D.accent,fontSize:12,fontWeight:700,cursor:"pointer",flexShrink:0}}>Edit</button>
        </div>
      </div>

      {/* Account section */}
      <div style={{marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1.5px",padding:"10px 16px 4px"}}>ACCOUNT</div>
        <div style={{background:D.surface}}>
          <Row icon="👤" label="Edit Profile" sub="Name, photo, contact info" onPress={()=>setPanel("profile")}/>
          <Row icon="🔒" label="Change Password" sub="Update your login password" onPress={()=>setPanel("password")}/>
          <Row icon="🏓" label="DUPR" sub="Connect your account to sync match results" onPress={()=>setPanel("dupr")}/>
        </div>
      </div>

      {/* Preferences */}
      <div style={{marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1.5px",padding:"10px 16px 4px"}}>PREFERENCES</div>
        <div style={{background:D.surface}}>
          {/* Device notifications master toggle */}
          <div style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+D.border}}>
            <div style={{width:38,height:38,borderRadius:10,background:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>🔔</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:700,color:D.textPrimary}}>Device Notifications</div>
              <div style={{fontSize:11,color:D.textMuted}}>{Notify.supported?"Friend & join requests, feed posts":"Not supported on this device"}</div>
            </div>
            <button disabled={!Notify.supported} role="switch" aria-checked={notifOn} aria-label="Device Notifications" onClick={async()=>{
              if(notifOn){ Notify.setEnabled(false); setNotifOn(false); notify&&notify("Notifications off"); return; }
              const p=await Notify.request();
              if(p==="granted"){ Notify.setEnabled(true); setNotifOn(true); Notify.show("Notifications on 🔔","You'll get alerts here."); notify&&notify("Notifications on"); }
              else notify&&notify(p==="denied"?"Permission blocked in browser settings":"Couldn't enable notifications","err");
            }} style={{width:48,height:28,borderRadius:14,border:"none",cursor:Notify.supported?"pointer":"default",flexShrink:0,position:"relative",
              background:notifOn?D.accent:D.border,opacity:Notify.supported?1:.5,transition:"background .2s"}}>
              <span style={{position:"absolute",top:3,left:notifOn?23:3,width:22,height:22,borderRadius:11,background:"#fff",transition:"left .2s",boxShadow:"0 1px 3px rgba(0,0,0,.3)"}}/>
            </button>
          </div>
          <Row icon="🛡" label="Privacy & Security" sub="Who can see your profile" onPress={()=>setPanel("privacy")}/>
          <div style={{padding:"14px 16px"}}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:10}}>
              <div style={{width:38,height:38,borderRadius:10,background:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,flexShrink:0}}>🎨</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:13,fontWeight:700,color:D.textPrimary}}>Appearance</div>
                <div style={{fontSize:11,color:D.textMuted}}>Light, dark, or match your device</div>
              </div>
            </div>
            <div style={{display:"flex",gap:8}}>
              <TogBtn active={theme==="light"} onClick={()=>onChangeTheme&&onChangeTheme("light")}>☀️ Light</TogBtn>
              <TogBtn active={theme==="dark"} onClick={()=>onChangeTheme&&onChangeTheme("dark")}>🌙 Dark</TogBtn>
              <TogBtn active={theme==="system"} onClick={()=>onChangeTheme&&onChangeTheme("system")}>⚙️ System</TogBtn>
            </div>
          </div>
        </div>
      </div>

      {/* Legal & Info */}
      <div style={{marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1.5px",padding:"10px 16px 4px"}}>LEGAL & INFO</div>
        <div style={{background:D.surface}}>
          <Row icon="📋" label="Terms and Conditions" sub="Our terms of service" onPress={()=>setPanel("terms")}/>
          <Row icon="🔐" label="Privacy Policy" sub="How we handle your data" onPress={()=>setPanel("privacy")}/>
          <Row icon="ℹ️" label="About PickleLive" sub="Learn more about this app" onPress={()=>setPanel("about")}/>
          <Row icon="📞" label="Help Center" sub="FAQs and support" onPress={()=>setPanel("help")} chevron/>
          <div style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:12,borderBottom:"1px solid "+D.border}}>
            <div style={{width:38,height:38,borderRadius:10,background:D.cardEl,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17}}>🏓</div>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:700,color:D.textPrimary}}>App Version</div>
              <div style={{fontSize:11,color:D.textMuted}}>PickleLive v{APP_VERSION} · {APP_BUILD}</div>
            </div>
          </div>
        </div>
      </div>

      {/* System */}
      <div style={{marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1.5px",padding:"10px 16px 4px"}}>SYSTEM</div>
        <div style={{background:D.surface}}>
          <Row icon="🗒️" label="Activity &amp; Logs" sub="App events, diagnostics & errors" onPress={()=>setPanel("logs")}/>
        </div>
      </div>

      {/* Account management */}
      <div style={{marginBottom:8}}>
        <div style={{fontSize:10,fontWeight:700,color:D.textMuted,letterSpacing:"1.5px",padding:"10px 16px 4px"}}>ACCOUNT MANAGEMENT</div>
        <div style={{background:D.surface}}>
          <Row icon="🚪" label="Sign Out" sub="Log out of your account" onPress={onLogOut} chevron={false} danger/>
          <Row icon="🗑" label="Delete Account" sub="Permanently remove your account" onPress={()=>setConfirmDeleteAccount(true)} chevron={false} danger/>
        </div>
      </div>

      <div style={{textAlign:"center",padding:"20px",fontSize:11,color:D.textLight}}>PickleLive Pro · Made with ❤️ in the Philippines</div>
      {confirmDeleteAccount&&(
        <ConfirmDialog title="Delete your account?" message="This cannot be undone." confirmLabel="Delete Account" destructive
          onConfirm={()=>{setConfirmDeleteAccount(false);onDeleteAccount();}}
          onCancel={()=>setConfirmDeleteAccount(false)}/>
      )}
    </div>
  );
}
