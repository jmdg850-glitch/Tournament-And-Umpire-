import { D } from "../../theme/tokens.js";

// `dark`: opt into the app's permanently-dark "court" surface tokens (D.dark*) instead of the
// theme-toggle-aware light tokens this component defaults to — for chrome that must stay dark
// regardless of the user's light/dark app setting (e.g. ScoringScreen). Default false preserves
// every existing appearance exactly.
// `radius`/`style`: escape hatches for screens (Courts/LiveBoard) that established a fully-round
// "pill" button convention (20-22px) before this primitive existed — lets those screens adopt
// Btn (removing duplicated hand-rolled button markup) with zero visual change, instead of forcing
// every call site onto the 10px default.
export function Btn({label,onClick,color=D.blue,outline=false,small=false,disabled=false,icon=null,full=false,dark=false,radius=10,style={}}){
  return(
    <button onClick={onClick} disabled={disabled} className="press"
      style={{display:"flex",alignItems:"center",justifyContent:"center",gap:6,
        padding:small?"8px 14px":"12px 20px",borderRadius:radius,cursor:disabled?"default":"pointer",
        width:full?"100%":"auto",
        border:`1.5px solid ${outline?color:disabled?(dark?D.darkBorder:D.border):color}`,
        background:disabled?(dark?D.darkCard:D.cardEl):outline?"transparent":color,
        color:disabled?(dark?D.darkTextMuted:D.muted):outline?color:(dark?"#fff":D.bg),fontWeight:700,fontSize:small?12:13,transition:"all .12s",opacity:disabled?.5:1,
        ...style}}>
      {icon&&<span style={{fontSize:14}}>{icon}</span>}
      {label}
    </button>
  );
}
