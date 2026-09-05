import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { EASE, OVERLAY_DURATION as DURATION } from "../../theme/motion.js";

const VARIANTS = {
  panel: { initial: { x: "100%" }, animate: { x: 0 }, exit: { x: "100%" } },
  modal: { initial: { opacity: 0, scale: 0.96, y: 8 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.96, y: 8 } },
  sheet: { initial: { y: "100%" }, animate: { y: 0 }, exit: { y: "100%" } },
};

// Drop-in animated replacement for a bespoke `position:"fixed",inset:0,...`
// overlay div. Wraps EXISTING header/content markup unchanged — callers just
// move their old wrapper div's styles into `style` here and keep everything
// else as a child. Gives every overlay real Radix focus-trap/Esc handling
// plus a framer-motion enter/exit, without touching each file's internal
// layout. `onClose` fires only once the exit animation finishes.
//
// Usage pattern inside a component that used to do
// `export function X({onClose}){ return <div style={{position:"fixed",...}}>...</div>; }`:
//
//   export function X({onClose: onCloseProp}){
//     const [open, setOpen] = useState(true);
//     const onClose = () => setOpen(false); // existing onClose-calling code below is unchanged
//     return (
//       <OverlayShell open={open} onRequestClose={onClose} onExitComplete={onCloseProp} variant="panel" style={{...old wrapper styles minus position/inset/zIndex...}} label="X">
//         ...unchanged header/body JSX...
//       </OverlayShell>
//     );
//   }
export function OverlayShell({open,onRequestClose,onExitComplete,variant="panel",style={},label,children}){
  const reduceMotion=useReducedMotion();
  const v=VARIANTS[variant];
  return (
    <Dialog.Root open={open} onOpenChange={(o)=>{ if(!o) onRequestClose?.(); }}>
      <AnimatePresence onExitComplete={onExitComplete}>
        {open&&(
          <Dialog.Portal forceMount>
            <Dialog.Content asChild forceMount>
              <motion.div
                initial={v.initial} animate={v.animate} exit={v.exit}
                transition={{duration:reduceMotion?0:DURATION[variant],ease:EASE}}
                style={style}>
                <Dialog.Title asChild>
                  <span style={{position:"absolute",width:1,height:1,padding:0,margin:-1,overflow:"hidden",clip:"rect(0,0,0,0)",whiteSpace:"nowrap",border:0}}>{label||"Dialog"}</span>
                </Dialog.Title>
                {children}
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}
