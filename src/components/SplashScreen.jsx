import logo from "../assets/logo.png";
import { APP_VERSION } from "../lib/utils.js";
import { D } from "../theme/tokens.js";

// =
// ROOT APP
// =
// ================================================================
// LOADING INTRO / SPLASH — brief branded moment, so the gradient end color
// and tagline mint are deliberately a touch brighter than any functional UI
// token (not reused elsewhere); D.dark/D.darkGreen cover what does match.
// ================================================================
export function SplashScreen(){
  return(
    <div style={{position:"fixed",inset:0,zIndex:99999,background:"linear-gradient(160deg,"+D.dark+",#0B3325)",
      display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"var(--font-sans)"}}>
      <style>{`@keyframes plPop{0%{transform:scale(.6);opacity:0}60%{transform:scale(1.08)}100%{transform:scale(1);opacity:1}}
        @keyframes plBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
        @keyframes plFade{from{opacity:0}to{opacity:1}}`}</style>
      <div style={{width:96,height:96,borderRadius:28,display:"flex",alignItems:"center",justifyContent:"center",
        boxShadow:"0 12px 40px rgba(15,123,77,.5)",animation:"plPop .6s ease-out, plBounce 1.6s ease-in-out .6s infinite"}}>
        <img src={logo} alt="PickleLive" style={{width:"100%",height:"100%",objectFit:"contain"}}/>
      </div>
      <div style={{marginTop:22,fontSize:26,fontWeight:900,color:"#fff",letterSpacing:"-.5px",animation:"plFade .8s ease .3s both"}}>PickleLive</div>
      <div style={{marginTop:4,fontSize:12,color:"#7BE0AE",fontWeight:600,animation:"plFade .8s ease .5s both"}}>Play · Track · Connect</div>
      <div style={{marginTop:34,width:26,height:26,border:"3px solid rgba(255,255,255,.2)",borderTopColor:D.darkGreen,borderRadius:"50%",animation:"spin .8s linear infinite"}}/>
      <div style={{position:"absolute",bottom:28,fontSize:10,color:"rgba(255,255,255,.4)",fontWeight:600}}>v{APP_VERSION}</div>
    </div>
  );
}
