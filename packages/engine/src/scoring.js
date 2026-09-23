// Event-sourced pickleball SIDE-OUT scoring — tournament sport model.
// Pure functions: reconstruct state from ordered events. No Date, no I/O.

export const checkGameWin = (scoreA, scoreB, winTo, winBy = "two") => {
  if (winBy === "none") return scoreA >= winTo ? "A" : scoreB >= winTo ? "B" : null;
  const required = winBy === "one" ? 1 : 2;
  return (scoreA >= winTo && scoreA - scoreB >= required) ? "A"
    : (scoreB >= winTo && scoreB - scoreA >= required) ? "B"
    : null;
};

// Product scoring rule: the target is decided by the match's stage, never by a
// manual choice. Qualification (and any other round) is race to 11; semifinal,
// final and bronze are race to 15. First side to reach the target wins
// immediately — no deuce / win-by-2 (11–10 and 15–14 are final scores).
export const SCORING_WIN_BY = "none";
export const QUALIFICATION_TARGET = 11;
export const PLAYOFF_TARGET = 15;
const PLAYOFF_TARGET_STAGES = ["semifinal", "final", "bronze"];

export function stageScoringTarget(stage) {
  return PLAYOFF_TARGET_STAGES.includes(String(stage || "").toLowerCase()) ? PLAYOFF_TARGET : QUALIFICATION_TARGET;
}

// Resolves the stage that decides a match's scoring target, without relying
// on stage_label alone (single-elim brackets never set it, and team pair
// matches carry their stage on the parent matchup):
//  1. the match's own stage_label, else its parent's (team pair match);
//  2. bracket_side "bronze" → "bronze";
//  3. single-elim main bracket: last round → "final", the one before → "semifinal".
// `related` is any list of matches that includes the match's siblings/parent
// (e.g. every match in the division); missing data falls back to "qualification".
export function matchScoringStage(match, related = []) {
  if (!match) return "qualification";
  if (match.stage_label) return match.stage_label;
  const list = Array.isArray(related) ? related : [];
  if (match.parent_match_id) {
    const parent = list.find((m) => m.id === match.parent_match_id);
    return parent ? matchScoringStage(parent, list) : "qualification";
  }
  if (match.bracket_side === "bronze") return "bronze";
  if (match.bracket_side === "final") return "final";
  const mainSide = (side) => ["main", "winners"].includes(side || "main");
  if (mainSide(match.bracket_side) && Number.isInteger(match.round)) {
    const rounds = list
      .filter((m) => !m.parent_match_id && (mainSide(m.bracket_side) || m.bracket_side === "final")
        && (match.stage_id == null || m.stage_id === match.stage_id)
        && (match.division_id == null || m.division_id === match.division_id))
      .map((m) => m.round)
      .filter(Number.isInteger);
    if (!rounds.length) return "qualification";
    const maxRound = Math.max(match.round, ...rounds);
    if (match.round === maxRound) return "final";
    if (match.round === maxRound - 1) return "semifinal";
  }
  return "qualification";
}

export function matchScoringTarget(match, related = []) {
  return stageScoringTarget(matchScoringStage(match, related));
}

// Validates a manually entered game score against a race-to-N target with no
// deuce. Valid: both sides 0..winTo and not both at winTo. Complete: exactly
// one side is at winTo (e.g. 11–10, 10–11, 15–14).
export function validateFinalScore(scoreA, scoreB, winTo) {
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    return { ok: false, complete: false, reason: "Scores must be whole numbers of 0 or more." };
  }
  if (scoreA > winTo || scoreB > winTo) {
    return { ok: false, complete: false, reason: `This match is race to ${winTo} — a score cannot exceed ${winTo}.` };
  }
  if (scoreA === winTo && scoreB === winTo) {
    return { ok: false, complete: false, reason: `Both sides cannot have ${winTo} — the first to ${winTo} wins.` };
  }
  return { ok: true, complete: scoreA === winTo || scoreB === winTo, reason: null };
}

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
  if (unplayed) return withRules({ ...existing, server: SECOND_SERVE }, settings);
  // A coin toss (lastSeq 1) writes state before start without any rally
  // played; the rules decided at start must still apply to it.
  const noRallyYet = (existing.rally ?? 0) === 0
    && (existing.scoreA ?? 0) === 0
    && (existing.scoreB ?? 0) === 0
    && !(existing.games || []).length
    && !(existing.history || []).length;
  if (noRallyYet) return withRules(existing, settings);
  return existing;
}

function withRules(state, settings) {
  const next = { ...state };
  if (settings.winTo != null) next.winTo = settings.winTo;
  if (settings.winBy != null) next.winBy = settings.winBy;
  return next;
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

// The single authoritative implementation of "given a new current-game score,
// determine game/match winner and advance state accordingly." Both normal
// point-scoring (applyPoint) and a manual score correction (applyCorrection)
// funnel through this so there is never a second, drifting copy of
// winner/game/match settlement logic.
function settleScore(st, scoreA, scoreB, server, servingTeam, hist, rallyDelta) {
  const gameWinner = checkGameWin(scoreA, scoreB, st.winTo, st.winBy);
  const bestOf = st.bestOf || 1;
  const rally = st.rally + rallyDelta;

  if (!gameWinner) {
    return { ...st, scoreA, scoreB, server, servingTeam, history: hist, winner: null, status: "in_progress", rally };
  }
  if (bestOf <= 1) {
    return { ...st, scoreA, scoreB, server, servingTeam, history: hist, winner: gameWinner, status: "completed", rally };
  }

  const games = [...st.games, { scoreA, scoreB, winner: gameWinner, history: hist }];
  const gamesWonA = st.gamesWonA + (gameWinner === "A" ? 1 : 0);
  const gamesWonB = st.gamesWonB + (gameWinner === "B" ? 1 : 0);
  const needed = Math.ceil(bestOf / 2);
  const matchWinner = gamesWonA >= needed ? "A" : gamesWonB >= needed ? "B" : null;
  if (matchWinner) {
    return { ...st, scoreA, scoreB, server, servingTeam, history: hist, games, gamesWonA, gamesWonB,
      winner: matchWinner, status: "completed", rally };
  }
  return { ...st, scoreA: 0, scoreB: 0, server: SECOND_SERVE, servingTeam: "A", history: [], games, gamesWonA, gamesWonB,
    gameNumber: st.gameNumber + 1, winner: null, status: "in_progress", rally };
}

// Same best-of-N / side-out rules as the original applyPoint.
function applyPoint(st, team) {
  const snap = { scoreA: st.scoreA, scoreB: st.scoreB, server: st.server, servingTeam: st.servingTeam };
  let { scoreA, scoreB, server, servingTeam, isDoubles } = st;
  const hist = [...st.history, snap];
  if (team === servingTeam) { if (team === "A") scoreA++; else scoreB++; }
  else if (isDoubles) { if (server === 1) server = 2; else { server = 1; servingTeam = servingTeam === "A" ? "B" : "A"; } }
  else { servingTeam = servingTeam === "A" ? "B" : "A"; server = 1; }

  return settleScore(st, scoreA, scoreB, server, servingTeam, hist, 1);
}

// A manual score correction: directly sets the current game's score (does not
// increment rally count, and deliberately leaves server/servingTeam/courtSide
// untouched — a corrected score jump doesn't imply any particular serve state,
// so the umpire/organizer is responsible for confirming serve after a
// correction if needed). Reuses settleScore so winner/game/match-completion
// consistency is identical to normal point-scoring, not a second
// implementation of the same rules.
function applyCorrection(st, scoreA, scoreB) {
  const snap = { scoreA: st.scoreA, scoreB: st.scoreB, server: st.server, servingTeam: st.servingTeam };
  const hist = [...st.history, snap];
  return settleScore(st, scoreA, scoreB, st.server, st.servingTeam, hist, 0);
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
  } else if (event.type === "correction") {
    const scoreA = payload.scoreA;
    const scoreB = payload.scoreB;
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
      return { state, applied: false };
    }
    if (state.winBy === SCORING_WIN_BY && Number.isInteger(state.winTo)) {
      const check = validateFinalScore(scoreA, scoreB, state.winTo);
      if (!check.ok) return { state, applied: false, code: "INVALID_SCORE", reason: check.reason };
    }
    next = applyCorrection(state, scoreA, scoreB);
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
