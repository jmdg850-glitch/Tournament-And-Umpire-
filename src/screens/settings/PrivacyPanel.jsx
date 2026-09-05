import { Toggle } from "../../components/ui/Toggle.jsx";
import { Panel } from "../../components/ui/Panel.jsx";
import { D } from "../../theme/tokens.js";


export function PrivacyPanel({prefs,setPrefs,onClose}){
  const items=[{k:"profilePublic",l:"Public Profile",s:"Anyone can view your profile"},{k:"showRating",l:"Show Rating",s:"Display your rating publicly"},{k:"showHistory",l:"Match History",s:"Others can see your match history"},{k:"allowFriends",l:"Friend Requests",s:"Allow others to add you"}];
  return(
    <Panel title="Privacy & Security" onClose={onClose}>
      {items.map((item,i)=>(
        <div key={item.k} style={{display:"flex",alignItems:"center",gap:12,padding:"14px 0",borderBottom:i<items.length-1?`1px solid ${D.border}`:"none"}}>
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:700,color:D.textPrimary,marginBottom:2}}>{item.l}</div>
            <div style={{fontSize:11,color:D.textSecondary}}>{item.s}</div>
          </div>
          <Toggle value={prefs[item.k]} onChange={v=>setPrefs(p=>({...p,[item.k]:v}))} label={item.l}/>
        </div>
      ))}
    </Panel>
  );
}
