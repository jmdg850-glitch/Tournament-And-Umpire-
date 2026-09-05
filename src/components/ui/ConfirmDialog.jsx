import { Modal } from "./Modal.jsx";
import { Btn } from "./Btn.jsx";
import { D } from "../../theme/tokens.js";

// Yes/no confirmation dialog built on Modal — the app's answer to native
// `window.confirm()`, which a few flows (CourtsScreen, TournamentDetailPanel)
// still call directly, breaking out of the app's own visual language mid-flow.
// Callers keep the same "local boolean + conditional render" pattern already
// used for every other Modal-based confirm in the app (see ScoringScreen's
// confirmHold/confirmCancel) — this just removes the need to hand-roll the
// title/message/button-row markup at every call site.
export function ConfirmDialog({title,message,confirmLabel="Confirm",cancelLabel="Back",destructive=false,onConfirm,onCancel}){
  return(
    <Modal title={title} onClose={onCancel}>
      {message&&<div style={{fontSize:13,color:D.textSecondary,marginBottom:16,lineHeight:1.5}}>{message}</div>}
      <div style={{display:"flex",gap:8}}>
        <Btn full label={confirmLabel} color={destructive?D.red:D.amber} onClick={onConfirm}/>
        <Btn label={cancelLabel} outline color={D.muted} onClick={onCancel}/>
      </div>
    </Modal>
  );
}
