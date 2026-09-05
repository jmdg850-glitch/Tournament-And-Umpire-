// Ranking/standings helpers — pure, derived live from doneMatches so never stale.
import { RatingEngine } from "./ratingEngine.js";

// Used by the profile panels' "Rank" tile; LeaderboardScreen keeps its own richer multi-filter
// sort logic and deliberately does not route through this (avoids regressing a screen that
// already works, for a purely cosmetic dedupe).
export function buildStandings(players, doneMatches, type="singles"){
  const ratingKey = type==="singles" ? "singlesRating" : "doublesRating";
  return players.map(p=>{
    const relevant = doneMatches.filter(m=>[...(m.teamA||[]),...(m.teamB||[])].includes(p.id));
    const wins = relevant.filter(m=>(m.winner==="A"&&m.teamA?.includes(p.id))||(m.winner==="B"&&m.teamB?.includes(p.id))).length;
    return {...p, wins, losses:relevant.length-wins, matches:relevant.length};
  }).sort((a,b)=>(b[ratingKey]||0)-(a[ratingKey]||0));
}

export function getRankingPosition(playerId, standings){
  const i = standings.findIndex(p=>p.id===playerId);
  return i===-1 ? null : i+1;
}

// Player-profile rating stats — current/highest/lowest/confidence/trend/last match date, all
// derived from the player's bounded ratingHistory (never a second source of truth).
export function ratingStatsFor(player, ratingType="singles"){
  const hist = (player?.ratingHistory||[]).filter(h=>h.type===ratingType);
  const current = ratingType==="singles" ? (+player?.singlesRating||RatingEngine.BASE) : (+player?.doublesRating||RatingEngine.BASE);
  const highest = hist.length ? Math.max(current, ...hist.map(h=>h.after)) : current;
  const lowest  = hist.length ? Math.min(current, ...hist.map(h=>h.after)) : current;
  const last = hist.length ? hist[hist.length-1] : null;
  const baseline = hist.length>=5 ? hist[hist.length-5].after : (hist.length ? hist[0].before : current);
  const trend = current>baseline+0.01 ? "up" : current<baseline-0.01 ? "down" : "flat";
  return {
    current, highest, lowest,
    confidence: RatingEngine.confidenceFor((player?.wins||0)+(player?.losses||0)),
    trend, lastMatchDate: last?.ts || null,
  };
}
