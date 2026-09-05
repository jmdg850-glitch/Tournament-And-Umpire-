import { D, alpha } from "../../theme/tokens.js";


export function Chip({label,color=D.blue,soft=true}){
  return <span style={{display:"inline-flex",alignItems:"center",fontSize:9,fontWeight:700,padding:"3px 8px",borderRadius:4,
    background:soft?alpha(color,9):`${color}`,border:`1px solid ${alpha(color,25)}`,color:soft?color:D.bg,letterSpacing:"0.5px"}}>{label}</span>;
}
