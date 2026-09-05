import { D } from "../../theme/tokens.js";

// Minimal content-card primitive — the app has ~65 screens hand-rolling their
// own bordered/padded divs (each reimplementing radius/border/shadow), but no
// shared "group of information" container. This fills that gap for callers
// migrating off ad hoc `<div style={{border:...}}>` blocks. Panel.jsx is a
// different concept (a full-screen drill-down surface), not a content card.
//
// `onClick`: renders a real `<button>` instead of a `<div onClick>` — matches
// the codebase's own established convention for clickable cards (HomeScreen's
// EventCard, ClubsScreen's list rows, etc. are all `<button>`s styled as
// cards) and keeps native keyboard/screen-reader semantics instead of a
// mouse-only div.
export function Card({children,padding=16,onClick,dark=false,style={}}){
  const Tag=onClick?"button":"div";
  return(
    <Tag onClick={onClick} className={onClick?"press":undefined}
      style={{
        background:dark?D.darkCard:D.surface,
        border:`1px solid ${dark?D.darkBorder:D.border}`,
        borderRadius:"var(--r-lg)",
        padding,
        boxShadow:dark?"none":"var(--sh-1)",
        cursor:onClick?"pointer":"default",
        ...(onClick?{width:"100%",textAlign:"left",display:"block",color:"inherit"}:{}),
        ...style,
      }}>
      {children}
    </Tag>
  );
}
