import logo from "../../assets/logo.png";
import { APP_BUILD, APP_VERSION } from "../../lib/utils.js";
import { Panel } from "../../components/ui/Panel.jsx";
import { Card } from "../../components/ui/Card.jsx";
import { D, alpha } from "../../theme/tokens.js";


export function AboutPanel({onClose}){
  return(
    <Panel title="About PickleLive" onClose={onClose}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{width:80,height:80,borderRadius:22,display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 14px",boxShadow:"0 8px 24px "+alpha(D.accent,25)}}>
            <img src={logo} alt="PickleLive" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
          </div>
          <div style={{fontWeight:900,fontSize:24,color:D.textPrimary,marginBottom:4}}>PickleLive Pro</div>
          <div style={{fontSize:13,color:D.textSecondary}}>Version {APP_VERSION} · Build {APP_BUILD}</div>
        </div>
        {[
          {icon:"🎯",title:"Smart Matchmaking",desc:"Intelligent pairing system for singles and doubles matches with rating-based balancing."},
          {icon:"🏟",title:"Club Management",desc:"Create and manage your own pickleball clubs with events, members, and activities."},
          {icon:"⭐",title:"Rating Engine",desc:"Proprietary ELO-based rating system tracking your Singles and Doubles performance separately."},
          {icon:"👥",title:"Social Network",desc:"Connect with friends, view their stats, and see who's playing near you."},
          {icon:"📅",title:"Event Scheduling",desc:"Plan and join events within your clubs with full capacity and fee management."},
          {icon:"📊",title:"Match History",desc:"Full history of every match you play with detailed statistics and rating changes."},
        ].map(f=>(
          <div key={f.title} style={{display:"flex",gap:14,padding:"14px 0",borderBottom:"1px solid "+D.border}}>
            <div style={{width:42,height:42,borderRadius:12,background:D.accentBg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>{f.icon}</div>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:14,color:D.textPrimary,marginBottom:3}}>{f.title}</div>
              <div style={{fontSize:12,color:D.textSecondary,lineHeight:1.6}}>{f.desc}</div>
            </div>
          </div>
        ))}
        <Card padding="16px" style={{marginTop:24,textAlign:"center"}}>
          <div style={{fontSize:12,color:D.textSecondary,lineHeight:1.7}}>
            Built for the Philippine Pickleball community.<br/>
            Questions? Email <span style={{color:D.accent,fontWeight:600}}>support@picklelive.com</span>
          </div>
        </Card>
    </Panel>
  );
}
