// SCORING ENGINE — pickleball side-out serving, win-by-2 by default. Pure functions.
//
// bestOf/games/gameNumber/gamesWonA/gamesWonB are additive, tournament-only
// fields: every existing call site omits `bestOf`, so it defaults to 1 and
// every branch below behaves exactly as it did before this was added —
// single game, no games array, match-level winner/status on the first win.
//
// winBy ("two"|"one"|"none") is likewise additive and tournament-only: every existing
// call site omits it, so the default parameter reproduces the original hardcoded
// win-by-2 behavior exactly (scoreA-scoreB>=2). "one" only requires reaching winTo
// ahead by 1; "none" is a straight race — first to winTo wins outright regardless of
// the opponent's score (safe because applyPoint only ever increments one side's score
// per call, so at most one side can cross winTo on any given point).
export const checkGameWin = (scoreA,scoreB,winTo,winBy="two") => {
  if (winBy==="none") return scoreA>=winTo ? "A" : scoreB>=winTo ? "B" : null;
  const required = winBy==="one" ? 1 : 2;
  return (scoreA>=winTo&&scoreA-scoreB>=required) ? "A" : (scoreB>=winTo&&scoreB-scoreA>=required) ? "B" : null;
};

export const DEFAULT_TIMEOUTS_ALLOWED = 2;

// servingTeam is likewise additive: every current call site omits m.servingTeam, so
// the `||"A"` fallback reproduces today's hardcoded first-server exactly. The umpire's
// Toss Coin is HEADS/TAILS-only (per spec it never picks a team or a server), so it
// does not set this — the parameter exists for any future caller that legitimately
// needs to seed first server.
export const newMatchState = m => ({scoreA:0,scoreB:0,server:2,servingTeam:m.servingTeam||"A",history:[],isDoubles:m.isDoubles,winTo:m.winTo,winBy:m.winBy||"two",status:"in_progress",winner:null,rally:0,bestOf:m.bestOf||1,games:[],gameNumber:1,gamesWonA:0,gamesWonB:0,
  timeoutsAllowed:m.timeoutsAllowed||DEFAULT_TIMEOUTS_ALLOWED,timeoutsA:0,timeoutsB:0,timeoutTeam:null,timeoutCalledAt:null});

export function applyPoint(st,team) {
  const snap={scoreA:st.scoreA,scoreB:st.scoreB,server:st.server,servingTeam:st.servingTeam};
  let {scoreA,scoreB,server,servingTeam,isDoubles}=st;
  const hist=[...st.history,snap];
  if(team===servingTeam){if(team==="A")scoreA++;else scoreB++;}
  else if(isDoubles){if(server===1)server=2;else{server=1;servingTeam=servingTeam==="A"?"B":"A";}}
  else{servingTeam=servingTeam==="A"?"B":"A";server=1;}

  const gameWinner=checkGameWin(scoreA,scoreB,st.winTo,st.winBy);
  const bestOf=st.bestOf||1;

  if(!gameWinner){
    return {...st,scoreA,scoreB,server,servingTeam,history:hist,winner:null,status:"in_progress",rally:st.rally+1};
  }
  if(bestOf<=1){
    // Unchanged single-game behavior: match ends on the first game win.
    return {...st,scoreA,scoreB,server,servingTeam,history:hist,winner:gameWinner,status:"completed",rally:st.rally+1};
  }

  // bestOf>1 (tournament matches only): record the finished game, then either
  // end the match (a side reached the majority of games) or start the next one.
  // `history:hist` keeps this game's full point-by-point history so undoPoint can
  // step back across a game boundary, not just within the current (fresh) game.
  const games=[...st.games,{scoreA,scoreB,winner:gameWinner,history:hist}];
  const gamesWonA=st.gamesWonA+(gameWinner==="A"?1:0);
  const gamesWonB=st.gamesWonB+(gameWinner==="B"?1:0);
  const needed=Math.ceil(bestOf/2);
  const matchWinner=gamesWonA>=needed?"A":gamesWonB>=needed?"B":null;
  if(matchWinner){
    return {...st,scoreA,scoreB,server,servingTeam,history:hist,games,gamesWonA,gamesWonB,
      winner:matchWinner,status:"completed",rally:st.rally+1};
  }
  return {...st,scoreA:0,scoreB:0,server:2,servingTeam:"A",history:[],games,gamesWonA,gamesWonB,
    gameNumber:st.gameNumber+1,winner:null,status:"in_progress",rally:st.rally+1};
}

// Timeouts ride on the same live_matches.data jsonb bag as bestOf/games — no
// migration needed. Not part of applyPoint/undoPoint's flow: doesn't touch the
// elapsed-time clock (matches this app's existing precedent that elapsed time
// ticks regardless of pause state) and doesn't affect scoring.
export function callTimeout(st,team){
  const used = team==="A" ? st.timeoutsA : st.timeoutsB;
  if(used>=(st.timeoutsAllowed||DEFAULT_TIMEOUTS_ALLOWED)) return st; // no-op past the limit
  return {...st, ...(team==="A"?{timeoutsA:used+1}:{timeoutsB:used+1}),
    timeoutTeam:team, timeoutCalledAt:new Date().toISOString()};
}
export function clearTimeoutBanner(st){
  return {...st, timeoutTeam:null, timeoutCalledAt:null};
}

export function undoPoint(st){
  if(st.history.length){
    const prev=st.history[st.history.length-1];
    return {...st,...prev,history:st.history.slice(0,-1),status:"in_progress",winner:null};
  }
  // No history left in the current (fresh) game — if a game boundary was just
  // crossed, step back into the previous game instead of no-op'ing.
  if(!st.games||!st.games.length)return st;
  const popped=st.games[st.games.length-1];
  const gh=popped.history||[];
  if(!gh.length)return st;
  const prevSnap=gh[gh.length-1];
  return {...st,
    scoreA:prevSnap.scoreA, scoreB:prevSnap.scoreB, server:prevSnap.server, servingTeam:prevSnap.servingTeam,
    history:gh.slice(0,-1),
    games:st.games.slice(0,-1),
    gamesWonA:st.gamesWonA-(popped.winner==="A"?1:0),
    gamesWonB:st.gamesWonB-(popped.winner==="B"?1:0),
    gameNumber:Math.max(1,st.gameNumber-1),
    status:"in_progress", winner:null,
  };
}

// Manual score correction for the CURRENT game. Must use the same best-of-N
// completion rules as applyPoint — treating a single-game win as a match win
// when bestOf>1 would end a best-of-3 after game 1.
export function applyEditedScore(st, scoreA, scoreB) {
  const gameWinner=checkGameWin(scoreA,scoreB,st.winTo,st.winBy);
  const bestOf=st.bestOf||1;
  const paused=st.status==="paused";

  if(!gameWinner){
    if(st.status==="completed" && bestOf>1 && (st.games||[]).length){
      const popped=st.games[st.games.length-1];
      return {...st, scoreA, scoreB,
        games:st.games.slice(0,-1),
        gamesWonA:st.gamesWonA-(popped.winner==="A"?1:0),
        gamesWonB:st.gamesWonB-(popped.winner==="B"?1:0),
        winner:null, status:"in_progress"};
    }
    return {...st, scoreA, scoreB, winner:null, status:paused?"paused":"in_progress"};
  }

  if(bestOf<=1){
    return {...st, scoreA, scoreB, winner:gameWinner, status:"completed"};
  }

  // Match already complete: rewrite the last recorded game's scores only.
  if(st.status==="completed"){
    const games=(st.games||[]).map((g,i)=>i===st.games.length-1?{...g,scoreA,scoreB,winner:gameWinner}:g);
    return {...st, scoreA, scoreB, games, status:"completed"};
  }

  const games=[...(st.games||[]),{scoreA,scoreB,winner:gameWinner,history:st.history||[]}];
  const gamesWonA=(st.gamesWonA||0)+(gameWinner==="A"?1:0);
  const gamesWonB=(st.gamesWonB||0)+(gameWinner==="B"?1:0);
  const needed=Math.ceil(bestOf/2);
  const matchWinner=gamesWonA>=needed?"A":gamesWonB>=needed?"B":null;
  if(matchWinner){
    return {...st, scoreA, scoreB, games, gamesWonA, gamesWonB, winner:matchWinner, status:"completed"};
  }
  return {...st, scoreA:0, scoreB:0, server:2, servingTeam:"A", history:[],
    games, gamesWonA, gamesWonB, gameNumber:(st.gameNumber||1)+1,
    winner:null, status:"in_progress"};
}
