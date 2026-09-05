import { D, alpha } from "../../theme/tokens.js";


export function RatingPill({value,type="S",size="sm"}){
  const big=size==="lg";
  const col=value>=4?D.blue:value>=3?D.green:D.amber;
  return(
    <div style={{display:"inline-flex",alignItems:"center",gap:4,background:alpha(col,8),border:`1px solid ${alpha(col,21)}`,borderRadius:6,padding:big?"6px 12px":"3px 8px"}}>
      <span style={{fontSize:big?22:13,fontWeight:900,color:col,fontVariantNumeric:"tabular-nums"}}>{(+value||3).toFixed(3)}</span>
      <span style={{fontSize:big?9:8,fontWeight:700,color:col,letterSpacing:"1px",opacity:0.8}}>{type}</span>
    </div>
  );
}
