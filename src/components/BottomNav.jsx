import { motion } from "framer-motion";
import { D } from "../theme/tokens.js";
import { NAV_TABS } from "../navigation/navTabs.jsx";

// =
// BOTTOM NAV — primary screen navigation, moved to the thumb-reachable
// bottom edge of the screen (previously crammed into a 7-item row at the
// very top, the least reachable spot on a mobile screen). A normal flex
// sibling with flexShrink:0 at the end of .app-shell's column — no fixed
// positioning or per-screen padding changes needed, the same way the header
// above already reserves its own space in the flex column. Electron desktop
// builds use SideNav.jsx instead — see navTabs.jsx for the shared tab list.
// =
export function BottomNav({screen,setScreen}){
  const tabs=NAV_TABS;
  return(
    <div style={{display:"flex",flexShrink:0,background:D.navBg,borderTop:"1px solid "+D.navBorder,
      paddingBottom:"env(safe-area-inset-bottom)"}}>
      {tabs.map(t=>{
        const active=screen===t.id;
        return(
          <button key={t.id} onClick={()=>setScreen(t.id)} style={{
            flex:1,minHeight:52,padding:"8px 2px 6px",background:"transparent",border:"none",cursor:"pointer",
            display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:3,
            color:active?D.accent:D.textMuted,transition:"color var(--t-fast) var(--ease)",
          }}>
            <motion.div layout style={{width:active?30:26,height:active?30:26,borderRadius:active?10:8,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}
              transition={{type:"spring",stiffness:500,damping:32}} whileTap={{scale:0.88}}>
              {active&&<motion.div layoutId="bottomNavIndicator" style={{position:"absolute",inset:0,borderRadius:10,background:D.accentBg}}
                transition={{type:"spring",stiffness:500,damping:32}}/>}
              <span style={{position:"relative",display:"flex"}}>{t.icon}</span>
            </motion.div>
            <span style={{fontSize:9,fontWeight:active?700:500,letterSpacing:"0.3px"}}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
