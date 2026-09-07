// Event-sourced pickleball SIDE-OUT scoring — tournament sport model.
// Pure functions: reconstruct state from ordered events. No Date, no I/O.

export const checkGameWin = (scoreA, scoreB, winTo, winBy = "two") => {
  if (winBy === "none") return scoreA >= winTo ? "A" : scoreB >= winTo ? "B" : null;
  const required = winBy === "one" ? 1 : 2;
  return (scoreA >= winTo && scoreA - scoreB >= required) ? "A"
    : (scoreB >= winTo && scoreB - scoreA >= required) ? "B"
    : null;
};

export const DEFAULT_TIMEOUTS_ALLOWED = 2;
export const FIRST_SERVE = 1;
export const SECOND_SERVE = 2;

function normalizeTeam(team) {
  if (team == null) return null;
  const t = String(team).toLowerCase();
  if (t === "a") return "A";
  if (t === "b") return "B";
  return null;
}

function normalizeCourtSide(side) {
  if (side == null) return null;
  const s = String(side).toLowerCase();
  if (s === "left") return "left";
  if (s === "right") return "right";
  return null;
}

export function serveNumber(state) {
  return Number(state?.server) === FIRST_SERVE ? FIRST_SERVE : SECOND_SERVE;
}

export function serveStatusLabel(state) {
  return serveNumber(state) === FIRST_SERVE ? "FIRST SERVE" : "SECOND SERVE";
}

export function coinFaceFromByte(byte) {
  return (Number(byte) & 1) === 0 ? "heads" : "tails";
}

export function normalizeCoinTossPayload(payload = {}, fallbackServingTeam = "A") {
  const nested = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const raw = nested.result ?? nested.outcome ?? (typeof payload === "string" || typeof payload === "number" ? payload : null);
  const lower = String(raw ?? "").toLowerCase();
  let result = null;
  let winner = normalizeTeam(nested.winner);
  if (lower === "heads" || lower === "h") result = "heads";
  else if (lower === "tails" || lower === "t") result = "tails";
  else if (lower === "a") {
    result = "heads";
    winner = winner || "A";
  } else if (lower === "b") {
    result = "tails";
    winner = winner || "B";
  }
  const servingFromPayload = normalizeTeam(nested.servingTeam ?? nested.serving_team);
  if (!winner && result === "heads") winner = "A";
  if (!winner && result === "tails") winner = "B";
  if (!winner) winner = servingFromPayload || normalizeTeam(fallbackServingTeam) || "A";
  if (!result) result = winner === "B" ? "tails" : "heads";
  const servingTeam = servingFromPayload || winner;
  const courtSide = normalizeCourtSide(nested.courtSide ?? nested.court_side);
  return { result, winner, servingTeam, courtSide };
}

export function readCoinToss(match) {
  if (!match) return null;
  const raw = match.coin_toss;
  if (raw != null && raw !== "") {
    if (typeof raw === "object" && !Array.isArray(raw)) {
      const hasFace = raw.result != null || raw.outcome != null || raw.winner != null || raw.servingTeam != null || raw.serving_team != null;
      if (hasFace) return normalizeCoinTossPayload(raw, match.serving_team || match.score_state?.servingTeam);
    } else {
      return normalizeCoinTossPayload(raw, match.serving_team || match.score_state?.servingTeam);
    }
  }
  if (match.score_state?.coinToss != null && match.score_state.coinToss !== "") {
    return normalizeCoinTossPayload({
      result: match.score_state.coinToss,
      winner: match.score_state.tossWinner,
      servingTeam: match.score_state.servingTeam,
      courtSide: match.score_state.courtSide,
    }, match.serving_team);
  }
  return null;
}

export function isCoinTossCommitted(match) {
  return readCoinToss(match) != null;
}

export function scoreStateForMatchStart(match, settings = {}) {
  const existing = match?.score_state;
  if (!existing || typeof existing !== "object" || Object.keys(existing).length === 0) {
    return createInitialScoreState(settings);
  }
  const unplayed = (existing.lastSeq ?? 0) === 0
    && (existing.scoreA ?? 0) === 0
    && (existing.scoreB ?? 0) === 0
    && !(existing.games || []).length;
  if (unplayed) return { ...existing, server: SECOND_SERVE };
  return existing;
}

export function createInitialScoreState(settings = {}) {
  return {
    scoreA: 0,
    scoreB: 0,
    server: SECOND_SERVE,
    servingTeam: normalizeTeam(settings.servingTeam) || "A",
    history: [],
    isDoubles: settings.isDoubles,
    winTo: settings.winTo,
    winBy: settings.winBy || "two",
    status: "in_progress",
    winner: null,
    rally: 0,
    bestOf: settings.bestOf || 1,
    games: [],
    gameNumber: 1,
    gamesWonA: 0,
    gamesWonB: 0,
    timeoutsAllowed: settings.timeoutsAllowed || DEFAULT_TIMEOUTS_ALLOWED,
    timeoutsA: 0,
    timeoutsB: 0,
    timeoutTeam: null,
    timeoutCalledAt: null,
    coinToss: null,
    tossWinner: null,
    appliedEventIds: [],
    lastSeq: 0,
  };
}

// Same best-of-N / side-out rules as the original applyPoint.
function applyPoint(st, team) {
  const snap = { scoreA: st.scoreA, scoreB: st.scoreB, server: st.server, servingTeam: st.servingTeam };
  let { scoreA, scoreB, server, servingTeam, isDoubles } = st;
  const hist = [...st.history, snap];
  if (team === servingTeam) { if (team === "A") scoreA++; else scoreB++; }
  else if (isDoubles) { if (server === 1) server = 2; else { server = 1; servingTeam = servingTeam === "A" ? "B" : "A"; } }
  else { servingTeam = servingTeam === "A" ? "B" : "A"; server = 1; }

  const gameWinner = checkGameWin(scoreA, scoreB, st.winTo, st.winBy);
  const bestOf = st.bestOf || 1;

  if (!gameWinner) {
    return { ...st, scoreA, scoreB, server, servingTeam, history: hist, winner: null, status: "in_progress", rally: st.rally + 1 };
  }
  if (bestOf <= 1) {
    return { ...st, scoreA, scoreB, server, servingTeam, history: hist, winner: gameWinner, status: "completed", rally: st.rally + 1 };
  }

  const games = [...st.games, { scoreA, scoreB, winner: gameWinner, history: hist }];
  const gamesWonA = st.gamesWonA + (gameWinner === "A" ? 1 : 0);
  const gamesWonB = st.gamesWonB + (gameWinner === "B" ? 1 : 0);
  const needed = Math.ceil(bestOf / 2);
  const matchWinner = gamesWonA >= needed ? "A" : gamesWonB >= needed ? "B" : null;
  if (matchWinner) {
    return { ...st, scoreA, scoreB, server, servingTeam, history: hist, games, gamesWonA, gamesWonB,
      winner: matchWinner, status: "completed", rally: st.rally + 1 };
  }
  return { ...st, scoreA: 0, scoreB: 0, server: SECOND_SERVE, servingTeam: "A", history: [], games, gamesWonA, gamesWonB,
    gameNumber: st.gameNumber + 1, winner: null, status: "in_progress", rally: st.rally + 1 };
}

function undoPoint(st) {
  if (st.history.length) {
    const prev = st.history[st.history.length - 1];
    return { ...st, ...prev, history: st.history.slice(0, -1), status: "in_progress", winner: null };
  }
  if (!st.games || !st.games.length) return st;
  const popped = st.games[st.games.length - 1];
  const gh = popped.history || [];
  if (!gh.length) return st;
  const prevSnap = gh[gh.length - 1];
  return { ...st,
    scoreA: prevSnap.scoreA, scoreB: prevSnap.scoreB, server: prevSnap.server, servingTeam: prevSnap.servingTeam,
    history: gh.slice(0, -1),
    games: st.games.slice(0, -1),
    gamesWonA: st.gamesWonA - (popped.winner === "A" ? 1 : 0),
    gamesWonB: st.gamesWonB - (popped.winner === "B" ? 1 : 0),
    gameNumber: Math.max(1, st.gameNumber - 1),
    status: "in_progress", winner: null,
  };
}

function callTimeout(st, team, calledAt) {
  const used = team === "A" ? st.timeoutsA : st.timeoutsB;
  if (used >= (st.timeoutsAllowed || DEFAULT_TIMEOUTS_ALLOWED)) return st;
  return { ...st, ...(team === "A" ? { timeoutsA: used + 1 } : { timeoutsB: used + 1 }),
    timeoutTeam: team, timeoutCalledAt: calledAt ?? null };
}

function recordEvent(state, event, next) {
  return {
    ...next,
    appliedEventIds: [...(state.appliedEventIds || []), event.id],
    lastSeq: event.seq,
  };
}

export function applyScoreEvent(state, event) {
  if (!event) return { state, applied: false };
  if ((state.appliedEventIds || []).includes(event.id)) {
    return { state, applied: false, duplicate: true };
  }
  const lastSeq = state.lastSeq ?? 0;
  if (typeof event.seq !== "number" || event.seq <= lastSeq) {
    const err = new Error(`Events must be applied in seq order (lastSeq=${lastSeq}, got ${event.seq})`);
    err.code = "OUT_OF_ORDER";
    throw err;
  }

  const payload = event.payload || {};
  let next = state;

  if (event.type === "point") {
    const team = normalizeTeam(payload.team);
    if (!team) return { state, applied: false };
    next = applyPoint(state, team);
  } else if (event.type === "undo") {
    next = undoPoint(state);
  } else if (event.type === "timeout") {
    const team = normalizeTeam(payload.team);
    if (!team) return { state, applied: false };
    next = callTimeout(state, team, payload.calledAt);
  } else if (event.type === "coin_toss") {
    if (state.coinToss != null && state.coinToss !== "") {
      return { state, applied: false, duplicate: true };
    }
    const toss = normalizeCoinTossPayload(payload, state.servingTeam);
    next = { ...state, coinToss: toss.result, tossWinner: toss.winner };
    if (payload.servingTeam != null || payload.serving_team != null) {
      next.servingTeam = toss.servingTeam;
    }
    if (toss.courtSide != null) {
      next.courtSide = toss.courtSide;
    }
  } else {
    return { state, applied: false };
  }

  return { state: recordEvent(state, event, next), applied: true };
}

export function reduceScoreEvents(settings, events) {
  const sorted = [...(events || [])].sort((a, b) => a.seq - b.seq);
  let state = createInitialScoreState(settings);
  for (const event of sorted) {
    const result = applyScoreEvent(state, event);
    state = result.state;
  }
  return state;
}
