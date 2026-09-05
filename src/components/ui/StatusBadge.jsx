import { D, alpha } from "../../theme/tokens.js";


// =
// STATUS BADGE
// =
// `dark`: use the app's permanently-dark "court" tokens (D.dark*) instead of the theme-toggle
// light tokens below — for chrome that stays dark regardless of the app's light/dark setting
// (e.g. ScoringScreen). Default false preserves every existing caller's appearance exactly.
export function StatusBadge({status,dark=false}){
  const cfg=(dark?{
    LIVE:    {bg:`${alpha(D.darkRed,18)}`,   border:`${alpha(D.darkRed,40)}`,   color:D.darkRed,   label:"LIVE"},
    PAUSED:  {bg:`${alpha(D.darkAmber,18)}`, border:`${alpha(D.darkAmber,40)}`, color:D.darkAmber, label:"PAUSED"},
    HOLD:    {bg:`${alpha(D.darkAmber,18)}`, border:`${alpha(D.darkAmber,40)}`, color:D.darkAmber, label:"ON HOLD"},
    TIMEOUT: {bg:`${alpha(D.darkAmber,18)}`, border:`${alpha(D.darkAmber,40)}`, color:D.darkAmber, label:"TIMEOUT"},
    DONE:    {bg:`${alpha(D.darkTextMuted,14)}`,border:`${alpha(D.darkTextMuted,30)}`,color:D.darkTextMuted,label:"DONE"},
    VIEW_ONLY:{bg:`${alpha(D.darkTextMuted,14)}`,border:`${alpha(D.darkTextMuted,30)}`,color:D.darkTextMuted,label:"VIEW ONLY"},
  }:{
    WIN:    {bg:`${alpha(D.green,9)}`,border:`${alpha(D.green,25)}`,color:D.green,label:"WIN"},
    LOSS:   {bg:`${alpha(D.red,9)}`,  border:`${alpha(D.red,25)}`,  color:D.red,  label:"LOSS"},
    LIVE:   {bg:`${alpha(D.blue,9)}`, border:`${alpha(D.blue,25)}`, color:D.blue, label:"LIVE"},
    DONE:   {bg:`${alpha(D.muted,9)}`,border:`${alpha(D.muted,25)}`,color:D.muted,label:"DONE"},
    BANNED: {bg:`${alpha(D.red,9)}`,  border:`${alpha(D.red,25)}`,  color:D.red,  label:"BANNED"},
    ADMIN:  {bg:`${alpha(D.amber,9)}`,border:`${alpha(D.amber,25)}`,color:D.amber,label:"ADMIN"},
    ACTIVE: {bg:`${alpha(D.green,9)}`,border:`${alpha(D.green,25)}`,color:D.green,label:"ACTIVE"},
  })[status]||{bg:`${alpha(dark?D.darkTextMuted:D.muted,8)}`,border:`${alpha(dark?D.darkTextMuted:D.muted,19)}`,color:dark?D.darkTextMuted:D.muted,label:status};
  return <span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:9,fontWeight:800,padding:"3px 8px",borderRadius:4,
    background:cfg.bg,border:`1px solid ${cfg.border}`,color:cfg.color,letterSpacing:"1px"}}>{cfg.label}</span>;
}
