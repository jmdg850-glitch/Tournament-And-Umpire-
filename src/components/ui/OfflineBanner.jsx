import { useEffect, useState } from "react";
import { D } from "../../theme/tokens.js";

// Cloud.* methods already never throw when offline (writes queue in
// Outbox and drain on reconnect) — this only adds the missing user-facing
// notice that syncing is paused, not any new offline-handling logic.
export function OfflineBanner(){
  const [online,setOnline]=useState(()=>typeof navigator==="undefined"?true:navigator.onLine);

  useEffect(()=>{
    if(typeof window==="undefined")return;
    const goOnline=()=>setOnline(true);
    const goOffline=()=>setOnline(false);
    window.addEventListener("online",goOnline);
    window.addEventListener("offline",goOffline);
    return ()=>{ window.removeEventListener("online",goOnline); window.removeEventListener("offline",goOffline); };
  },[]);

  if(online)return null;

  return(
    // absolute, not fixed — see UpdateBanner.jsx for why (centers within
    // .app-content-col instead of the whole window on the Electron sidebar shell).
    <div style={{position:"absolute",top:0,left:0,right:0,zIndex:10000,display:"flex",alignItems:"center",
      justifyContent:"center",gap:8,padding:"8px 16px",background:D.amberBg,borderBottom:`1px solid ${D.amber}`}}>
      <span style={{fontSize:12,fontWeight:700,color:D.textPrimary}}>You're offline — changes will sync once you're back online.</span>
    </div>
  );
}
