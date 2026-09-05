import { motion } from "framer-motion";
import { Avatar } from "./ui/Avatar.jsx";
import { D } from "../theme/tokens.js";

// =
// APP HEADER — avatar/greeting top-left, live/notif/admin/+Match actions
// top-right. Primary screen navigation lives in BottomNav.jsx (thumb reach),
// split out of what used to be a combined TopNav so the header and the tab
// bar can each sit where they actually belong.
// =
export function AppHeader({liveCount,adminMode,onAdmin,onNewMatch,currentUser,onProfile,onOpenLiveBoard,notifCount=0,onOpenNotifications}){
  return(
    <div style={{background:D.navBg,borderBottom:"1px solid "+D.navBorder,flexShrink:0}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 16px"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={onProfile}>
          <Avatar name={currentUser?.name} photo={currentUser?.photo} size={42} color={D.accent}/>
          <div>
            <div style={{fontSize:12,color:D.textMuted,lineHeight:1}}>Welcome back,</div>
            <div style={{fontWeight:800,fontSize:16,color:D.textPrimary,lineHeight:1.2}}>{currentUser?.name?.split(" ")[0]||"Player"}</div>
          </div>
        </div>
        <div style={{display:"flex",gap:10,alignItems:"center"}}>
          {liveCount>0&&(
            <button onClick={onOpenLiveBoard} style={{display:"flex",alignItems:"center",gap:5,background:D.redBg,border:"1px solid "+D.red,borderRadius:20,padding:"5px 10px",cursor:"pointer"}}>
              <span style={{width:7,height:7,borderRadius:4,background:D.red,display:"inline-block",animation:"pulse 1.2s infinite"}}/>
              <span style={{fontSize:11,fontWeight:700,color:D.red}}>{liveCount} LIVE</span>
            </button>
          )}
          {onOpenNotifications&&(
            <motion.button onClick={onOpenNotifications} whileTap={{scale:0.9}} style={{position:"relative",width:38,height:38,borderRadius:19,background:D.cardEl,border:"1px solid "+D.border,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:D.textMuted}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              {notifCount>0&&(
                <span style={{position:"absolute",top:-2,right:-2,minWidth:16,height:16,borderRadius:8,background:D.red,color:"#fff",fontSize:9,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",padding:"0 3px"}}>{notifCount>9?"9+":notifCount}</span>
              )}
            </motion.button>
          )}
          {currentUser?.role==="admin"&&(
            <motion.button onClick={onAdmin} whileTap={{scale:0.9}} style={{width:38,height:38,borderRadius:19,background:adminMode?D.amberBg:D.cardEl,border:"1px solid "+(adminMode?D.amber:D.border),cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",color:adminMode?D.amber:D.textMuted}}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1l3 6 6 1-4.5 4 1 6L12 15l-5.5 3 1-6L3 8l6-1z"/></svg>
            </motion.button>
          )}
          <motion.button onClick={onNewMatch} whileTap={{scale:0.95}} style={{padding:"9px 16px",background:D.accent,border:"none",borderRadius:22,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer",boxShadow:"var(--sh-2)",display:"flex",alignItems:"center",gap:5}}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Match
          </motion.button>
        </div>
      </div>
    </div>
  );
}
