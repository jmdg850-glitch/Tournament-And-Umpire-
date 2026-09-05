import { motion } from "framer-motion";
import { D } from "../theme/tokens.js";
import { NAV_TABS } from "../navigation/navTabs.jsx";

// TV/projector display — see electron/main.cjs's createScoreboardWindow and
// src/screens/scoreboard/. Electron-only capability; SideNav itself already
// only renders under Electron, so no extra hasElectron gate is needed here.
function ScoreboardButton(){
  return(
    <motion.button onClick={()=>window.electronAPI.openScoreboardWindow({})}
      whileHover={{background:D.cardHi}} whileTap={{scale:0.97}}
      title="Open Live Scoreboard — a separate window for a TV or projector"
      style={{display:"flex",alignItems:"center",gap:12,padding:"9px 12px",borderRadius:10,
        background:"transparent",border:"none",cursor:"pointer",textAlign:"left",
        color:D.textSecondary,marginTop:8,paddingTop:16,borderTop:"1px solid "+D.navBorder}}>
      <span style={{display:"flex",flexShrink:0}}>
        <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>
        </svg>
      </span>
      <span style={{fontSize:13,fontWeight:600}}>Live Scoreboard</span>
    </motion.button>
  );
}

// =
// SIDE NAV — Electron desktop's primary screen navigation (icon rail with
// label, VS Code/Discord-style), replacing BottomNav's thumb-reach tab bar
// which makes no sense on a mouse-driven, resizable window. Renders from the
// same NAV_TABS source of truth as BottomNav so the two never drift apart.
// A flex column sibling of the content pane in the desktop-shell row layout
// — see [data-platform="electron"] .app-shell in base.css.
// =
export function SideNav({screen,setScreen}){
  return(
    <div style={{width:220,flexShrink:0,display:"flex",flexDirection:"column",gap:2,
      background:D.navBg,borderRight:"1px solid "+D.navBorder,padding:"12px 10px",overflowY:"auto"}}>
      {NAV_TABS.map((t,i)=>{
        const active=screen===t.id;
        return(
          <motion.button key={t.id} onClick={()=>setScreen(t.id)}
            whileHover={active?undefined:{background:D.cardHi}} whileTap={{scale:0.97}}
            title={`${t.label} (Ctrl+${i+1})`}
            style={{
              display:"flex",alignItems:"center",gap:12,padding:"9px 12px",borderRadius:10,
              background:active?D.accentBg:"transparent",border:"none",cursor:"pointer",textAlign:"left",
              color:active?D.accent:D.textSecondary,transition:"color var(--t-fast) var(--ease)",
            }}>
            <motion.span layout style={{display:"flex",flexShrink:0}} transition={{type:"spring",stiffness:500,damping:32}}>
              {t.icon}
            </motion.span>
            <span style={{fontSize:13,fontWeight:active?700:600}}>{t.label}</span>
          </motion.button>
        );
      })}
      <ScoreboardButton/>
    </div>
  );
}
