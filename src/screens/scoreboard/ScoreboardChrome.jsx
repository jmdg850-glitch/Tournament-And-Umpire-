import { useState, useEffect, useRef } from "react";

const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

// Overlay control strip: court picker, fullscreen toggle, close. Auto-hides
// after a few seconds of no mouse movement, but only while actually
// fullscreen (always visible in a normal windowed view).
export function ScoreboardChrome({courts,courtId,onSelectCourt,theme,onToggleTheme}){
  const [visible,setVisible]=useState(true);
  const [isFullScreen,setIsFullScreen]=useState(false);
  const hideTimer=useRef(null);

  useEffect(()=>{
    if(!hasElectron) return;
    return window.electronAPI.onScoreboardStateChange(({isFullScreen:fs})=>setIsFullScreen(!!fs));
  },[]);

  useEffect(()=>{
    const reveal=()=>{
      setVisible(true);
      clearTimeout(hideTimer.current);
      if(isFullScreen) hideTimer.current=setTimeout(()=>setVisible(false),2500);
    };
    const onKey=e=>{ if(e.key==="Escape"&&isFullScreen&&hasElectron) window.electronAPI.toggleScoreboardFullscreen(); };
    window.addEventListener("mousemove",reveal);
    window.addEventListener("keydown",onKey);
    reveal();
    return ()=>{ window.removeEventListener("mousemove",reveal); window.removeEventListener("keydown",onKey); clearTimeout(hideTimer.current); };
  },[isFullScreen]);

  if(!visible&&isFullScreen) return null;

  return(
    <div style={{position:"absolute",top:0,left:0,right:0,zIndex:10,display:"flex",alignItems:"center",gap:10,
      padding:"10px 14px",background:"linear-gradient(to bottom, rgba(0,0,0,.7), transparent)"}}>
      <div style={{display:"flex",gap:6,overflowX:"auto",flex:1}}>
        {courts.map(c=>(
          <button key={c.courtId} onClick={()=>onSelectCourt(c.courtId)}
            style={{padding:"6px 12px",borderRadius:16,border:"1px solid "+(c.courtId===courtId?"#fff":"rgba(255,255,255,.3)"),
              background:c.courtId===courtId?"rgba(255,255,255,.15)":"transparent",color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>
            {c.courtName||"Court"}
          </button>
        ))}
      </div>
      {onToggleTheme&&(
        <button onClick={onToggleTheme} title="Toggle light/dark"
          style={{width:32,height:32,borderRadius:16,border:"1px solid rgba(255,255,255,.3)",background:"transparent",color:"#fff",cursor:"pointer",fontSize:15}}>
          {theme==="dark"?"☀️":"🌙"}
        </button>
      )}
      {hasElectron&&(
        <>
          <button onClick={()=>window.electronAPI.toggleScoreboardFullscreen()} title="Toggle fullscreen"
            style={{width:32,height:32,borderRadius:16,border:"1px solid rgba(255,255,255,.3)",background:"transparent",color:"#fff",cursor:"pointer",fontSize:15}}>
            ⛶
          </button>
          <button onClick={()=>window.electronAPI.closeScoreboardWindow()} title="Close"
            style={{width:32,height:32,borderRadius:16,border:"1px solid rgba(255,255,255,.3)",background:"transparent",color:"#fff",cursor:"pointer",fontSize:17}}>
            ×
          </button>
        </>
      )}
    </div>
  );
}
