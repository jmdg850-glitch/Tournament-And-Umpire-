import { useEffect, useState } from "react";
import { D } from "../../theme/tokens.js";
import { Btn } from "./Btn.jsx";
import { CloseBtn } from "./CloseBtn.jsx";

// Electron-only (no main-process update feed exists on web/Android) — renders
// nothing at all when window.electronAPI is absent, so this is a no-op there.
const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

// Statuses that get the persistent top banner (something the user can act on
// or needs to keep seeing until dismissed/resolved).
const PERSISTENT_STATUSES=new Set(["available","downloading","downloaded","error"]);
// Statuses that get a brief auto-dismissing toast instead — but only when the
// check was user-initiated (payload.manual===true); silent background/
// periodic checks never nag with these. The restart decision itself is a
// native OS dialog (electron/ipc/updater.cjs's promptRestart), not rendered
// here at all.
const TOAST_LABEL={checking:"Checking for updates…","not-available":"You're using the latest version.",available:"Update found."};
// Hard backstop so an "error" banner (e.g. "No valid release found") can never survive
// indefinitely even if no further updater event ever arrives to supersede it.
const ERROR_AUTO_HIDE_MS=10000;

export function UpdateBanner(){
  const [state,setState]=useState(null);
  const [dismissed,setDismissed]=useState(false);
  const [toast,setToast]=useState(null);

  useEffect(()=>{
    if(!hasElectron)return;
    let toastTimer=null;
    let errorHideTimer=null;
    const showToast=(label,ms)=>{
      clearTimeout(toastTimer);
      setToast(label);
      toastTimer=setTimeout(()=>setToast(null),ms);
    };
    const unsubscribe=window.electronAPI.onUpdateEvent(payload=>{
      clearTimeout(errorHideTimer);
      if(PERSISTENT_STATUSES.has(payload.status)){
        setState(payload);
        if(payload.status==="available"||payload.status==="downloaded"||payload.status==="error")setDismissed(false);
        if(payload.status==="error")errorHideTimer=setTimeout(()=>setState(null),ERROR_AUTO_HIDE_MS);
      } else {
        // "checking"/"not-available"/"completed" mean a check just ran and resolved —
        // clear any stale persistent banner (e.g. a prior "error") left over from an
        // earlier cycle instead of leaving it stuck on screen forever.
        setState(null);
      }
      if(payload.manual&&TOAST_LABEL[payload.status])showToast(TOAST_LABEL[payload.status],2500);
      if(payload.status==="completed")showToast(`Update completed — now running v${payload.version}.`,4000);
    });
    return ()=>{ unsubscribe(); clearTimeout(toastTimer); clearTimeout(errorHideTimer); };
  },[]);

  if(!hasElectron)return null;

  const showBanner=state&&!dismissed;
  const isError=showBanner&&state.status==="error";
  const label=!showBanner?null
    : state.status==="available" ? `Update${state.version?` v${state.version}`:""} available`
    : state.status==="downloading" ? `Downloading update… ${state.percent??0}%`
    : state.status==="downloaded" ? `Update${state.version?` v${state.version}`:""} ready — will install on next restart`
    : state.error||"Update failed.";
  // No "Download" action here: autoDownload is always on (see updater.cjs's
  // wireEvents), so a download is already in flight the instant this status
  // arrives — a manual trigger would be redundant at best.
  const action=!showBanner?null
    : state.status==="error" ? {label:"Retry",onClick:()=>window.electronAPI.checkForUpdates()}
    : null;

  return(
    <>
      {showBanner&&(
        // absolute, not fixed: this only ever renders inside .app-content-col, and fixed would span
        // the whole window on the Electron sidebar shell instead of just the content pane (see App.jsx toast).
        <div style={{position:"absolute",top:0,left:0,right:0,zIndex:10000,display:"flex",alignItems:"center",
          justifyContent:"center",gap:12,padding:"8px 16px",background:isError?D.redBg:D.accentBg,
          borderBottom:`1px solid ${isError?D.red:D.accent}`}}>
          <span style={{fontSize:12,fontWeight:700,color:D.textPrimary}}>{label}</span>
          {action&&<Btn label={action.label} onClick={action.onClick} small color={isError?D.red:D.accent}/>}
          <CloseBtn onClose={()=>setDismissed(true)} size={22}/>
        </div>
      )}
      {toast&&(
        <div style={{position:"absolute",bottom:16,left:"50%",transform:"translateX(-50%)",zIndex:10000,
          padding:"8px 16px",background:D.cardEl,border:`1px solid ${D.border}`,borderRadius:20,
          fontSize:12,fontWeight:700,color:D.textPrimary,boxShadow:"0 4px 16px rgba(0,0,0,0.15)"}}>
          {toast}
        </div>
      )}
    </>
  );
}
