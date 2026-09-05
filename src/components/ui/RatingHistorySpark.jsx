import { D } from "../../theme/tokens.js";

// Minimal inline-SVG rating-history sparkline — no charting dependency. Renders nothing until
// there are at least 2 recorded points for the given rating type.
export function RatingHistorySpark({history, type="singles", width=120, height=28, color}){
  const pts = (history||[]).filter(h=>h.type===type).map(h=>h.after);
  if(pts.length<2) return null;
  const col = color || D.accent;
  const min=Math.min(...pts), max=Math.max(...pts), range=(max-min)||1;
  const xs = pts.map((_,i)=> (i/(pts.length-1))*width );
  const ys = pts.map(v=> height - ((v-min)/range)*height );
  const d = xs.map((x,i)=>`${x},${ys[i]}`).join(" ");
  return(
    <svg width={width} height={height} style={{display:"block"}}>
      <polyline points={d} fill="none" stroke={col} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}
