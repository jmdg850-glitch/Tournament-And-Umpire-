import { D, alpha } from "../../theme/tokens.js";

export function TogBtn({active,color=D.blue,onClick,children,style={}}){
  return <button onClick={onClick} className="press"
    style={{flex:1,padding:"10px 8px",border:`1.5px solid ${active?color:D.border}`,background:active?alpha(color,9):D.cardEl,
      color:active?color:D.muted,borderRadius:10,fontWeight:700,fontSize:12,cursor:"pointer",transition:"all .12s",...style}}>
    {children}
  </button>;
}
