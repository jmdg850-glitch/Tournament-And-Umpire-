import { useId } from "react";
import { FieldLabel } from "./Labels.jsx";
import { D } from "../../theme/tokens.js";

export function Input({label,value,onChange,type="text",placeholder="",mono=false}){
  const id=useId();
  return(
    <div style={{marginBottom:13}}>
      {label&&<FieldLabel htmlFor={id}>{label}</FieldLabel>}
      <input id={id} type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        style={{width:"100%",background:D.cardEl,border:`1px solid ${D.border}`,borderRadius:9,
          padding:"11px 13px",color:D.white,fontSize:13,fontFamily:mono?"monospace":"inherit"}}/>
    </div>
  );
}
