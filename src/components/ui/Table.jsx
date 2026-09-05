import { D } from "../../theme/tokens.js";

const MEDALS = ["🥇", "🥈", "🥉"];

// Lightweight styled-table primitives — brings the plain HTML tables used by
// StandingsPanel/TeamStandingsPanel visually in line with LeaderboardScreen's
// polish (rank/medal treatment, consistent padding/typography) without
// abandoning the tabular format, which suits these dense, at-a-glance
// tournament-organizer views better than a card list. Not a data-grid
// abstraction — just the recurring header/row/cell styling factored out.

export function Table({children,style={}}){
  return(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,...style}}>
        {children}
      </table>
    </div>
  );
}

export function Thead({columns}){
  return(
    <thead>
      <tr style={{borderBottom:"1px solid "+D.border}}>
        {columns.map((h,i)=>(
          <th key={h} style={{textAlign:i>=2?"center":"left",padding:"8px 6px",color:D.textMuted,fontWeight:700,fontSize:10,letterSpacing:"0.5px",whiteSpace:"nowrap"}}>{h}</th>
        ))}
      </tr>
    </thead>
  );
}

// `top`: subtle accent background for a top-3 row — the same visual weight
// LeaderboardScreen gives its top-3 cards, so the two "rankings" surfaces in
// the app read as one design language instead of two.
export function Tr({top=false,children}){
  return(
    <tr style={{borderBottom:"1px solid "+D.border,background:top?D.accentBg:"transparent"}}>
      {children}
    </tr>
  );
}

export function Td({children,align="left",strong=false,color}){
  return(
    <td style={{padding:"9px 6px",textAlign:align,fontWeight:strong?700:400,color:color||D.textSecondary}}>
      {children}
    </td>
  );
}

// Rank column cell — medal emoji for the top 3, plain number otherwise,
// mirroring LeaderboardScreen's `medals[i]` rank treatment exactly.
export function RankCell({rank}){
  const i=rank-1;
  const isTop=i>=0&&i<3;
  return(
    <td style={{padding:"9px 6px",fontWeight:900,color:isTop?D.amber:D.textMuted,fontSize:isTop?15:12,fontVariantNumeric:"tabular-nums"}}>
      {isTop?MEDALS[i]:rank}
    </td>
  );
}
