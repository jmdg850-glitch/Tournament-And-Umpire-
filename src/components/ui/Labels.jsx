import { D } from "../../theme/tokens.js";


export function SectionLabel({children,style={}}){return <div style={{fontSize:9,fontWeight:800,color:D.muted,letterSpacing:"2px",marginBottom:10,...style}}>{children}</div>;}

// `htmlFor`: when given a form control's id, renders as a real `<label>` so
// screen readers announce the field's name and clicking the caption focuses
// the control — without it, renders exactly as before (a plain caption div).
export function FieldLabel({children,htmlFor}){
  const Tag=htmlFor?"label":"div";
  return <Tag htmlFor={htmlFor} style={{fontSize:10,fontWeight:700,color:D.muted,letterSpacing:"0.8px",marginBottom:6,display:"block"}}>{children}</Tag>;
}
