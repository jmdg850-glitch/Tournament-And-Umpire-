import { ini } from "../../lib/utils.js";
import { D, alpha } from "../../theme/tokens.js";


// `live`: true when this player has an active match — draws a pulsing accent
// ring around the avatar (reuses the existing `pulse` keyframe from base.css).
export function Avatar({name,photo,size=40,color=D.blue,badge=null,live=false}){
  const base={width:size,height:size,borderRadius:size/2,flexShrink:0,position:"relative",display:"inline-flex",alignItems:"center",justifyContent:"center"};
  return(
    <div style={{...base,position:"relative"}}>
      {live&&<span style={{position:"absolute",inset:-3,borderRadius:size/2+3,border:`2px solid ${D.live}`,animation:"pulse 1.4s ease-in-out infinite"}}/>}
      {photo
        ?<img src={photo} alt={name} style={{width:size,height:size,borderRadius:size/2,objectFit:"cover"}}/>
        :<div style={{width:size,height:size,borderRadius:size/2,background:alpha(color,13),border:`1.5px solid ${alpha(color,27)}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*0.33,fontWeight:800,color,lineHeight:1}}>
          {ini(name)}
        </div>}
      {badge&&<span style={{position:"absolute",bottom:-2,right:-2,width:14,height:14,borderRadius:7,background:badge==="admin"?D.amber:D.green,border:`2px solid ${D.bg}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:7}}>{badge==="admin"?"★":"✓"}</span>}
    </div>
  );
}
