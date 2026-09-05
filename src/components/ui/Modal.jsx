import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CloseBtn } from "./CloseBtn.jsx";
import { D } from "../../theme/tokens.js";
import { EASE, OVERLAY_DURATION } from "../../theme/motion.js";

// Numeric equivalent of the --t-base CSS token (tokens.css) — framer-motion
// needs a JS value here, not a CSS var() string.
const DURATION = OVERLAY_DURATION.modal;

// Radix Dialog for real focus-trap/Esc/outside-click handling, framer-motion
// for enter/exit choreography via the forceMount + AnimatePresence pattern.
// `onClose` (from the parent, which unmounts this component) fires only
// after the exit animation finishes, so callers don't need to change how
// they use Modal — closing still just works.
export function Modal({title,onClose,children,width=380}){
  const [open,setOpen]=useState(true);
  const reduceMotion=useReducedMotion();
  const requestClose=()=>setOpen(false);

  return(
    <Dialog.Root open={open} onOpenChange={(o)=>{ if(!o) requestClose(); }}>
      <AnimatePresence onExitComplete={onClose}>
        {open&&(
          <Dialog.Portal forceMount>
            <Dialog.Overlay asChild forceMount>
              <motion.div
                initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
                transition={{duration:reduceMotion?0:DURATION,ease:EASE}}
                style={{position:"fixed",inset:0,background:"rgba(0,0,0,.85)",zIndex:600,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
                <Dialog.Content asChild forceMount>
                  <motion.div
                    initial={{opacity:0,scale:0.96,y:8}} animate={{opacity:1,scale:1,y:0}} exit={{opacity:0,scale:0.96,y:8}}
                    transition={{duration:reduceMotion?0:DURATION,ease:EASE}}
                    style={{background:D.surface,border:`1px solid ${D.border}`,borderRadius:16,width:"100%",maxWidth:width,maxHeight:"85vh",overflowY:"auto"}}>
                    <div style={{display:"flex",alignItems:"center",gap:12,padding:"14px 16px",borderBottom:`1px solid ${D.border}`}}>
                      <Dialog.Title asChild>
                        <div style={{flex:1,fontWeight:800,fontSize:15,color:D.white}}>{title}</div>
                      </Dialog.Title>
                      <CloseBtn onClose={requestClose}/>
                    </div>
                    <Dialog.Description asChild>
                      <span style={{position:"absolute",width:1,height:1,padding:0,margin:-1,overflow:"hidden",clip:"rect(0,0,0,0)",whiteSpace:"nowrap",border:0}}>{title}</span>
                    </Dialog.Description>
                    <div style={{padding:"14px 16px 18px"}}>{children}</div>
                  </motion.div>
                </Dialog.Content>
              </motion.div>
            </Dialog.Overlay>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
