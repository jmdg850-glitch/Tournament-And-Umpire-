import * as Switch from "@radix-ui/react-switch";
import { D } from "../../theme/tokens.js";

// `label`: sets the accessible name announced by screen readers (e.g. "Public
// Profile") — without it, a Switch with no visible text of its own announces
// only "switch, off/on" with no indication of what it controls. Every caller
// already renders a visible text label beside the Toggle; this just makes
// that same string programmatically available.
export function Toggle({value,onChange,color=D.accent,label}){
  return(
    <Switch.Root checked={value} onCheckedChange={onChange} aria-label={label}
      style={{all:"unset",width:44,height:24,borderRadius:12,background:value?color:D.borderHi,cursor:"pointer",transition:"background .2s",flexShrink:0,position:"relative",display:"inline-block"}}>
      <Switch.Thumb style={{display:"block",width:18,height:18,borderRadius:9,background:"#fff",transition:"transform .2s",boxShadow:"0 1px 4px rgba(0,0,0,.3)",transform:value?"translate(23px,3px)":"translate(3px,3px)"}}/>
    </Switch.Root>
  );
}
