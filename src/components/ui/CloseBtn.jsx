import { D } from "../../theme/tokens.js";


// =
// SHARED UI PRIMITIVES
// =

export function CloseBtn({onClose,size=36}){
  return(
    <button onClick={onClose} className="press" aria-label="Close"
      style={{width:size,height:size,borderRadius:size/2,background:D.cardEl,border:`1px solid ${D.border}`,
        color:D.off,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  );
}
