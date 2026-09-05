import { useState } from "react";
import { Panel } from "../../components/ui/Panel.jsx";
import { D, alpha } from "../../theme/tokens.js";


export function HelpPanel({onClose}){
  const faqs=[
    {q:"How do I create a tournament?",a:"Go to Tournaments, tap New Tournament, fill in the name and venue, then add divisions. Register players, seed them, and generate the schedule or bracket from the division screen."},
    {q:"How do I start a match?",a:"Open the division Bracket or Schedule tab. Assign a court (and optionally an umpire), then tap Start Match. Umpires can also open the match from Home or the Umpiring list after they are assigned."},
    {q:"How do I umpire a match?",a:"When an organizer assigns you, you will see the match on Home and under Tournaments → Umpiring. Open it, confirm the players, toss the coin if needed, then enter points on the scoring screen. Tap Save Result when the match is complete."},
    {q:"How is scoring calculated?",a:"Scoring uses pickleball side-out rules. Only the serving side scores. Games use the division's win-to and win-by settings. Best-of matches need a majority of games, not a single game win."},
    {q:"Can I share a live match?",a:"Yes. On the scoring screen, tap Share to copy a live spectator link."},
    {q:"How do I sign in?",a:"Enter your username or email and your password on the Sign In screen. Forgot it? Tap Forgot Password and we will email you a secure reset link."},
  ];
  return(
    <Panel title="Help Center" onClose={onClose}>
      <div style={{fontSize:13,color:D.textSecondary,marginBottom:16,lineHeight:1.6}}>Frequently asked questions about running and umpiring tournaments.</div>
      {faqs.map((f,i)=>(
        <FaqItem key={i} q={f.q} a={f.a}/>
      ))}
      <div style={{background:D.accentBg,border:`1px solid ${alpha(D.accent,15)}`,borderRadius:"var(--r-md)",padding:"14px",marginTop:16,textAlign:"center"}}>
        <div style={{fontSize:13,fontWeight:700,color:D.accent,marginBottom:4}}>Still need help?</div>
        <div style={{fontSize:12,color:D.textSecondary}}>Email us at support@picklelive.com</div>
      </div>
    </Panel>
  );
}


export function FaqItem({q,a}){
  const [open,setOpen]=useState(false);
  return(
    <div style={{background:D.cardEl,border:`1px solid ${D.border}`,borderRadius:"var(--r-md)",marginBottom:8,overflow:"hidden"}}>
      <button onClick={()=>setOpen(o=>!o)} style={{width:"100%",padding:"13px 14px",background:"transparent",border:"none",display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",textAlign:"left"}}>
        <span style={{fontSize:13,fontWeight:700,color:D.textPrimary,flex:1,paddingRight:8}}>{q}</span>
        <span style={{color:D.accent,fontSize:16,flexShrink:0,transition:"transform .2s",transform:open?"rotate(45deg)":"none"}}>+</span>
      </button>
      {open&&<div style={{padding:"0 14px 13px",fontSize:12,color:D.textSecondary,lineHeight:1.7,borderTop:`1px solid ${D.border}`}}>{a}</div>}
    </div>
  );
}
