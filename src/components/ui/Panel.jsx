import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CloseBtn } from "./CloseBtn.jsx";
import { D } from "../../theme/tokens.js";
import { EASE, OVERLAY_DURATION } from "../../theme/motion.js";

const DURATION = OVERLAY_DURATION.panel;

// On the Electron desktop shell, Panel (designed as a full-bleed mobile
// "drill-down" screen) would otherwise stretch edge-to-edge across a
// maximized window. left:0;right:0 plus a max-width still lets the browser
// center the box via margin:auto while keeping it full-height (top:0/
// bottom:0) — no JSX restructuring needed, so every existing Panel caller's
// inner content is unaffected.
const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

// Radix Dialog for focus-trap/Esc handling on a full-screen "drill-down"
// surface, framer-motion for a slide-from-right entrance (the same
// forceMount + AnimatePresence pattern as Modal.jsx). `onClose` fires only
// after the exit animation completes.
export function Panel({title,onClose,children,headerRight=null,sub=null,stickyTop=null}){
  const [open,setOpen]=useState(true);
  const reduceMotion=useReducedMotion();
  const requestClose=()=>setOpen(false);

  return(
    <Dialog.Root open={open} onOpenChange={(o)=>{ if(!o) requestClose(); }}>
      <AnimatePresence onExitComplete={onClose}>
        {open&&(
          <Dialog.Portal forceMount>
            <Dialog.Content asChild forceMount onInteractOutside={e=>e.preventDefault()}>
              <motion.div
                initial={{x:"100%"}} animate={{x:0}} exit={{x:"100%"}}
                transition={{duration:reduceMotion?0:DURATION,ease:EASE}}
                style={{position:"fixed",inset:0,zIndex:500,background:D.bg,display:"flex",flexDirection:"column",paddingTop:"env(safe-area-inset-top)",
                  ...(hasElectron?{maxWidth:720,margin:"0 auto",borderLeft:`1px solid ${D.border}`,borderRight:`1px solid ${D.border}`}:{})}}>
                <Dialog.Title asChild>
                  <div style={{height:60,display:"flex",alignItems:"center",gap:12,padding:"0 16px",borderBottom:`1px solid ${D.border}`,background:D.surface,flexShrink:0}}>
                    <CloseBtn onClose={requestClose}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontWeight:800,fontSize:16,color:D.white,lineHeight:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{title}</div>
                      {sub&&<div style={{fontSize:10,color:D.muted,marginTop:2,letterSpacing:"0.5px"}}>{sub}</div>}
                    </div>
                    {headerRight}
                  </div>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <span style={{position:"absolute",width:1,height:1,padding:0,margin:-1,overflow:"hidden",clip:"rect(0,0,0,0)",whiteSpace:"nowrap",border:0}}>{sub||title}</span>
                </Dialog.Description>
                {stickyTop&&<div style={{padding:"14px 16px 0",flexShrink:0,background:D.bg}}>{stickyTop}</div>}
                <div style={{flex:1,overflowY:"auto",overflowX:"hidden",padding:"16px 16px 100px"}}>{children}</div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
