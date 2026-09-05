import { useState, useEffect } from "react";
import { useLiveBoard } from "../../lib/liveBoard.js";
import { useLiveMatchForCourt } from "../../lib/liveMatchForCourt.js";
import { ScoreboardDisplay } from "./ScoreboardDisplay.jsx";
import { ScoreboardChrome } from "./ScoreboardChrome.jsx";
import { SCOREBOARD_PALETTES } from "./scoreboardPalettes.js";
import { LS } from "../../lib/storage.js";

const LAST_COURT_KEY="pl_scoreboard_lastCourtId";
// Deliberately NOT the app-wide "theme" key — this window shares localStorage with the main
// window (no partition set), and the main app always forces this window's document theme to
// dark on boot (see main.jsx) regardless of the user's app-wide preference. A separate key
// keeps a scoreboard light/dark toggle from ever leaking into/corrupting the main app's theme.
const SCOREBOARD_THEME_KEY="pl_scoreboard_theme";

function EmptyState({title,sub}){
  return(
    <div style={{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12}}>
      <div style={{fontSize:48}}>🏓</div>
      <div style={{fontSize:20,fontWeight:800}}>{title}</div>
      <div style={{fontSize:13,opacity:0.6}}>{sub}</div>
    </div>
  );
}

// Browsing mode only (no court chosen yet) — mounted only while unlocked, so its
// useLiveBoard() whole-board subscription (and the Realtime channel it opens) never runs at
// all once a window locks onto a court, satisfying "each window subscribes only to its
// assigned court." A window opened directly with a courtId (the normal CourtsScreen
// per-court launch) never mounts this at all.
function CourtPickerBoard({onPick,theme,onToggleTheme}){
  const {matches}=useLiveBoard();
  const liveOrPaused=matches.filter(m=>m.status==="in_progress"||m.status==="paused");
  const courtOptions=[...new Map(liveOrPaused.map(m=>[m.courtId,m])).values()];

  useEffect(()=>{ if(liveOrPaused.length===1) onPick(liveOrPaused[0].courtId); },[liveOrPaused,onPick]);

  return(
    <>
      <ScoreboardChrome courts={courtOptions} courtId={null} onSelectCourt={onPick} theme={theme} onToggleTheme={onToggleTheme}/>
      <EmptyState
        title={courtOptions.length===0?"No live matches":"Pick a court to display"}
        sub={courtOptions.length===0?"Waiting for a match to start…":"Use the court picker above"}
      />
    </>
  );
}

// Root component mounted only inside the Electron scoreboard window (see main.jsx's
// ?mode=scoreboard branch). No auth gate, no nav shell. Once a court is known (either
// initialCourtId from the URL, or picked via CourtPickerBoard), this window locks onto it
// via useLiveMatchForCourt — a single court-scoped Realtime channel, not the whole board —
// and never unlocks (closing the window is how you "switch courts"). Same Realtime data
// every other spectator view already uses; no duplicated backend.
export function ScoreboardApp({initialCourtId}){
  const [courtId,setCourtId]=useState(()=>initialCourtId||localStorage.getItem(LAST_COURT_KEY)||null);
  useEffect(()=>{ if(courtId) localStorage.setItem(LAST_COURT_KEY,courtId); },[courtId]);

  const [theme,setTheme]=useState(()=>LS.get(SCOREBOARD_THEME_KEY,"dark"));
  const toggleTheme=()=>setTheme(t=>{ const next=t==="dark"?"light":"dark"; LS.set(SCOREBOARD_THEME_KEY,next); return next; });
  const palette=SCOREBOARD_PALETTES[theme]||SCOREBOARD_PALETTES.dark;

  const lockedMatch=useLiveMatchForCourt(courtId);

  return(
    <div style={{position:"fixed",inset:0,background:palette.bg,color:palette.text,overflow:"hidden"}}>
      {courtId ? (
        <>
          <ScoreboardChrome courts={[]} courtId={courtId} onSelectCourt={()=>{}} theme={theme} onToggleTheme={toggleTheme}/>
          {lockedMatch
            ? <ScoreboardDisplay match={lockedMatch} theme={theme}/>
            : <EmptyState title="No live match" sub="Waiting for a match to start on this court…"/>}
        </>
      ) : (
        <CourtPickerBoard onPick={setCourtId} theme={theme} onToggleTheme={toggleTheme}/>
      )}
    </div>
  );
}
