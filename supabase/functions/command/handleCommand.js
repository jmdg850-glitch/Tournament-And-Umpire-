// packages/engine/src/lifecycle.js
var TOURNAMENT_STATUSES = Object.freeze([
  "draft",
  "registration",
  "registration_closed",
  "ready",
  "in_progress",
  "completed",
  "cancelled",
  "archived"
]);
var MATCH_STATUSES = Object.freeze([
  "scheduled",
  "ready",
  "assigned",
  "in_progress",
  "completed",
  "postponed",
  "cancelled",
  "abandoned",
  "bye"
]);
var TOURNAMENT_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["registration", "cancelled"]),
  registration: Object.freeze(["registration_closed", "cancelled"]),
  registration_closed: Object.freeze(["ready", "cancelled"]),
  ready: Object.freeze(["in_progress", "cancelled"]),
  in_progress: Object.freeze(["completed", "cancelled"]),
  completed: Object.freeze(["archived"]),
  cancelled: Object.freeze(["archived"]),
  archived: Object.freeze([])
});
var MATCH_TRANSITIONS = Object.freeze({
  scheduled: Object.freeze(["ready", "assigned", "postponed", "cancelled"]),
  ready: Object.freeze(["assigned", "in_progress", "postponed", "cancelled"]),
  assigned: Object.freeze(["in_progress", "postponed", "cancelled", "ready"]),
  in_progress: Object.freeze(["completed", "abandoned", "postponed"]),
  postponed: Object.freeze(["scheduled", "ready", "cancelled"]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
  abandoned: Object.freeze([]),
  bye: Object.freeze([])
});
function canTransition(map, from, to) {
  const allowed = map[from];
  if (!allowed) return false;
  return allowed.includes(to);
}
function assertTransition(map, kind, from, to) {
  if (canTransition(map, from, to)) return true;
  const err = new Error(`Illegal ${kind} transition: ${from} -> ${to}`);
  err.code = "ILLEGAL_TRANSITION";
  throw err;
}
function assertTransitionTournament(from, to) {
  return assertTransition(TOURNAMENT_TRANSITIONS, "tournament", from, to);
}
function assertTransitionMatch(from, to) {
  return assertTransition(MATCH_TRANSITIONS, "match", from, to);
}

// packages/engine/src/scoring.js
var checkGameWin = (scoreA, scoreB, winTo, winBy = "two") => {
  if (winBy === "none") return scoreA >= winTo ? "A" : scoreB >= winTo ? "B" : null;
  const required = winBy === "one" ? 1 : 2;
  return scoreA >= winTo && scoreA - scoreB >= required ? "A" : scoreB >= winTo && scoreB - scoreA >= required ? "B" : null;
};
var DEFAULT_TIMEOUTS_ALLOWED = 2;
var SECOND_SERVE = 2;
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
function normalizeCoinTossPayload(payload = {}, fallbackServingTeam = "A") {
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
function readCoinToss(match) {
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
      courtSide: match.score_state.courtSide
    }, match.serving_team);
  }
  return null;
}
function scoreStateForMatchStart(match, settings = {}) {
  const existing = match?.score_state;
  if (!existing || typeof existing !== "object" || Object.keys(existing).length === 0) {
    return createInitialScoreState(settings);
  }
  const unplayed = (existing.lastSeq ?? 0) === 0 && (existing.scoreA ?? 0) === 0 && (existing.scoreB ?? 0) === 0 && !(existing.games || []).length;
  if (unplayed) return { ...existing, server: SECOND_SERVE };
  return existing;
}
function createInitialScoreState(settings = {}) {
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
    lastSeq: 0
  };
}
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
    return {
      ...st,
      scoreA,
      scoreB,
      server,
      servingTeam,
      history: hist,
      games,
      gamesWonA,
      gamesWonB,
      winner: matchWinner,
      status: "completed",
      rally
    };
  }
  return {
    ...st,
    scoreA: 0,
    scoreB: 0,
    server: SECOND_SERVE,
    servingTeam: "A",
    history: [],
    games,
    gamesWonA,
    gamesWonB,
    gameNumber: st.gameNumber + 1,
    winner: null,
    status: "in_progress",
    rally
  };
}
function applyPoint(st, team) {
  const snap = { scoreA: st.scoreA, scoreB: st.scoreB, server: st.server, servingTeam: st.servingTeam };
  let { scoreA, scoreB, server, servingTeam, isDoubles } = st;
  const hist = [...st.history, snap];
  if (team === servingTeam) {
    if (team === "A") scoreA++;
    else scoreB++;
  } else if (isDoubles) {
    if (server === 1) server = 2;
    else {
      server = 1;
      servingTeam = servingTeam === "A" ? "B" : "A";
    }
  } else {
    servingTeam = servingTeam === "A" ? "B" : "A";
    server = 1;
  }
  return settleScore(st, scoreA, scoreB, server, servingTeam, hist, 1);
}
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
  return {
    ...st,
    scoreA: prevSnap.scoreA,
    scoreB: prevSnap.scoreB,
    server: prevSnap.server,
    servingTeam: prevSnap.servingTeam,
    history: gh.slice(0, -1),
    games: st.games.slice(0, -1),
    gamesWonA: st.gamesWonA - (popped.winner === "A" ? 1 : 0),
    gamesWonB: st.gamesWonB - (popped.winner === "B" ? 1 : 0),
    gameNumber: Math.max(1, st.gameNumber - 1),
    status: "in_progress",
    winner: null
  };
}
function callTimeout(st, team, calledAt) {
  const used = team === "A" ? st.timeoutsA : st.timeoutsB;
  if (used >= (st.timeoutsAllowed || DEFAULT_TIMEOUTS_ALLOWED)) return st;
  return {
    ...st,
    ...team === "A" ? { timeoutsA: used + 1 } : { timeoutsB: used + 1 },
    timeoutTeam: team,
    timeoutCalledAt: calledAt ?? null
  };
}
function recordEvent(state, event, next) {
  return {
    ...next,
    appliedEventIds: [...state.appliedEventIds || [], event.id],
    lastSeq: event.seq
  };
}
function applyScoreEvent(state, event) {
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
function reduceScoreEvents(settings, events) {
  const sorted = [...events || []].sort((a, b) => a.seq - b.seq);
  let state = createInitialScoreState(settings);
  for (const event of sorted) {
    const result = applyScoreEvent(state, event);
    state = result.state;
  }
  return state;
}

// packages/engine/src/bracket.js
function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const k = order.length;
    order = order.flatMap((s) => [s, 2 * k + 1 - s]);
  }
  return order;
}
var defaultId = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function generateBracket(registrations, { makeId, bronzeMatch } = {}) {
  const genId = makeId || defaultId;
  const n = registrations.length;
  if (n < 2) return [];
  let size = 1;
  while (size < n) size *= 2;
  const totalRounds = Math.log2(size);
  const order = seedOrder(size);
  const seedReg = (s) => s <= n ? registrations[s - 1] : null;
  const slots = order.map(seedReg);
  const rounds = [];
  let roundSize = size / 2;
  for (let r = 0; r < totalRounds; r++) {
    const shells = [];
    for (let i = 0; i < roundSize; i++) {
      shells.push({
        id: genId(),
        round: r + 1,
        bracketPosition: i,
        registrationAId: null,
        registrationBId: null,
        status: "scheduled",
        winner: null
      });
    }
    rounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize / 2));
  }
  for (let i = 0; i < rounds[0].length; i++) {
    const a = slots[i * 2], b = slots[i * 2 + 1];
    const m = rounds[0][i];
    m.registrationAId = a?.id ?? null;
    m.registrationBId = b?.id ?? null;
    if (!a || !b) {
      m.status = "bye";
      m.winner = a ? "A" : "B";
    }
  }
  for (let r = 0; r < rounds.length - 1; r++) {
    for (let i = 0; i < rounds[r].length; i++) {
      const m = rounds[r][i];
      const next = rounds[r + 1][Math.floor(i / 2)];
      m.nextMatchId = next.id;
      m.nextMatchSlot = i % 2 === 0 ? "A" : "B";
      if (m.status === "bye" && m.winner) {
        const winnerId = m.winner === "A" ? m.registrationAId : m.registrationBId;
        if (m.nextMatchSlot === "A") next.registrationAId = winnerId;
        else next.registrationBId = winnerId;
      }
    }
  }
  const bracketMatches = rounds.flat();
  if (bronzeMatch && totalRounds >= 2) {
    const semis = rounds[totalRounds - 2];
    const bronze = {
      id: genId(),
      round: totalRounds,
      bracketPosition: 1,
      registrationAId: null,
      registrationBId: null,
      status: "scheduled",
      winner: null,
      bracketSide: "bronze"
    };
    semis[0].loserNextMatchId = bronze.id;
    semis[0].loserNextMatchSlot = "A";
    semis[1].loserNextMatchId = bronze.id;
    semis[1].loserNextMatchSlot = "B";
    bracketMatches.push(bronze);
  }
  return bracketMatches;
}
function advanceBracket(matches, completedMatchId, winnerRegistrationId) {
  const completed = matches.find((m) => m.id === completedMatchId);
  if (!completed?.nextMatchId) return null;
  const next = matches.find((m) => m.id === completed.nextMatchId);
  if (!next) return null;
  const slotKey = completed.nextMatchSlot === "A" ? "registrationAId" : "registrationBId";
  return {
    matchId: next.id,
    patch: { [slotKey]: winnerRegistrationId, status: "scheduled" }
  };
}
function advanceBronzeMatchSlot(matches, completedMatchId, loserRegistrationId) {
  const completed = matches.find((m) => m.id === completedMatchId);
  if (!completed?.loserNextMatchId) return null;
  const bronze = matches.find((m) => m.id === completed.loserNextMatchId);
  if (!bronze) return null;
  const slotKey = completed.loserNextMatchSlot === "A" ? "registrationAId" : "registrationBId";
  return {
    matchId: bronze.id,
    patch: { [slotKey]: loserRegistrationId, status: "scheduled" }
  };
}

// packages/engine/src/roundRobin.js
function generateRoundRobinSchedule(registrations) {
  const ids = registrations.map((r) => r.id);
  let seats = [...ids];
  if (seats.length % 2 !== 0) seats.push(null);
  const n = seats.length;
  if (n < 2) return { rounds: [] };
  const rounds = [];
  for (let r = 0; r < n - 1; r++) {
    const matches = [];
    for (let i = 0; i < n / 2; i++) {
      const a = seats[i], b = seats[n - 1 - i];
      matches.push({ registrationAId: a, registrationBId: b, isBye: a == null || b == null });
    }
    rounds.push({ round: r + 1, matches });
    seats = [seats[0], seats[n - 1], ...seats.slice(1, n - 1)];
  }
  return { rounds };
}

// packages/engine/src/teamVsTeam.js
var defaultId2 = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function rankTeams(teams) {
  return [...teams].sort((a, b) => {
    const minA = Math.min(...a.pairs.map((p) => p.seed ?? Infinity));
    const minB = Math.min(...b.pairs.map((p) => p.seed ?? Infinity));
    return minA !== minB ? minA - minB : String(a.teamId).localeCompare(String(b.teamId));
  });
}
function groupRegistrationsByTeam(registrations, teamGroups) {
  const byTeam = new Map((teamGroups || []).map((t) => [t.id, { teamId: t.id, teamName: t.name, bracketGroup: t.bracketGroup || null, pairs: [] }]));
  const unassigned = [];
  for (const r of registrations || []) {
    if (r.teamId && byTeam.has(r.teamId)) byTeam.get(r.teamId).pairs.push(r);
    else unassigned.push(r);
  }
  for (const team of byTeam.values()) team.pairs.sort((a, c) => (a.seed ?? Infinity) - (c.seed ?? Infinity));
  const teams = [...byTeam.values()].filter((t) => t.pairs.length > 0);
  const summary = teams.map((t) => ({ teamId: t.teamId, teamName: t.teamName, count: t.pairs.length }));
  if (unassigned.length > 0) return { ok: false, error: "unassigned_pairs", teams: summary, unassignedCount: unassigned.length };
  if (teams.length < 2) return { ok: false, error: "too_few_teams", teams: summary };
  if (new Set(teams.map((t) => t.pairs.length)).size > 1) return { ok: false, error: "uneven_team_sizes", teams: summary };
  if (teams.some((t) => t.pairs.length < 2)) return { ok: false, error: "team_too_small", teams: summary };
  return { ok: true, teams };
}
function buildPairMatchesForMatchup(matchup, teams, makeId) {
  const genId = makeId || defaultId2;
  const teamA = teams.find((t) => t.teamId === matchup.teamAId);
  const teamB = teams.find((t) => t.teamId === matchup.teamBId);
  if (!teamA || !teamB) return [];
  const n = teamA.pairs.length;
  const rows = [];
  for (let r = 0; r < n - 1; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + r) % n;
      rows.push({
        id: genId(),
        round: matchup.round,
        bracketPosition: matchup.bracketPosition,
        registrationAId: teamA.pairs[i].id,
        registrationBId: teamB.pairs[j].id,
        status: "scheduled",
        winner: null,
        teamMatchupId: matchup.id,
        pairSlot: r * n + i + 1
      });
    }
  }
  return rows;
}
function advanceIndividualMatchup(matchups, completedMatchupId, winnerRegistrationId, winnerTeamId) {
  const completed = matchups.find((m) => m.id === completedMatchupId);
  if (!completed?.nextMatchupId) return null;
  const next = matchups.find((m) => m.id === completed.nextMatchupId);
  if (!next) return null;
  const pairSlotKey = completed.nextMatchupSlot === "A" ? "pairAId" : "pairBId";
  const teamSlotKey = completed.nextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: next.id, patch: { [pairSlotKey]: winnerRegistrationId, [teamSlotKey]: winnerTeamId, status: "scheduled" } };
}
function advanceBronzeIndividualMatchup(matchups, completedMatchupId, loserRegistrationId, loserTeamId) {
  const completed = matchups.find((m) => m.id === completedMatchupId);
  if (!completed?.loserNextMatchupId) return null;
  const bronze = matchups.find((m) => m.id === completed.loserNextMatchupId);
  if (!bronze) return null;
  const pairSlotKey = completed.loserNextMatchupSlot === "A" ? "pairAId" : "pairBId";
  const teamSlotKey = completed.loserNextMatchupSlot === "A" ? "teamAId" : "teamBId";
  return { matchupId: bronze.id, patch: { [pairSlotKey]: loserRegistrationId, [teamSlotKey]: loserTeamId, status: "scheduled" } };
}
function stableTiebreak(idA, idB) {
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) | 0;
    return h;
  };
  const parity = hash([idA, idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}
function finalizeCrossTeamMatchup(matchup, allPairMatches) {
  const own = (allPairMatches || []).filter((m) => m.teamMatchupId === matchup.id);
  if (own.length === 0 || !own.every((m) => m.status === "completed")) return null;
  let teamAWins = 0, teamBWins = 0, diffA = 0;
  for (const m of own) {
    if (m.winner === "A") teamAWins++;
    else if (m.winner === "B") teamBWins++;
    const sA = m.score?.scoreA ?? 0, sB = m.score?.scoreB ?? 0;
    diffA += sA - sB;
  }
  let winnerTeamId;
  if (teamAWins !== teamBWins) winnerTeamId = teamAWins > teamBWins ? matchup.teamAId : matchup.teamBId;
  else if (diffA !== 0) winnerTeamId = diffA > 0 ? matchup.teamAId : matchup.teamBId;
  else winnerTeamId = stableTiebreak(matchup.teamAId, matchup.teamBId) < 0 ? matchup.teamAId : matchup.teamBId;
  return { teamAWins, teamBWins, winnerTeamId };
}

// packages/engine/src/teamRoundRobin.js
var defaultId3 = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function generateTeamRoundRobinMatchups(teams, { makeId } = {}) {
  const genId = makeId || defaultId3;
  const pairsPerMatchup = teams[0].pairs.length;
  const ranked = rankTeams(teams);
  const { rounds } = generateRoundRobinSchedule(ranked.map((t) => ({ id: t.teamId })));
  const teamMatchups = [];
  const pairMatches = [];
  for (const rnd of rounds) {
    let pos = 0;
    for (const match of rnd.matches) {
      if (match.isBye) continue;
      const shell = {
        id: genId(),
        round: rnd.round,
        bracketPosition: pos++,
        teamAId: match.registrationAId,
        teamBId: match.registrationBId,
        teamAWins: 0,
        teamBWins: 0,
        pairsPerMatchup,
        winnerTeamId: null,
        status: "scheduled",
        stage: "round_robin",
        stageLabel: "Round " + rnd.round
      };
      teamMatchups.push(shell);
      pairMatches.push(...buildPairMatchesForMatchup(shell, teams, genId));
    }
  }
  assertNoRepeatPairOpponents(pairMatches);
  return { teamMatchups, pairMatches };
}
function assertNoRepeatPairOpponents(pairMatches) {
  const seen = /* @__PURE__ */ new Set();
  for (const m of pairMatches || []) {
    if (!m.registrationAId || !m.registrationBId) continue;
    const key = [m.registrationAId, m.registrationBId].sort().join("|");
    if (seen.has(key)) {
      const err = new Error("Duplicate pair-vs-pair opponent in elimination schedule");
      err.code = "REPEAT_OPPONENT";
      throw err;
    }
    seen.add(key);
  }
}
function isTeamRoundRobinComplete(teamMatchups) {
  const rows = (teamMatchups || []).filter((m) => m.stage === "round_robin");
  return rows.length > 0 && rows.every((m) => m.status === "completed");
}
function stablePairTiebreak(idA, idB) {
  const hash = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = h * 31 + s.charCodeAt(i) | 0;
    return h;
  };
  const parity = hash([idA, idB].sort().join("|")) % 2 === 0 ? -1 : 1;
  return idA < idB ? parity : -parity;
}
function rankIndividualPairsForSemifinals(teams, teamMatchups, pairMatches) {
  const roundRobinMatchupIds = new Set((teamMatchups || []).filter((m) => m.stage === "round_robin").map((m) => m.id));
  const completed = (pairMatches || []).filter((m) => m.status === "completed" && roundRobinMatchupIds.has(m.teamMatchupId));
  const rows = /* @__PURE__ */ new Map();
  for (const team of teams) {
    for (const pair of team.pairs) {
      rows.set(pair.id, {
        registrationId: pair.id,
        teamId: team.teamId,
        teamName: team.teamName,
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        pointDiff: 0,
        matchesPlayed: 0
      });
    }
  }
  for (const m of completed) {
    const a = rows.get(m.registrationAId), b = rows.get(m.registrationBId);
    if (!a || !b) continue;
    const ptsA = m.score?.scoreA ?? 0, ptsB = m.score?.scoreB ?? 0;
    a.matchesPlayed++;
    b.matchesPlayed++;
    a.pointsFor += ptsA;
    a.pointsAgainst += ptsB;
    b.pointsFor += ptsB;
    b.pointsAgainst += ptsA;
    if (m.winner === "A") {
      a.wins++;
      b.losses++;
    } else if (m.winner === "B") {
      b.wins++;
      a.losses++;
    }
  }
  for (const r of rows.values()) r.pointDiff = r.pointsFor - r.pointsAgainst;
  const sorted = [...rows.values()].sort((x, y) => {
    if (y.wins !== x.wins) return y.wins - x.wins;
    if (x.losses !== y.losses) return x.losses - y.losses;
    if (y.pointDiff !== x.pointDiff) return y.pointDiff - x.pointDiff;
    if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
    return stablePairTiebreak(x.registrationId, y.registrationId);
  });
  return sorted.map((r, i) => ({ ...r, rank: i + 1 }));
}

// packages/engine/src/teamPlayoffs.js
var defaultId4 = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
function nextPow2(n) {
  let s = 1;
  while (s < n) s *= 2;
  return s;
}
function podSizeForPolicy(policy, size) {
  const base = { avoid_quarterfinals: 2, avoid_semis: 4, avoid_until_final: Infinity }[policy] || 0;
  return base === 0 ? 0 : Math.min(base, size / 2);
}
function teamOfSeedFactory(qualifiers) {
  return (seed) => seed != null && seed <= qualifiers.length ? qualifiers[seed - 1].teamId : null;
}
function podHasTeam(order, teamOf, podStart, podSize, team, excludeSlot) {
  for (let i = podStart; i < podStart + podSize; i++) {
    if (i === excludeSlot) continue;
    if (teamOf(order[i]) === team) return true;
  }
  return false;
}
function repairPods(order, qualifiers, podSize) {
  const result = [...order];
  const size = result.length;
  const teamOf = teamOfSeedFactory(qualifiers);
  const excessSlots = [];
  for (let podStart = 0; podStart < size; podStart += podSize) {
    const seen = /* @__PURE__ */ new Set();
    for (let i = podStart; i < podStart + podSize; i++) {
      const team = teamOf(result[i]);
      if (team == null) continue;
      if (seen.has(team)) excessSlots.push(i);
      else seen.add(team);
    }
  }
  for (const i of excessSlots) {
    const podStartI = Math.floor(i / podSize) * podSize;
    const teamI = teamOf(result[i]);
    if (teamI == null) continue;
    let best = null, bestCost = Infinity;
    for (let j = 0; j < size; j++) {
      const podStartJ = Math.floor(j / podSize) * podSize;
      if (podStartJ === podStartI) continue;
      const teamJ = teamOf(result[j]);
      if (teamJ != null && podHasTeam(result, teamOf, podStartI, podSize, teamJ, i)) continue;
      if (podHasTeam(result, teamOf, podStartJ, podSize, teamI, j)) continue;
      const cost = Math.abs(result[i] - result[j]);
      if (cost < bestCost) {
        bestCost = cost;
        best = j;
      }
    }
    if (best != null) {
      const tmp = result[i];
      result[i] = result[best];
      result[best] = tmp;
    }
  }
  return result;
}
function detectConflicts(order, qualifiers, podSize) {
  if (podSize < 2) return [];
  const teamOf = teamOfSeedFactory(qualifiers);
  const conflicts = [];
  for (let podStart = 0; podStart < order.length; podStart += podSize) {
    const seenAt = /* @__PURE__ */ new Map();
    for (let i = podStart; i < podStart + podSize; i++) {
      const team = teamOf(order[i]);
      if (team == null) continue;
      if (seenAt.has(team)) conflicts.push({ teamId: team, slots: [seenAt.get(team), i] });
      else seenAt.set(team, i);
    }
  }
  return conflicts;
}
function placeQualifiersWithPolicy(qualifiers, policy) {
  const size = nextPow2(qualifiers.length);
  const podSize = podSizeForPolicy(policy, size);
  let seedSlots = seedOrder(size);
  if (podSize > 1) seedSlots = repairPods(seedSlots, qualifiers, podSize);
  const conflicts = detectConflicts(seedSlots, qualifiers, podSize);
  const order = seedSlots.map((s) => s <= qualifiers.length ? qualifiers[s - 1] : null);
  return { order, conflicts, size };
}
function selectQualifiers(rankedPairs, mode, count) {
  if (mode === "top_x") return rankedPairs.slice(0, Math.max(0, Number(count) || 4));
  if (mode === "top_x_per_team") {
    const perTeamCount = /* @__PURE__ */ new Map();
    const keepIds = /* @__PURE__ */ new Set();
    for (const p of rankedPairs) {
      const c = perTeamCount.get(p.teamId) || 0;
      if (c < count) {
        keepIds.add(p.registrationId);
        perTeamCount.set(p.teamId, c + 1);
      }
    }
    return rankedPairs.filter((p) => keepIds.has(p.registrationId));
  }
  return [];
}
function knockoutStageLabel(fromFinal) {
  if (fromFinal === 1) return "Semifinal";
  if (fromFinal === 2) return "Quarterfinal";
  return "Round of " + Math.pow(2, fromFinal + 1);
}
function buildFinalShell(id, round) {
  return {
    id,
    round,
    bracketPosition: 0,
    teamAId: null,
    teamBId: null,
    pairAId: null,
    pairBId: null,
    teamAWins: 0,
    teamBWins: 0,
    pairsPerMatchup: 1,
    winnerTeamId: null,
    status: "scheduled",
    stage: "final",
    stageLabel: "Final"
  };
}
function buildBronzeShell(id, round) {
  return {
    id,
    round,
    bracketPosition: 1,
    teamAId: null,
    teamBId: null,
    pairAId: null,
    pairBId: null,
    teamAWins: 0,
    teamBWins: 0,
    pairsPerMatchup: 1,
    winnerTeamId: null,
    status: "scheduled",
    bracketSide: "bronze",
    stage: "bronze",
    stageLabel: "Bronze Match"
  };
}
function buildChildMatch(genId, matchup) {
  return {
    id: genId(),
    round: matchup.round,
    bracketPosition: matchup.bracketPosition,
    registrationAId: matchup.pairAId,
    registrationBId: matchup.pairBId,
    status: "scheduled",
    winner: null,
    teamMatchupId: matchup.id,
    pairSlot: 1
  };
}
function generateQualifierBracketShell(qualifiers, { makeId, startRound = 1, sameTeamPolicy = "allow_anywhere" } = {}) {
  const genId = makeId || defaultId4;
  const M = qualifiers.length;
  if (M < 2) return { teamMatchups: [], pairMatches: [], conflicts: [] };
  if (M === 2) {
    const final2 = {
      ...buildFinalShell(genId(), startRound),
      teamAId: qualifiers[0].teamId,
      teamBId: qualifiers[1].teamId,
      pairAId: qualifiers[0].registrationId,
      pairBId: qualifiers[1].registrationId
    };
    return { teamMatchups: [final2], pairMatches: [buildChildMatch(genId, final2)], conflicts: [] };
  }
  const { order, conflicts, size } = placeQualifiersWithPolicy(qualifiers, sameTeamPolicy);
  const knockoutRounds = Math.log2(size) - 1;
  const rounds = [];
  let roundSize = size / 2;
  for (let r = 0; r < knockoutRounds; r++) {
    const fromFinal = knockoutRounds - r;
    const shells = [];
    for (let i = 0; i < roundSize; i++) {
      shells.push({
        id: genId(),
        round: startRound + r,
        bracketPosition: i,
        teamAId: null,
        teamBId: null,
        pairAId: null,
        pairBId: null,
        teamAWins: 0,
        teamBWins: 0,
        pairsPerMatchup: 1,
        winnerTeamId: null,
        status: "scheduled",
        stage: fromFinal === 1 ? "semifinal" : "knockout",
        stageLabel: knockoutStageLabel(fromFinal)
      });
    }
    rounds.push(shells);
    roundSize = Math.max(1, Math.floor(roundSize / 2));
  }
  for (let i = 0; i < rounds[0].length; i++) {
    const a = order[i * 2], b = order[i * 2 + 1];
    const m = rounds[0][i];
    m.teamAId = a?.teamId ?? null;
    m.pairAId = a?.registrationId ?? null;
    m.teamBId = b?.teamId ?? null;
    m.pairBId = b?.registrationId ?? null;
    if (!a || !b) {
      m.status = "bye";
      m.winnerTeamId = a ? a.teamId : b.teamId;
    }
  }
  for (let r = 0; r < rounds.length - 1; r++) {
    for (let i = 0; i < rounds[r].length; i++) {
      const m = rounds[r][i];
      const next = rounds[r + 1][Math.floor(i / 2)];
      m.nextMatchupId = next.id;
      m.nextMatchupSlot = i % 2 === 0 ? "A" : "B";
      if (m.status === "bye") {
        const pairId = m.winnerTeamId === m.teamAId ? m.pairAId : m.pairBId;
        if (m.nextMatchupSlot === "A") {
          next.teamAId = m.winnerTeamId;
          next.pairAId = pairId;
        } else {
          next.teamBId = m.winnerTeamId;
          next.pairBId = pairId;
        }
      }
    }
  }
  const semis = rounds[knockoutRounds - 1];
  const final = buildFinalShell(genId(), startRound + knockoutRounds);
  const bronze = buildBronzeShell(genId(), startRound + knockoutRounds);
  semis[0].nextMatchupId = final.id;
  semis[0].nextMatchupSlot = "A";
  semis[0].loserNextMatchupId = bronze.id;
  semis[0].loserNextMatchupSlot = "A";
  semis[1].nextMatchupId = final.id;
  semis[1].nextMatchupSlot = "B";
  semis[1].loserNextMatchupId = bronze.id;
  semis[1].loserNextMatchupSlot = "B";
  const knockoutShells = rounds.flat();
  const pairMatches = [];
  for (const m of knockoutShells) {
    if (m.status === "bye") continue;
    if (m.pairAId && m.pairBId) pairMatches.push(buildChildMatch(genId, m));
  }
  return { teamMatchups: [...knockoutShells, final, bronze], pairMatches, conflicts };
}

// packages/engine/src/registration.js
function assignedPersonIds({
  divisionTeams = [],
  teamMembers = [],
  divisionParticipants = [],
  participantMembers = [],
  exceptTeamId = null,
  exceptParticipantId = null,
  exceptParticipantTeamId = null
} = {}) {
  const teamIds = new Set(divisionTeams.map((t) => t.id).filter((id) => id !== exceptTeamId));
  const ids = /* @__PURE__ */ new Set();
  for (const m of teamMembers) {
    if (teamIds.has(m.team_id) && m.person_id) ids.add(m.person_id);
  }
  const participantById = new Map(divisionParticipants.map((p) => [p.id, p]));
  for (const m of participantMembers) {
    if (m.participant_id === exceptParticipantId) continue;
    const participant = participantById.get(m.participant_id);
    if (!participant) continue;
    if (exceptParticipantTeamId && participant.team_id === exceptParticipantTeamId) continue;
    if (m.person_id) ids.add(m.person_id);
  }
  return ids;
}
function validatePersonIdsForAssignment(personIds, assignedIds) {
  const ids = (personIds || []).filter(Boolean);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    return {
      ok: false,
      code: "DUPLICATE_PLAYER_IN_PAIR",
      message: "The same player cannot be selected twice in one pair"
    };
  }
  for (const id of ids) {
    if (assignedIds.has(id)) {
      return {
        ok: false,
        code: "PLAYER_ALREADY_ASSIGNED",
        message: "This player is already assigned to another team or pair in this division"
      };
    }
  }
  return { ok: true };
}

// packages/engine/src/optimisticScore.js
var UMPIRE_SCORE_EVENT_TYPES = Object.freeze(["point", "undo"]);
var UMPIRE_FORBIDDEN_COMMANDS = Object.freeze([
  "transition_match",
  "assign_court",
  "assign_umpire",
  "revoke_court_device",
  "open_court_pairing",
  "generate_bracket",
  "generate_team_elimination",
  "generate_team_playoffs",
  "create_tournament",
  "update_tournament",
  "transition_tournament",
  "remove_participant"
]);
var LIVE_WINDOW_FORBIDDEN_COMMANDS = Object.freeze([
  ...UMPIRE_FORBIDDEN_COMMANDS,
  "start_match",
  "coin_toss",
  "score_event",
  "complete_match",
  "station_sync"
]);

// packages/contracts/src/index.js
var COMMAND_TYPES = Object.freeze([
  "create_tournament",
  "update_tournament",
  "transition_tournament",
  "create_division",
  "update_division",
  "add_person",
  "update_person",
  "remove_person",
  "create_team",
  "add_team_member",
  "remove_team_member",
  "register_participant",
  "remove_participant",
  "update_match_participant",
  "create_court",
  "add_member",
  "generate_bracket",
  "generate_team_elimination",
  "generate_team_playoffs",
  "assign_court",
  "assign_umpire",
  "open_court_pairing",
  "revoke_court_device",
  "station_sync",
  "transition_match",
  "start_match",
  "coin_toss",
  "score_event",
  "complete_match"
]);
var TOURNAMENT_STATUSES2 = Object.freeze([
  "draft",
  "registration",
  "registration_closed",
  "ready",
  "in_progress",
  "completed",
  "cancelled",
  "archived"
]);
var MATCH_STATUSES2 = Object.freeze([
  "scheduled",
  "ready",
  "assigned",
  "in_progress",
  "completed",
  "postponed",
  "cancelled",
  "abandoned",
  "bye"
]);
var MEMBER_ROLES = Object.freeze(["organizer", "admin", "umpire", "viewer"]);
var DIVISION_FORMATS = Object.freeze([
  "single_elim",
  "double_elim",
  "round_robin",
  "pool",
  "team_elimination"
]);
var SCORE_EVENT_TYPES = Object.freeze(["point", "undo", "timeout", "coin_toss"]);
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}
function parseCommandEnvelope(body) {
  if (!body || typeof body !== "object") {
    const err = new Error("Command body must be an object");
    err.code = "INVALID_COMMAND";
    err.status = 400;
    throw err;
  }
  const { command_id, type, payload } = body;
  if (!isUuid(command_id)) {
    const err = new Error("command_id must be a UUID");
    err.code = "INVALID_COMMAND";
    err.status = 400;
    throw err;
  }
  if (!COMMAND_TYPES.includes(type)) {
    const err = new Error(`Unknown command type: ${type}`);
    err.code = "UNKNOWN_COMMAND";
    err.status = 400;
    throw err;
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("payload must be an object");
    err.code = "INVALID_COMMAND";
    err.status = 400;
    throw err;
  }
  return { command_id, type, payload };
}

// packages/api/src/writes.js
function httpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}
function createBatch() {
  const upserts = {};
  const deletes = {};
  return {
    upsert(table, row) {
      if (!row?.id) throw httpError(500, "INTERNAL", `upsert ${table} requires id`);
      (upserts[table] ||= []).push(row);
    },
    delete(table, id) {
      (deletes[table] ||= []).push(id);
    },
    payload() {
      const body = { upserts };
      if (Object.keys(deletes).length) body.deletes = deletes;
      return body;
    }
  };
}
async function applyBatch(admin, batch) {
  const payload = batch.payload();
  const { data, error } = await admin.rpc("apply_official_writes", { payload });
  if (error) {
    throw httpError(500, "WRITE_FAILED", error.message);
  }
  return data;
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function uuid() {
  return crypto.randomUUID();
}

// packages/api/src/authz.js
var STATION_COMMANDS = /* @__PURE__ */ new Set([
  "station_sync",
  "start_match",
  "coin_toss",
  "score_event",
  "complete_match"
]);
var STATION_SCORE_EVENT_TYPES = /* @__PURE__ */ new Set(["point", "undo"]);
var STATION_FORBIDDEN_COMMANDS = Object.freeze([
  "transition_match",
  "assign_court",
  "assign_umpire",
  "revoke_court_device",
  "open_court_pairing",
  "generate_bracket",
  "generate_team_elimination",
  "generate_team_playoffs",
  "create_tournament",
  "update_tournament",
  "transition_tournament",
  "remove_participant",
  "create_court",
  "add_member",
  "add_person",
  "create_team"
]);
function forbid(message) {
  const err = new Error(message);
  err.status = 403;
  err.code = "FORBIDDEN";
  throw err;
}
function assertStationMayIssue(actor, type, payload) {
  if (actor?.kind !== "station") return;
  if (!STATION_COMMANDS.has(type)) {
    forbid("Court stations cannot issue this command");
  }
  if (type === "score_event") {
    const eventType = payload?.type;
    if (eventType && !STATION_SCORE_EVENT_TYPES.has(eventType)) {
      forbid("Court stations cannot issue this scoring action");
    }
  }
}
var USER_ONLY_SCORE_EVENT_TYPES = /* @__PURE__ */ new Set(["correction"]);
function assertAllowedScoreEventType(type, actor) {
  if (actor?.kind !== "station" && USER_ONLY_SCORE_EVENT_TYPES.has(type)) return;
  if (!STATION_SCORE_EVENT_TYPES.has(type)) {
    forbid("This scoring action is not allowed");
  }
}
function requireOrganizer(member) {
  if (!member || !["organizer", "admin"].includes(member.role)) {
    const err = new Error("Organizer role required");
    err.status = 403;
    err.code = "FORBIDDEN";
    throw err;
  }
}
function canScoreMatch(member, umpireUserId, actorId) {
  if (member && ["organizer", "admin"].includes(member.role)) return true;
  if (member && member.role === "umpire" && umpireUserId === actorId) return true;
  return false;
}
function requireScoreAccess(member, umpireUserId, actorId) {
  if (!canScoreMatch(member, umpireUserId, actorId)) {
    const err = new Error("Not authorized to operate this match");
    err.status = 403;
    err.code = "FORBIDDEN";
    throw err;
  }
}
function canScoreAsStation(device, courtAssignment, match) {
  if (!device || device.status !== "active") return false;
  if (!courtAssignment || courtAssignment.court_id !== device.court_id) return false;
  if (!match || match.tournament_id !== device.tournament_id) return false;
  return true;
}
function requireStationScoreAccess(device, courtAssignment, match) {
  if (!canScoreAsStation(device, courtAssignment, match)) {
    const err = new Error("This device is not authorized for that match");
    err.status = 403;
    err.code = "COURT_MISMATCH";
    throw err;
  }
}
async function loadMember(admin, tournamentId, userId) {
  const { data, error } = await admin.from("tournament_members").select("*").eq("tournament_id", tournamentId).eq("user_id", userId).maybeSingle();
  if (error) throw error;
  return data;
}
async function requireProfile(admin, userId) {
  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error("Profile not found");
    err.status = 401;
    err.code = "NO_PROFILE";
    throw err;
  }
  return data;
}

// packages/api/src/stationAuth.js
function b64url(bytes) {
  const bin = typeof bytes === "string" ? bytes : String.fromCharCode(...bytes);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function b64urlToBytes(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/") + pad;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function envGet(name) {
  if (typeof process !== "undefined" && process.env?.[name]) return process.env[name];
  const deno = globalThis.Deno;
  if (deno?.env?.get) return deno.env.get(name) || "";
  return "";
}
function stationJwtSecret() {
  return envGet("STATION_JWT_SECRET");
}
async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}
async function hmacSign(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return b64url(new Uint8Array(sig));
}
async function verifyStationJwt(token, secret = stationJwtSecret()) {
  if (!secret || !token || token.split(".").length !== 3) return null;
  const [header, payload, sig] = token.split(".");
  const expected = await hmacSign(secret, `${header}.${payload}`);
  if (expected.length !== sig.length) return null;
  let same = 0;
  for (let i = 0; i < expected.length; i++) same |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (same !== 0) return null;
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload)));
  } catch {
    return null;
  }
  if (body.typ !== "station" || !body.sub || !body.court_id || !body.tournament_id) return null;
  const now = Math.floor(Date.now() / 1e3);
  if (body.exp && now > body.exp) return null;
  return body;
}
async function resolveActor(admin, jwt) {
  if (!jwt) throw httpError(401, "UNAUTHENTICATED", "Missing JWT");
  const { data: { user } } = await admin.auth.getUser(jwt);
  if (user) return { kind: "user", id: user.id, email: user.email };
  const claims = await verifyStationJwt(jwt);
  if (!claims) throw httpError(401, "UNAUTHENTICATED", "Invalid JWT");
  const { data: device, error } = await admin.from("court_devices").select("*").eq("id", claims.sub).maybeSingle();
  if (error) throw error;
  if (!device || device.status !== "active") throw httpError(401, "UNAUTHENTICATED", "Device is not active");
  if (device.court_id !== claims.court_id || device.tournament_id !== claims.tournament_id) {
    throw httpError(401, "UNAUTHENTICATED", "Device token mismatch");
  }
  return {
    kind: "station",
    id: device.id,
    deviceId: device.id,
    courtId: device.court_id,
    tournamentId: device.tournament_id
  };
}

// packages/api/src/handleCommand.js
function scoringSettings(config = {}) {
  return {
    winTo: config.winTo ?? 11,
    winBy: config.winBy ?? "two",
    bestOf: config.bestOf ?? 1,
    isDoubles: config.isDoubles !== false,
    timeoutsAllowed: config.timeoutsAllowed ?? 2
  };
}
async function commit(admin, batch, { command_id, type, actorId, actorDeviceId, tournamentId, matchId, result, detail }) {
  batch.upsert("command_receipts", {
    id: command_id,
    actor_id: actorDeviceId ? null : actorId,
    actor_device_id: actorDeviceId || null,
    command_type: type,
    result,
    created_at: nowIso()
  });
  batch.upsert("audit_logs", {
    id: uuid(),
    actor_id: actorDeviceId ? null : actorId,
    actor_device_id: actorDeviceId || null,
    command_id,
    command_type: type,
    tournament_id: tournamentId ?? null,
    match_id: matchId ?? null,
    detail: detail || { ok: true },
    created_at: nowIso()
  });
  await applyBatch(admin, batch);
  return result;
}
function actorCommit(actor) {
  if (actor.kind === "station") return { actorId: null, actorDeviceId: actor.deviceId };
  return { actorId: actor.id, actorDeviceId: null };
}
function scoreActor(actor) {
  if (actor.kind === "station") return { actor_id: null, actor_device_id: actor.deviceId };
  return { actor_id: actor.id, actor_device_id: null };
}
async function matchCourt(admin, matchId) {
  const { data, error } = await admin.from("court_assignments").select("*").eq("match_id", matchId).maybeSingle();
  if (error) throw error;
  return data;
}
async function authorizeMatchOperation(admin, actor, match) {
  const courtAsg = await matchCourt(admin, match.id);
  if (actor.kind === "station") {
    if (actor.tournamentId !== match.tournament_id) {
      throw httpError(403, "COURT_MISMATCH", "Device is not in this tournament");
    }
    const { data: device, error } = await admin.from("court_devices").select("*").eq("id", actor.deviceId).maybeSingle();
    if (error) throw error;
    requireStationScoreAccess(device, courtAsg, match);
    return { device, courtAsg };
  }
  const member = await loadMember(admin, match.tournament_id, actor.id);
  const ump = await matchUmpire(admin, match.id);
  requireScoreAccess(member, ump?.user_id, actor.id);
  return { member, ump, courtAsg };
}
function requireUserActor(actor) {
  if (actor.kind === "station") throw httpError(403, "FORBIDDEN", "Organizer account required");
}
function newStationPublicId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function existingReceipt(admin, command_id) {
  const { data, error } = await admin.from("command_receipts").select("*").eq("id", command_id).maybeSingle();
  if (error) throw error;
  return data;
}
async function getTournament(admin, id) {
  const { data, error } = await admin.from("tournaments").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(404, "NOT_FOUND", "Tournament not found");
  return data;
}
async function getDivision(admin, id) {
  const { data, error } = await admin.from("divisions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(404, "NOT_FOUND", "Division not found");
  return data;
}
async function getMatch(admin, id) {
  const { data, error } = await admin.from("matches").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(404, "NOT_FOUND", "Match not found");
  return data;
}
async function matchSides(admin, matchId) {
  const { data, error } = await admin.from("match_participants").select("*").eq("match_id", matchId);
  if (error) throw error;
  return data || [];
}
async function matchUmpire(admin, matchId) {
  const { data, error } = await admin.from("umpire_assignments").select("*").eq("match_id", matchId).maybeSingle();
  if (error) throw error;
  return data;
}
function persistMatch(batch, match) {
  batch.upsert("matches", {
    ...match,
    updated_at: nowIso()
  });
}
function pairTeamId(grouped, registrationId) {
  if (!grouped?.teams || !registrationId) return null;
  for (const t of grouped.teams) {
    if (t.pairs.some((p) => p.id === registrationId)) return t.teamId;
  }
  return null;
}
function persistTeamBracket(batch, division, stage, teamMatchups, pairMatches, grouped, ts) {
  for (const mu of teamMatchups) {
    const bye = mu.status === "bye";
    const winnerSlot = bye && mu.winnerTeamId ? mu.winnerTeamId === mu.teamAId ? "A" : "B" : null;
    persistMatch(batch, {
      id: mu.id,
      tournament_id: division.tournament_id,
      division_id: division.id,
      stage_id: stage.id,
      parent_match_id: null,
      pair_slot: null,
      round: mu.round,
      bracket_position: mu.bracketPosition,
      bracket_side: mu.bracketSide || mu.stage || "team_matchup",
      stage_label: mu.stage || mu.stageLabel || null,
      status: bye ? "bye" : "scheduled",
      winner: winnerSlot,
      next_match_id: mu.nextMatchupId || null,
      next_match_slot: mu.nextMatchupSlot || null,
      loser_next_match_id: mu.loserNextMatchupId || null,
      loser_next_match_slot: mu.loserNextMatchupSlot || null,
      serving_team: null,
      coin_toss: null,
      score_state: {},
      team_a_wins: mu.teamAWins || 0,
      team_b_wins: mu.teamBWins || 0,
      started_at: null,
      completed_at: bye ? ts : null,
      created_at: ts,
      updated_at: ts
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: mu.id,
      slot: "A",
      participant_id: mu.pairAId || null,
      team_id: mu.teamAId || null
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: mu.id,
      slot: "B",
      participant_id: mu.pairBId || null,
      team_id: mu.teamBId || null
    });
  }
  for (const pm of pairMatches) {
    persistMatch(batch, {
      id: pm.id,
      tournament_id: division.tournament_id,
      division_id: division.id,
      stage_id: stage.id,
      parent_match_id: pm.teamMatchupId,
      pair_slot: pm.pairSlot,
      round: pm.round,
      bracket_position: pm.bracketPosition,
      bracket_side: "pair",
      stage_label: null,
      status: "scheduled",
      winner: null,
      next_match_id: null,
      next_match_slot: null,
      loser_next_match_id: null,
      loser_next_match_slot: null,
      serving_team: null,
      coin_toss: null,
      score_state: {},
      team_a_wins: 0,
      team_b_wins: 0,
      started_at: null,
      completed_at: null,
      created_at: ts,
      updated_at: ts
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: pm.id,
      slot: "A",
      participant_id: pm.registrationAId,
      team_id: pairTeamId(grouped, pm.registrationAId)
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: pm.id,
      slot: "B",
      participant_id: pm.registrationBId,
      team_id: pairTeamId(grouped, pm.registrationBId)
    });
  }
}
function upsertMatchupSlot(batch, muSides, matchupId, slot, participantId, teamId) {
  const row = (muSides || []).find((x) => x.match_id === matchupId && x.slot === slot);
  batch.upsert("match_participants", {
    id: row?.id || uuid(),
    match_id: matchupId,
    slot,
    participant_id: participantId ?? null,
    team_id: teamId ?? null
  });
}
function applyIndividualPatch(batch, matchups, muSides, adv) {
  if (!adv) return;
  const next = (matchups || []).find((m) => m.id === adv.matchupId);
  if (next) persistMatch(batch, { ...next, status: next.status === "bye" ? "bye" : "scheduled" });
  if (Object.hasOwn(adv.patch, "pairAId") || Object.hasOwn(adv.patch, "teamAId")) {
    upsertMatchupSlot(batch, muSides, adv.matchupId, "A", adv.patch.pairAId, adv.patch.teamAId);
  }
  if (Object.hasOwn(adv.patch, "pairBId") || Object.hasOwn(adv.patch, "teamBId")) {
    upsertMatchupSlot(batch, muSides, adv.matchupId, "B", adv.patch.pairBId, adv.patch.teamBId);
  }
}
async function ensurePlayoffChildInBatch(admin, batch, parent, overlaySides) {
  const a = overlaySides.find((s) => s.slot === "A");
  const b = overlaySides.find((s) => s.slot === "B");
  if (!a?.participant_id || !b?.participant_id || !parent) return false;
  const { data: kids } = await admin.from("matches").select("*").eq("parent_match_id", parent.id);
  const existing = (kids || []).find((k) => k.pair_slot === 1) || (kids || [])[0];
  const ts = nowIso();
  const childId = existing?.id || uuid();
  persistMatch(batch, {
    id: childId,
    tournament_id: parent.tournament_id,
    division_id: parent.division_id,
    stage_id: parent.stage_id,
    parent_match_id: parent.id,
    pair_slot: 1,
    round: parent.round,
    bracket_position: parent.bracket_position,
    bracket_side: "pair",
    stage_label: parent.stage_label,
    status: existing?.status && existing.status !== "scheduled" ? existing.status : "scheduled",
    winner: existing?.winner ?? null,
    next_match_id: null,
    next_match_slot: null,
    loser_next_match_id: null,
    loser_next_match_slot: null,
    serving_team: existing?.serving_team ?? null,
    coin_toss: existing?.coin_toss ?? null,
    score_state: existing?.score_state || {},
    team_a_wins: 0,
    team_b_wins: 0,
    started_at: existing?.started_at ?? null,
    completed_at: existing?.completed_at ?? null,
    created_at: existing?.created_at || ts,
    updated_at: ts
  });
  const { data: childSides } = existing ? await admin.from("match_participants").select("*").eq("match_id", childId) : { data: [] };
  for (const slot of ["A", "B"]) {
    const parentSide = overlaySides.find((s) => s.slot === slot);
    const row = (childSides || []).find((x) => x.slot === slot);
    batch.upsert("match_participants", {
      id: row?.id || uuid(),
      match_id: childId,
      slot,
      participant_id: parentSide.participant_id,
      team_id: parentSide.team_id ?? null
    });
  }
  return true;
}
async function reconcilePlayoffChildren(admin, divisionId) {
  if (!divisionId) return;
  const { data: parents } = await admin.from("matches").select("*").eq("division_id", divisionId).is("parent_match_id", null);
  if (!parents?.length) return;
  const ids = parents.map((p) => p.id);
  const { data: sides } = await admin.from("match_participants").select("*").in("match_id", ids);
  const { data: children } = await admin.from("matches").select("id, parent_match_id, pair_slot").in("parent_match_id", ids);
  const batch = createBatch();
  let writes = 0;
  for (const parent of parents) {
    const overlay = (sides || []).filter((s) => s.match_id === parent.id);
    const a = overlay.find((s) => s.slot === "A");
    const b = overlay.find((s) => s.slot === "B");
    if (!a?.participant_id || !b?.participant_id) continue;
    const kids = (children || []).filter((c) => c.parent_match_id === parent.id);
    if (kids.length) continue;
    await ensurePlayoffChildInBatch(admin, batch, parent, overlay);
    writes += 1;
  }
  if (!writes) return;
  try {
    await applyBatch(admin, batch);
  } catch {
  }
}
async function finishMatchIfWon(admin, batch, match, scoreState, actorId) {
  if (scoreState.status !== "completed" || !scoreState.winner) return { match, progressed: null };
  assertTransitionMatch(match.status, "completed");
  const sides = await matchSides(admin, match.id);
  const winnerSlot = scoreState.winner;
  const winnerSide = sides.find((s) => s.slot === winnerSlot);
  const loserSlot = winnerSlot === "A" ? "B" : "A";
  const loserSide = sides.find((s) => s.slot === loserSlot);
  const completed = {
    ...match,
    status: "completed",
    winner: winnerSlot,
    score_state: scoreState,
    completed_at: nowIso(),
    updated_at: nowIso()
  };
  persistMatch(batch, completed);
  const { data: existingResult } = await admin.from("match_results").select("*").eq("match_id", match.id).maybeSingle();
  batch.upsert("match_results", {
    id: existingResult?.id || uuid(),
    match_id: match.id,
    winner_slot: winnerSlot,
    winner_participant_id: winnerSide?.participant_id ?? null,
    winner_team_id: winnerSide?.team_id ?? null,
    games: scoreState.games || [],
    score_a: scoreState.scoreA,
    score_b: scoreState.scoreB,
    completed_at: nowIso()
  });
  let progressed = null;
  if (!match.parent_match_id && match.next_match_id && winnerSide?.participant_id) {
    const { data: all } = await admin.from("matches").select("*").eq("division_id", match.division_id);
    const { data: allSides } = await admin.from("match_participants").select("*").in("match_id", (all || []).map((m) => m.id));
    const engineMatches = (all || []).map((m) => {
      const s = (allSides || []).filter((x) => x.match_id === m.id);
      const a = s.find((x) => x.slot === "A");
      const b = s.find((x) => x.slot === "B");
      return {
        id: m.id,
        nextMatchId: m.next_match_id,
        nextMatchSlot: m.next_match_slot,
        loserNextMatchId: m.loser_next_match_id,
        loserNextMatchSlot: m.loser_next_match_slot,
        registrationAId: a?.participant_id ?? null,
        registrationBId: b?.participant_id ?? null,
        status: m.status
      };
    });
    const patch = advanceBracket(engineMatches, match.id, winnerSide.participant_id);
    if (patch) {
      const next = (all || []).find((m) => m.id === patch.matchId);
      if (next) {
        persistMatch(batch, { ...next });
        if (patch.patch.registrationAId) {
          const row = (allSides || []).find((x) => x.match_id === patch.matchId && x.slot === "A");
          batch.upsert("match_participants", {
            id: row?.id || uuid(),
            match_id: patch.matchId,
            slot: "A",
            participant_id: patch.patch.registrationAId,
            team_id: row?.team_id ?? null
          });
        }
        if (patch.patch.registrationBId) {
          const row = (allSides || []).find((x) => x.match_id === patch.matchId && x.slot === "B");
          batch.upsert("match_participants", {
            id: row?.id || uuid(),
            match_id: patch.matchId,
            slot: "B",
            participant_id: patch.patch.registrationBId,
            team_id: row?.team_id ?? null
          });
        }
        if (patch.patch.status) {
          persistMatch(batch, { ...next, status: next.status === "bye" ? next.status : next.status });
        }
      }
      progressed = { next: patch };
    }
    if (loserSide?.participant_id && match.loser_next_match_id) {
      const bronze = advanceBronzeMatchSlot(engineMatches, match.id, loserSide.participant_id);
      if (bronze) {
        const row = (allSides || []).find((x) => x.match_id === bronze.matchId && x.slot === (bronze.patch.registrationAId ? "A" : "B"));
        if (bronze.patch.registrationAId) {
          batch.upsert("match_participants", {
            id: row?.id || uuid(),
            match_id: bronze.matchId,
            slot: "A",
            participant_id: bronze.patch.registrationAId,
            team_id: null
          });
        }
        if (bronze.patch.registrationBId) {
          const rowB = (allSides || []).find((x) => x.match_id === bronze.matchId && x.slot === "B");
          batch.upsert("match_participants", {
            id: rowB?.id || uuid(),
            match_id: bronze.matchId,
            slot: "B",
            participant_id: bronze.patch.registrationBId,
            team_id: null
          });
        }
        progressed = { ...progressed || {}, bronze };
      }
    }
  }
  if (match.parent_match_id) {
    const { data: siblings } = await admin.from("matches").select("*").eq("parent_match_id", match.parent_match_id);
    const parent = await getMatch(admin, match.parent_match_id);
    const parentSides = await matchSides(admin, parent.id);
    const pairMatches = (siblings || []).map((m) => ({
      id: m.id,
      teamMatchupId: m.parent_match_id,
      status: m.id === match.id ? "completed" : m.status,
      winner: m.id === match.id ? winnerSlot : m.winner,
      score: m.id === match.id ? { scoreA: scoreState.scoreA, scoreB: scoreState.scoreB } : m.score_state || {}
    }));
    const finalized = finalizeCrossTeamMatchup(
      {
        id: parent.id,
        teamAId: parentSides.find((s) => s.slot === "A")?.team_id,
        teamBId: parentSides.find((s) => s.slot === "B")?.team_id
      },
      pairMatches
    );
    if (finalized) {
      persistMatch(batch, {
        ...parent,
        status: "completed",
        winner: finalized.winnerTeamId === parentSides.find((s) => s.slot === "A")?.team_id ? "A" : "B",
        team_a_wins: finalized.teamAWins,
        team_b_wins: finalized.teamBWins,
        completed_at: nowIso()
      });
      const { data: matchups } = await admin.from("matches").select("*").eq("division_id", parent.division_id).is("parent_match_id", null);
      const { data: muSides } = await admin.from("match_participants").select("*").in("match_id", (matchups || []).map((m) => m.id));
      const engineMatchups = (matchups || []).map((m) => {
        const s = (muSides || []).filter((x) => x.match_id === m.id);
        return {
          id: m.id,
          nextMatchupId: m.next_match_id,
          nextMatchupSlot: m.next_match_slot,
          loserNextMatchupId: m.loser_next_match_id,
          loserNextMatchupSlot: m.loser_next_match_slot,
          teamAId: s.find((x) => x.slot === "A")?.team_id,
          teamBId: s.find((x) => x.slot === "B")?.team_id,
          pairAId: s.find((x) => x.slot === "A")?.participant_id,
          pairBId: s.find((x) => x.slot === "B")?.participant_id,
          status: m.status
        };
      });
      const winnerPairId = winnerSide?.participant_id ?? null;
      const loserPairId = loserSide?.participant_id ?? null;
      const winnerTeamId = winnerSlot === "A" ? parentSides.find((s) => s.slot === "A")?.team_id : parentSides.find((s) => s.slot === "B")?.team_id;
      const loserTeamId = winnerSlot === "A" ? parentSides.find((s) => s.slot === "B")?.team_id : parentSides.find((s) => s.slot === "A")?.team_id;
      const adv = advanceIndividualMatchup(engineMatchups, parent.id, winnerPairId, winnerTeamId);
      if (adv) applyIndividualPatch(batch, matchups, muSides, adv);
      const bronze = advanceBronzeIndividualMatchup(engineMatchups, parent.id, loserPairId, loserTeamId);
      if (bronze) applyIndividualPatch(batch, matchups, muSides, bronze);
      progressed = { teamMatchup: finalized, next: adv, bronze };
    }
  }
  return { match: completed, progressed };
}
async function handleCreateTournament(admin, actor, payload, envelope) {
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  await requireProfile(admin, actor.id);
  const id = uuid();
  const ts = nowIso();
  const tournament = {
    id,
    name,
    sport: payload.sport || "pickleball",
    status: "draft",
    owner_id: actor.id,
    settings: payload.settings || {},
    created_at: ts,
    updated_at: ts
  };
  const batch = createBatch();
  batch.upsert("tournaments", tournament);
  batch.upsert("tournament_members", {
    id: uuid(),
    tournament_id: id,
    user_id: actor.id,
    role: "organizer",
    created_at: ts
  });
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: id,
    result: { tournament }
  });
}
async function handleUpdateTournament(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  const next = {
    ...tournament,
    name: payload.name != null ? String(payload.name).trim() : tournament.name,
    settings: payload.settings != null ? payload.settings : tournament.settings,
    updated_at: nowIso()
  };
  if (!next.name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const batch = createBatch();
  batch.upsert("tournaments", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { tournament: next }
  });
}
async function handleTransitionTournament(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  try {
    assertTransitionTournament(tournament.status, payload.status);
  } catch (err) {
    throw httpError(409, err.code || "ILLEGAL_TRANSITION", err.message);
  }
  const next = { ...tournament, status: payload.status, updated_at: nowIso() };
  const batch = createBatch();
  batch.upsert("tournaments", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { tournament: next }
  });
}
async function handleCreateDivision(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const format = payload.format || "single_elim";
  const config = { ...payload.config || { winTo: 11, bestOf: 1, winBy: "two", isDoubles: true } };
  if (format === "team_elimination") {
    if (config.sameTeamPolicy == null) config.sameTeamPolicy = "avoid_semis";
    if (config.qualifierMode == null) config.qualifierMode = "top_x";
    if (config.qualifierCount == null) config.qualifierCount = 4;
  }
  const ts = nowIso();
  const division = {
    id: uuid(),
    tournament_id: tournament.id,
    name,
    format,
    config,
    created_at: ts,
    updated_at: ts
  };
  const batch = createBatch();
  batch.upsert("divisions", division);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { division }
  });
}
async function handleUpdateDivision(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  requireOrganizer(member);
  const next = {
    ...division,
    name: payload.name != null ? String(payload.name).trim() : division.name,
    format: payload.format || division.format,
    config: payload.config != null ? { ...division.config, ...payload.config } : division.config,
    updated_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("divisions", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { division: next }
  });
}
async function handleAddPerson(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  const display_name = String(payload.display_name || "").trim();
  if (!display_name) throw httpError(400, "INVALID_COMMAND", "display_name is required");
  const person = {
    id: uuid(),
    tournament_id: tournament.id,
    display_name,
    user_id: payload.user_id || null,
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("persons", person);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { person }
  });
}
async function handleUpdatePerson(admin, actor, payload, envelope) {
  if (!isUuid(payload.person_id)) throw httpError(400, "INVALID_COMMAND", "person_id must be a UUID");
  const { data: person } = await admin.from("persons").select("*").eq("id", payload.person_id).maybeSingle();
  if (!person) throw httpError(404, "NOT_FOUND", "Person not found");
  const member = await loadMember(admin, person.tournament_id, actor.id);
  requireOrganizer(member);
  const display_name = String(payload.display_name || "").trim();
  if (!display_name) throw httpError(400, "INVALID_COMMAND", "display_name is required");
  const next = { ...person, display_name };
  const batch = createBatch();
  batch.upsert("persons", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: person.tournament_id,
    result: { person: next }
  });
}
async function handleRemovePerson(admin, actor, payload, envelope) {
  if (!isUuid(payload.person_id)) throw httpError(400, "INVALID_COMMAND", "person_id must be a UUID");
  const { data: person } = await admin.from("persons").select("*").eq("id", payload.person_id).maybeSingle();
  if (!person) throw httpError(404, "NOT_FOUND", "Person not found");
  const member = await loadMember(admin, person.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: used } = await admin.from("participant_members").select("id").eq("person_id", person.id).limit(1);
  if (used?.length) throw httpError(409, "PERSON_IN_USE", "Cannot remove a player who is already registered into a division");
  const batch = createBatch();
  batch.delete("persons", person.id);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: person.tournament_id,
    result: { person_id: person.id, removed: true }
  });
}
async function handleCreateTeam(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const team = {
    id: uuid(),
    tournament_id: tournament.id,
    division_id: payload.division_id || null,
    name,
    ranking: payload.ranking ?? null,
    bracket_group: payload.bracket_group ?? null,
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("teams", team);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { team }
  });
}
async function handleAddTeamMember(admin, actor, payload, envelope) {
  const { data: team, error } = await admin.from("teams").select("*").eq("id", payload.team_id).maybeSingle();
  if (error) throw error;
  if (!team) throw httpError(404, "NOT_FOUND", "Team not found");
  const member = await loadMember(admin, team.tournament_id, actor.id);
  requireOrganizer(member);
  if (!isUuid(payload.person_id)) throw httpError(400, "INVALID_COMMAND", "person_id must be a UUID");
  const { data: person } = await admin.from("persons").select("*").eq("id", payload.person_id).maybeSingle();
  if (!person || person.tournament_id !== team.tournament_id) {
    throw httpError(400, "INVALID_PLAYER", "Person is not in this tournament");
  }
  const { data: existing } = await admin.from("team_members").select("*").eq("team_id", team.id).eq("person_id", payload.person_id).maybeSingle();
  if (existing) throw httpError(409, "DUPLICATE_MEMBER", "Player is already on this team");
  if (team.division_id) {
    const snapshot = await loadDivisionAssignment(admin, team.division_id);
    const assigned = assignedPersonIds({
      divisionTeams: snapshot.teams,
      teamMembers: snapshot.teamMembers,
      divisionParticipants: snapshot.participants,
      participantMembers: snapshot.participantMembers,
      exceptTeamId: team.id,
      exceptParticipantTeamId: team.id
    });
    const check = validatePersonIdsForAssignment([payload.person_id], assigned);
    if (!check.ok) throw httpError(409, check.code, check.message);
  }
  const row = {
    id: uuid(),
    team_id: team.id,
    person_id: payload.person_id,
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("team_members", row);
  try {
    return await commit(admin, batch, {
      ...envelope,
      actorId: actor.id,
      tournamentId: team.tournament_id,
      result: { team_member: row }
    });
  } catch (err) {
    if (/unique|duplicate/i.test(String(err.message))) {
      throw httpError(409, "DUPLICATE_MEMBER", "Player is already on this team");
    }
    throw err;
  }
}
async function handleRemoveTeamMember(admin, actor, payload, envelope) {
  if (!isUuid(payload.team_member_id)) throw httpError(400, "INVALID_COMMAND", "team_member_id must be a UUID");
  const { data: row } = await admin.from("team_members").select("*").eq("id", payload.team_member_id).maybeSingle();
  if (!row) throw httpError(404, "NOT_FOUND", "Team member not found");
  const { data: team } = await admin.from("teams").select("*").eq("id", row.team_id).maybeSingle();
  if (!team) throw httpError(404, "NOT_FOUND", "Team not found");
  const member = await loadMember(admin, team.tournament_id, actor.id);
  requireOrganizer(member);
  const batch = createBatch();
  batch.delete("team_members", row.id);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: team.tournament_id,
    result: { team_member_id: row.id, removed: true }
  });
}
async function handleRegisterParticipant(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  requireOrganizer(member);
  const display_name = String(payload.display_name || "").trim();
  if (!display_name) throw httpError(400, "INVALID_COMMAND", "display_name is required");
  const personIds = (payload.person_ids || []).filter(Boolean);
  const uniqueIds = new Set(personIds);
  if (uniqueIds.size !== personIds.length) {
    throw httpError(409, "DUPLICATE_PLAYER_IN_PAIR", "The same player cannot be selected twice in one pair");
  }
  for (const personId of personIds) {
    if (!isUuid(personId)) throw httpError(400, "INVALID_COMMAND", "person_ids must be UUIDs");
    const { data: person } = await admin.from("persons").select("*").eq("id", personId).maybeSingle();
    if (!person || person.tournament_id !== division.tournament_id) {
      throw httpError(400, "INVALID_PLAYER", "Person is not in this tournament");
    }
  }
  const snapshot = await loadDivisionAssignment(admin, division.id);
  const assigned = assignedPersonIds({
    divisionTeams: snapshot.teams,
    teamMembers: snapshot.teamMembers,
    divisionParticipants: snapshot.participants,
    participantMembers: snapshot.participantMembers,
    exceptTeamId: payload.team_id || null
  });
  const check = validatePersonIdsForAssignment(personIds, assigned);
  if (!check.ok) throw httpError(409, check.code, check.message);
  if (payload.team_id) {
    const teamOk = snapshot.teams.some((t) => t.id === payload.team_id);
    if (!teamOk) throw httpError(400, "INVALID_COMMAND", "team_id is not in this division");
  }
  const participant = {
    id: uuid(),
    tournament_id: division.tournament_id,
    division_id: division.id,
    kind: payload.kind || "doubles",
    team_id: payload.team_id || null,
    seed: payload.seed ?? null,
    display_name,
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("participants", participant);
  for (const [i, personId] of personIds.entries()) {
    batch.upsert("participant_members", {
      id: uuid(),
      participant_id: participant.id,
      person_id: personId,
      slot: i + 1
    });
  }
  if (payload.team_id) {
    const onTeam = new Set(snapshot.teamMembers.filter((m) => m.team_id === payload.team_id).map((m) => m.person_id));
    for (const personId of personIds) {
      if (onTeam.has(personId)) continue;
      batch.upsert("team_members", {
        id: uuid(),
        team_id: payload.team_id,
        person_id: personId,
        created_at: nowIso()
      });
    }
  }
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { participant }
  });
}
async function handleRemoveParticipant(admin, actor, payload, envelope) {
  if (!isUuid(payload.participant_id)) throw httpError(400, "INVALID_COMMAND", "participant_id must be a UUID");
  const { data: participant } = await admin.from("participants").select("*").eq("id", payload.participant_id).maybeSingle();
  if (!participant) throw httpError(404, "NOT_FOUND", "Participant not found");
  const member = await loadMember(admin, participant.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: used } = await admin.from("match_participants").select("id").eq("participant_id", participant.id).limit(1);
  if (used?.length) throw httpError(409, "PARTICIPANT_IN_USE", "Cannot remove a participant that is already in a match");
  const { data: members } = await admin.from("participant_members").select("id").eq("participant_id", participant.id);
  const batch = createBatch();
  for (const row of members || []) batch.delete("participant_members", row.id);
  batch.delete("participants", participant.id);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: participant.tournament_id,
    result: { participant_id: participant.id, removed: true }
  });
}
var MATCH_PARTICIPANT_EDITABLE_STATUSES = /* @__PURE__ */ new Set(["scheduled", "ready", "assigned", "postponed"]);
async function handleUpdateMatchParticipant(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  requireOrganizer(member);
  const slot = payload.slot;
  if (slot !== "A" && slot !== "B") throw httpError(400, "INVALID_COMMAND", "slot must be A or B");
  if (!MATCH_PARTICIPANT_EDITABLE_STATUSES.has(match.status)) {
    throw httpError(409, "MATCH_NOT_EDITABLE", "Players can only be changed before the match starts");
  }
  const { data: mp } = await admin.from("match_participants").select("*").eq("match_id", match.id).eq("slot", slot).maybeSingle();
  if (!mp || !mp.participant_id) throw httpError(404, "NOT_FOUND", "No player pairing is assigned to this side yet");
  const { data: oldParticipant } = await admin.from("participants").select("*").eq("id", mp.participant_id).maybeSingle();
  if (!oldParticipant) throw httpError(404, "NOT_FOUND", "Current participant not found");
  const { data: oldMemberRows } = await admin.from("participant_members").select("*").eq("participant_id", oldParticipant.id).order("slot");
  const oldPersonIds = (oldMemberRows || []).map((m) => m.person_id);
  const personIds = (payload.person_ids || []).filter(Boolean);
  if (personIds.length !== oldPersonIds.length) {
    throw httpError(400, "INVALID_COMMAND", `This side needs exactly ${oldPersonIds.length} player(s)`);
  }
  for (const personId of personIds) {
    if (!isUuid(personId)) throw httpError(400, "INVALID_COMMAND", "person_ids must be UUIDs");
  }
  const { data: personsRows } = await admin.from("persons").select("id, display_name, tournament_id").in("id", [.../* @__PURE__ */ new Set([...personIds, ...oldPersonIds])]);
  const personById = new Map((personsRows || []).map((p) => [p.id, p]));
  for (const personId of personIds) {
    const person = personById.get(personId);
    if (!person || person.tournament_id !== match.tournament_id) {
      throw httpError(400, "INVALID_PLAYER", "Person is not in this tournament");
    }
  }
  const division = await getDivision(admin, match.division_id);
  const snapshot = await loadDivisionAssignment(admin, division.id);
  const assigned = assignedPersonIds({
    divisionTeams: snapshot.teams,
    teamMembers: snapshot.teamMembers,
    divisionParticipants: snapshot.participants,
    participantMembers: snapshot.participantMembers,
    exceptParticipantId: oldParticipant.id,
    exceptParticipantTeamId: oldParticipant.team_id || null
  });
  const check = validatePersonIdsForAssignment(personIds, assigned);
  if (!check.ok) throw httpError(409, check.code, check.message);
  const unchanged = personIds.length === oldPersonIds.length && personIds.every((id, i) => id === oldPersonIds[i]);
  if (unchanged) throw httpError(400, "INVALID_COMMAND", "No player change to save");
  const nameFor = (id) => personById.get(id)?.display_name || id;
  const newParticipant = {
    id: uuid(),
    tournament_id: match.tournament_id,
    division_id: division.id,
    kind: oldParticipant.kind,
    team_id: oldParticipant.team_id,
    seed: oldParticipant.seed,
    display_name: personIds.map(nameFor).join(" / "),
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("participants", newParticipant);
  for (const [i, personId] of personIds.entries()) {
    batch.upsert("participant_members", {
      id: uuid(),
      participant_id: newParticipant.id,
      person_id: personId,
      slot: i + 1
    });
  }
  batch.upsert("match_participants", {
    id: mp.id,
    match_id: match.id,
    slot,
    participant_id: newParticipant.id,
    team_id: mp.team_id
  });
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match_id: match.id, slot, participant: newParticipant },
    detail: {
      ok: true,
      participant_change: {
        match_id: match.id,
        division_id: division.id,
        slot,
        old: { participant_id: oldParticipant.id, players: oldPersonIds.map((id) => ({ id, name: nameFor(id) })) },
        new: { participant_id: newParticipant.id, players: personIds.map((id) => ({ id, name: nameFor(id) })) }
      }
    }
  });
}
async function loadDivisionAssignment(admin, divisionId) {
  const { data: teams } = await admin.from("teams").select("*").eq("division_id", divisionId);
  const teamIds = (teams || []).map((t) => t.id);
  const { data: teamMembers } = teamIds.length ? await admin.from("team_members").select("*").in("team_id", teamIds) : { data: [] };
  const { data: participants } = await admin.from("participants").select("*").eq("division_id", divisionId);
  const pids = (participants || []).map((p) => p.id);
  const { data: participantMembers } = pids.length ? await admin.from("participant_members").select("*").in("participant_id", pids) : { data: [] };
  return {
    teams: teams || [],
    teamMembers: teamMembers || [],
    participants: participants || [],
    participantMembers: participantMembers || []
  };
}
async function handleCreateCourt(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const court = {
    id: uuid(),
    tournament_id: tournament.id,
    name,
    sort_order: payload.sort_order ?? 0,
    station_public_id: newStationPublicId(),
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("courts", court);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { court }
  });
}
async function handleAddMember(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  if (!["admin", "umpire", "viewer"].includes(payload.role)) {
    throw httpError(400, "INVALID_COMMAND", "role must be admin, umpire, or viewer");
  }
  if (payload.user_id === actor.id && payload.role !== "organizer") {
  }
  if (!isUuid(payload.user_id)) throw httpError(400, "INVALID_COMMAND", "user_id must be a UUID");
  await requireProfile(admin, payload.user_id);
  const { data: existing } = await admin.from("tournament_members").select("*").eq("tournament_id", tournament.id).eq("user_id", payload.user_id).maybeSingle();
  const row = {
    id: existing?.id || uuid(),
    tournament_id: tournament.id,
    user_id: payload.user_id,
    role: payload.role,
    created_at: existing?.created_at || nowIso()
  };
  const batch = createBatch();
  batch.upsert("tournament_members", row);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { member: row }
  });
}
async function handleGenerateBracket(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: existingMatches } = await admin.from("matches").select("id").eq("division_id", division.id).limit(1);
  if (existingMatches?.length) throw httpError(409, "BRACKET_EXISTS", "Division already has matches");
  const { data: participants, error } = await admin.from("participants").select("*").eq("division_id", division.id).order("seed", { ascending: true, nullsFirst: false });
  if (error) throw error;
  const regs = (participants || []).map((p) => ({ id: p.id, seed: p.seed }));
  if (regs.length < 2) throw httpError(400, "INVALID_COMMAND", "Need at least 2 participants");
  const stage = {
    id: uuid(),
    division_id: division.id,
    kind: "bracket",
    name: "Main draw",
    config: {},
    created_at: nowIso()
  };
  const shells = generateBracket(regs, {
    makeId: uuid,
    bronzeMatch: Boolean(division.config?.bronzeMatch)
  });
  const batch = createBatch();
  batch.upsert("stages", stage);
  const ts = nowIso();
  for (const shell of shells) {
    const match = {
      id: shell.id,
      tournament_id: division.tournament_id,
      division_id: division.id,
      stage_id: stage.id,
      parent_match_id: null,
      pair_slot: null,
      round: shell.round,
      bracket_position: shell.bracketPosition,
      bracket_side: shell.bracketSide || "main",
      stage_label: null,
      status: shell.status === "bye" ? "bye" : "scheduled",
      winner: shell.winner || null,
      next_match_id: shell.nextMatchId || null,
      next_match_slot: shell.nextMatchSlot || null,
      loser_next_match_id: shell.loserNextMatchId || null,
      loser_next_match_slot: shell.loserNextMatchSlot || null,
      serving_team: null,
      coin_toss: null,
      score_state: {},
      team_a_wins: 0,
      team_b_wins: 0,
      started_at: null,
      completed_at: shell.status === "bye" ? ts : null,
      created_at: ts,
      updated_at: ts
    };
    persistMatch(batch, match);
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: match.id,
      slot: "A",
      participant_id: shell.registrationAId || null,
      team_id: null
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: match.id,
      slot: "B",
      participant_id: shell.registrationBId || null,
      team_id: null
    });
  }
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { stage, match_count: shells.length }
  });
}
async function handleGenerateTeamElimination(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: existingMatches } = await admin.from("matches").select("id").eq("division_id", division.id).limit(1);
  if (existingMatches?.length) throw httpError(409, "BRACKET_EXISTS", "Division already has matches");
  const { data: teams } = await admin.from("teams").select("*").eq("division_id", division.id);
  const { data: participants } = await admin.from("participants").select("*").eq("division_id", division.id);
  const grouped = groupRegistrationsByTeam(
    (participants || []).map((p) => ({ ...p, teamId: p.team_id })),
    (teams || []).map((t) => ({ id: t.id, name: t.name, bracketGroup: t.bracket_group }))
  );
  if (!grouped.ok) throw httpError(400, "TE_INVALID", grouped.error);
  const { teamMatchups, pairMatches } = generateTeamRoundRobinMatchups(grouped.teams, { makeId: uuid });
  const stage = {
    id: uuid(),
    division_id: division.id,
    kind: "team_round_robin",
    name: "Team round robin",
    config: {},
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("stages", stage);
  persistTeamBracket(batch, division, stage, teamMatchups, pairMatches, grouped, nowIso());
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { stage, team_matchups: teamMatchups.length, pair_matches: pairMatches.length }
  });
}
async function handleGenerateTeamPlayoffs(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  requireOrganizer(member);
  if (division.format !== "team_elimination") {
    throw httpError(400, "INVALID_COMMAND", "Division is not team elimination");
  }
  const { data: stages } = await admin.from("stages").select("*").eq("division_id", division.id);
  if ((stages || []).some((s) => s.kind === "team_knockout")) {
    throw httpError(409, "PLAYOFFS_EXIST", "Knockout stage already generated");
  }
  const { data: teams } = await admin.from("teams").select("*").eq("division_id", division.id);
  const { data: participants } = await admin.from("participants").select("*").eq("division_id", division.id);
  const grouped = groupRegistrationsByTeam(
    (participants || []).map((p) => ({ ...p, teamId: p.team_id })),
    (teams || []).map((t) => ({ id: t.id, name: t.name, bracketGroup: t.bracket_group }))
  );
  if (!grouped.ok) throw httpError(400, "TE_INVALID", grouped.error);
  const { data: allMatches } = await admin.from("matches").select("*").eq("division_id", division.id);
  const parents = (allMatches || []).filter((m) => !m.parent_match_id);
  if (!parents.length) throw httpError(409, "RR_INCOMPLETE", "Generate qualification matches first");
  const { data: allSides } = await admin.from("match_participants").select("*").in("match_id", (allMatches || []).map((m) => m.id));
  const rrMatchups = parents.map((m) => {
    const s = (allSides || []).filter((x) => x.match_id === m.id);
    const winnerSlot = m.winner;
    return {
      id: m.id,
      stage: "round_robin",
      status: m.status,
      teamAId: s.find((x) => x.slot === "A")?.team_id,
      teamBId: s.find((x) => x.slot === "B")?.team_id,
      teamAWins: m.team_a_wins,
      teamBWins: m.team_b_wins,
      winnerTeamId: winnerSlot ? s.find((x) => x.slot === winnerSlot)?.team_id : null
    };
  });
  if (!isTeamRoundRobinComplete(rrMatchups)) {
    throw httpError(409, "RR_INCOMPLETE", "Qualification round robin is not complete");
  }
  const pairRows = (allMatches || []).filter((m) => m.parent_match_id).map((m) => {
    const s = (allSides || []).filter((x) => x.match_id === m.id);
    return {
      id: m.id,
      teamMatchupId: m.parent_match_id,
      status: m.status,
      winner: m.winner,
      registrationAId: s.find((x) => x.slot === "A")?.participant_id,
      registrationBId: s.find((x) => x.slot === "B")?.participant_id,
      score: { scoreA: m.score_state?.scoreA ?? 0, scoreB: m.score_state?.scoreB ?? 0 }
    };
  });
  const ranked = rankIndividualPairsForSemifinals(grouped.teams, rrMatchups, pairRows);
  const mode = division.config?.qualifierMode || "top_x";
  const count = Number(division.config?.qualifierCount || 4);
  const qualifiers = selectQualifiers(ranked, mode, count);
  if (qualifiers.length < 2) throw httpError(400, "TE_INVALID", "Not enough qualifiers for playoffs");
  const startRound = Math.max(0, ...parents.map((m) => m.round || 0)) + 1;
  const { teamMatchups, pairMatches } = generateQualifierBracketShell(qualifiers, {
    makeId: uuid,
    startRound,
    sameTeamPolicy: division.config?.sameTeamPolicy || "avoid_semis"
  });
  const stage = {
    id: uuid(),
    division_id: division.id,
    kind: "team_knockout",
    name: "Team playoffs",
    config: { qualifierMode: mode, qualifierCount: count },
    created_at: nowIso()
  };
  const batch = createBatch();
  batch.upsert("stages", stage);
  persistTeamBracket(batch, division, stage, teamMatchups, pairMatches, grouped, nowIso());
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: {
      stage,
      team_matchups: teamMatchups.length,
      pair_matches: pairMatches.length,
      qualifiers: qualifiers.map((q) => q.registrationId)
    }
  });
}
async function handleAssignCourt(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: court } = await admin.from("courts").select("*").eq("id", payload.court_id).maybeSingle();
  if (!court || court.tournament_id !== match.tournament_id) {
    throw httpError(400, "INVALID_COMMAND", "Court does not belong to this tournament");
  }
  const { data: onCourt } = await admin.from("court_assignments").select("match_id").eq("court_id", court.id);
  const otherIds = (onCourt || []).map((r) => r.match_id).filter((id) => id !== match.id);
  if (otherIds.length) {
    const { data: live } = await admin.from("matches").select("id, status").in("id", otherIds).eq("status", "in_progress");
    if (live?.length) {
      throw httpError(409, "COURT_BUSY", "This court already has a live match");
    }
  }
  const { data: existing } = await admin.from("court_assignments").select("*").eq("match_id", match.id).maybeSingle();
  const batch = createBatch();
  batch.upsert("court_assignments", {
    id: existing?.id || uuid(),
    match_id: match.id,
    court_id: court.id,
    assigned_by: actor.id,
    assigned_at: nowIso()
  });
  if (match.status === "scheduled") {
    assertTransitionMatch(match.status, "ready");
    persistMatch(batch, { ...match, status: "ready" });
  }
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match_id: match.id, court_id: court.id, status: match.status === "scheduled" ? "ready" : match.status }
  });
}
async function handleAssignUmpire(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  requireOrganizer(member);
  const umpireMember = await loadMember(admin, match.tournament_id, payload.user_id);
  if (!umpireMember || !["umpire", "organizer", "admin"].includes(umpireMember.role)) {
    throw httpError(400, "INVALID_COMMAND", "User is not an umpire for this tournament");
  }
  const { data: existing } = await admin.from("umpire_assignments").select("*").eq("match_id", match.id).maybeSingle();
  const batch = createBatch();
  batch.upsert("umpire_assignments", {
    id: existing?.id || uuid(),
    match_id: match.id,
    user_id: payload.user_id,
    assigned_by: actor.id,
    assigned_at: nowIso()
  });
  let status = match.status;
  if (match.status === "ready" || match.status === "scheduled") {
    assertTransitionMatch(match.status, "assigned");
    status = "assigned";
    persistMatch(batch, { ...match, status });
  }
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match_id: match.id, umpire_id: payload.user_id, status }
  });
}
async function handleTransitionMatch(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  requireOrganizer(member);
  try {
    assertTransitionMatch(match.status, payload.status);
  } catch (err) {
    throw httpError(409, err.code || "ILLEGAL_TRANSITION", err.message);
  }
  const batch = createBatch();
  persistMatch(batch, { ...match, status: payload.status });
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: { ...match, status: payload.status } }
  });
}
async function handleStartMatch(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  try {
    assertTransitionMatch(match.status, "in_progress");
  } catch (err) {
    throw httpError(409, err.code || "ILLEGAL_TRANSITION", err.message);
  }
  const division = await getDivision(admin, match.division_id);
  const score_state = scoreStateForMatchStart(match, scoringSettings(division.config));
  const next = { ...match, status: "in_progress", started_at: nowIso(), score_state };
  const batch = createBatch();
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: next }
  });
}
function coinTossResult(match, extra = {}) {
  const coin_toss = readCoinToss(match);
  return {
    match,
    match_id: match.id,
    coin_toss,
    score_state: match.score_state,
    ...extra
  };
}
async function handleCoinToss(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  if (!["assigned", "in_progress", "ready"].includes(match.status)) {
    throw httpError(409, "ILLEGAL_TRANSITION", `Cannot coin toss from ${match.status}`);
  }
  if (!isUuid(payload.event_id)) throw httpError(400, "INVALID_COMMAND", "event_id must be a UUID");
  const { data: existing } = await admin.from("score_events").select("*").eq("id", payload.event_id).maybeSingle();
  if (existing) {
    return existingReceipt(admin, envelope.command_id).then((r) => r?.result || coinTossResult(match, { duplicate: true }));
  }
  const division = await getDivision(admin, match.division_id);
  const { data: events } = await admin.from("score_events").select("*").eq("match_id", match.id).order("seq");
  const priorToss = (events || []).find((row) => row.type === "coin_toss");
  const already = readCoinToss(match) || (priorToss ? normalizeCoinTossPayload(priorToss.payload, match.serving_team) : null);
  if (already) {
    const kept = {
      ...match,
      coin_toss: match.coin_toss || already,
      serving_team: match.serving_team || already.servingTeam
    };
    return commit(admin, createBatch(), {
      ...envelope,
      ...actorCommit(actor),
      tournamentId: match.tournament_id,
      matchId: match.id,
      result: coinTossResult(kept, { duplicate: true })
    });
  }
  const toss = normalizeCoinTossPayload({
    result: payload.result,
    winner: payload.winner,
    servingTeam: payload.serving_team,
    courtSide: payload.court_side
  }, match.serving_team);
  if (!payload.result && !payload.winner && !payload.serving_team) {
    throw httpError(400, "INVALID_COMMAND", "coin toss result is required");
  }
  const event = {
    id: payload.event_id,
    seq: payload.seq ?? 1,
    type: "coin_toss",
    payload: toss
  };
  let state = reduceScoreEvents(scoringSettings(division.config), events || []);
  const applied = applyScoreEvent(state, event);
  state = applied.state;
  if (!applied.applied) {
    const kept = { ...match, coin_toss: already || toss, serving_team: match.serving_team || toss.servingTeam, score_state: state };
    return commit(admin, createBatch(), {
      ...envelope,
      ...actorCommit(actor),
      tournamentId: match.tournament_id,
      matchId: match.id,
      result: coinTossResult(kept, { duplicate: true })
    });
  }
  const next = {
    ...match,
    coin_toss: toss,
    serving_team: toss.servingTeam,
    score_state: state
  };
  const batch = createBatch();
  batch.upsert("score_events", {
    id: event.id,
    match_id: match.id,
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    ...scoreActor(actor),
    created_at: nowIso()
  });
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: coinTossResult(next)
  });
}
async function handleScoreEvent(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  try {
    assertAllowedScoreEventType(payload.type, actor);
  } catch (err) {
    throw httpError(err.status || 403, err.code || "FORBIDDEN", err.message);
  }
  const isCorrection = payload.type === "correction";
  const wasCompleted = match.status === "completed";
  const division = await getDivision(admin, match.division_id);
  const settings = scoringSettings(division.config);
  const eventPayload = payload.event_payload || payload.payload || {};
  if (wasCompleted) {
    if (!isCorrection) throw httpError(409, "ILLEGAL_TRANSITION", "Match is not in progress");
    if ((settings.bestOf || 1) > 1) {
      throw httpError(409, "CORRECTION_UNSUPPORTED", "Correcting a completed multi-game match is not supported");
    }
    if (eventPayload.confirm_completed !== true) {
      throw httpError(409, "CONFIRMATION_REQUIRED", "Correcting a completed match requires explicit confirmation");
    }
    if (typeof eventPayload.reason !== "string" || !eventPayload.reason.trim()) {
      throw httpError(400, "REASON_REQUIRED", "A reason is required to correct a completed match");
    }
  } else if (match.status !== "in_progress") {
    throw httpError(409, "ILLEGAL_TRANSITION", "Match is not in progress");
  }
  if (!isUuid(payload.event_id)) throw httpError(400, "INVALID_COMMAND", "event_id must be a UUID");
  if (typeof payload.seq !== "number") throw httpError(400, "INVALID_COMMAND", "seq is required");
  const { data: dup } = await admin.from("score_events").select("id").eq("id", payload.event_id).maybeSingle();
  const cached = match.score_state && typeof match.score_state.lastSeq === "number" ? match.score_state : null;
  const canFastForward = Boolean(cached) && payload.seq === cached.lastSeq + 1;
  async function reducedState() {
    const { data: events } = await admin.from("score_events").select("*").eq("match_id", match.id).order("seq");
    return reduceScoreEvents(settings, events || []);
  }
  if (dup) {
    const known = cached && (cached.appliedEventIds || []).includes(payload.event_id);
    const state2 = known ? cached : await reducedState();
    return { match: { ...match, score_state: state2 }, duplicate: true };
  }
  const event = {
    id: payload.event_id,
    seq: payload.seq,
    type: payload.type,
    payload: eventPayload
  };
  let base;
  let applied;
  try {
    base = canFastForward ? cached : await reducedState();
    applied = applyScoreEvent(base, event);
  } catch (err) {
    throw httpError(409, err.code || "OUT_OF_ORDER", err.message);
  }
  if (!applied.applied && !applied.duplicate) {
    throw httpError(400, "INVALID_COMMAND", "That score event could not be applied");
  }
  const state = applied.state;
  if (isCorrection && wasCompleted && (state.status !== "completed" || state.winner !== match.score_state?.winner)) {
    throw httpError(409, "WOULD_CHANGE_WINNER", "This correction would change the match winner. Corrections to a completed match cannot change the winner.");
  }
  const batch = createBatch();
  batch.upsert("score_events", {
    id: event.id,
    match_id: match.id,
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    ...scoreActor(actor),
    created_at: nowIso()
  });
  let progressed = null;
  let completed = null;
  let detail;
  if (isCorrection) {
    detail = {
      ok: true,
      correction: {
        match_id: match.id,
        game: state.gameNumber,
        previous: { scoreA: base.scoreA ?? null, scoreB: base.scoreB ?? null },
        next: { scoreA: state.scoreA, scoreB: state.scoreB },
        reason: eventPayload.reason || null
      }
    };
  }
  if (wasCompleted) {
    persistMatch(batch, { ...match, score_state: state });
    const { data: existingResult } = await admin.from("match_results").select("*").eq("match_id", match.id).maybeSingle();
    if (existingResult) {
      batch.upsert("match_results", { ...existingResult, games: state.games || [], score_a: state.scoreA, score_b: state.scoreB });
    }
  } else {
    persistMatch(batch, { ...match, score_state: state });
    if (state.status === "completed") {
      const fin = await finishMatchIfWon(admin, batch, { ...match, score_state: state }, state, actor.kind === "station" ? actor.deviceId : actor.id);
      completed = fin.match;
      progressed = fin.progressed;
    }
  }
  const result = await commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: completed || { ...match, score_state: state }, score_state: state, duplicate: false, progressed },
    detail
  });
  if (!wasCompleted && state.status === "completed") {
    await reconcilePlayoffChildren(admin, match.division_id);
  }
  return result;
}
async function handleCompleteMatch(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  if (match.status === "completed") {
    await reconcilePlayoffChildren(admin, match.division_id);
    return { match, already_complete: true };
  }
  const division = await getDivision(admin, match.division_id);
  const { data: events } = await admin.from("score_events").select("*").eq("match_id", match.id).order("seq");
  const state = reduceScoreEvents(scoringSettings(division.config), events || []);
  if (state.status !== "completed") {
    throw httpError(409, "MATCH_NOT_WON", "Scoring has not produced a winner");
  }
  const batch = createBatch();
  const fin = await finishMatchIfWon(admin, batch, match, state, actor.kind === "station" ? actor.deviceId : actor.id);
  const result = await commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: fin.match, progressed: fin.progressed }
  });
  await reconcilePlayoffChildren(admin, match.division_id);
  return result;
}
async function handleOpenCourtPairing(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const { data: court } = await admin.from("courts").select("*").eq("id", payload.court_id).maybeSingle();
  if (!court) throw httpError(404, "NOT_FOUND", "Court not found");
  const member = await loadMember(admin, court.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: openGrants } = await admin.from("court_pairing_grants").select("*").eq("court_id", court.id).is("consumed_at", null);
  const batch = createBatch();
  const now = nowIso();
  for (const g of openGrants || []) {
    batch.upsert("court_pairing_grants", { ...g, consumed_at: now });
  }
  const pairingToken = randomToken();
  const grant = {
    id: uuid(),
    court_id: court.id,
    tournament_id: court.tournament_id,
    token_hash: await sha256Hex(pairingToken),
    expires_at: new Date(Date.now() + 10 * 60 * 1e3).toISOString(),
    consumed_at: null,
    created_by: actor.id,
    created_at: now
  };
  batch.upsert("court_pairing_grants", grant);
  const persisted = {
    grant_id: grant.id,
    court_id: court.id,
    station_public_id: court.station_public_id,
    expires_at: grant.expires_at
  };
  await commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: court.tournament_id,
    result: persisted
  });
  return {
    ...persisted,
    pairing_token: pairingToken,
    pairing_payload: { v: 1, sid: court.station_public_id, g: pairingToken }
  };
}
async function handleRevokeCourtDevice(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const { data: court } = await admin.from("courts").select("*").eq("id", payload.court_id).maybeSingle();
  if (!court) throw httpError(404, "NOT_FOUND", "Court not found");
  const member = await loadMember(admin, court.tournament_id, actor.id);
  requireOrganizer(member);
  const { data: device } = await admin.from("court_devices").select("*").eq("court_id", court.id).eq("status", "active").maybeSingle();
  if (!device) throw httpError(404, "NOT_FOUND", "No active device on this court");
  const batch = createBatch();
  batch.upsert("court_devices", {
    ...device,
    status: "revoked",
    revoked_at: nowIso()
  });
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: court.tournament_id,
    result: { court_id: court.id, device_id: device.id, status: "revoked" }
  });
}
async function handleStationSync(admin, actor) {
  if (actor.kind !== "station") throw httpError(403, "FORBIDDEN", "Court station session required");
  const { data: court } = await admin.from("courts").select("*").eq("id", actor.courtId).maybeSingle();
  const { data: assignments } = await admin.from("court_assignments").select("*").eq("court_id", actor.courtId);
  const matchIds = (assignments || []).map((a) => a.match_id);
  let matches = [];
  if (matchIds.length) {
    const { data } = await admin.from("matches").select("*").in("id", matchIds);
    matches = data || [];
  }
  const { data: sides } = matchIds.length ? await admin.from("match_participants").select("*").in("match_id", matchIds) : { data: [] };
  const { data: participants } = await admin.from("participants").select("*").eq("tournament_id", actor.tournamentId);
  await admin.from("court_devices").update({ last_seen_at: nowIso() }).eq("id", actor.deviceId);
  const live = matches.filter((m) => m.status === "in_progress");
  const next = matches.filter((m) => ["scheduled", "ready", "assigned"].includes(m.status));
  const done = matches.filter((m) => ["completed", "bye", "cancelled", "abandoned"].includes(m.status));
  return {
    court,
    tournament_id: actor.tournamentId,
    matches,
    assignments: assignments || [],
    sides: sides || [],
    participants: participants || [],
    current: live[0] || next[0] || null,
    live,
    next,
    done
  };
}
var HANDLERS = {
  create_tournament: handleCreateTournament,
  update_tournament: handleUpdateTournament,
  transition_tournament: handleTransitionTournament,
  create_division: handleCreateDivision,
  update_division: handleUpdateDivision,
  add_person: handleAddPerson,
  update_person: handleUpdatePerson,
  remove_person: handleRemovePerson,
  create_team: handleCreateTeam,
  add_team_member: handleAddTeamMember,
  remove_team_member: handleRemoveTeamMember,
  register_participant: handleRegisterParticipant,
  remove_participant: handleRemoveParticipant,
  update_match_participant: handleUpdateMatchParticipant,
  create_court: handleCreateCourt,
  add_member: handleAddMember,
  generate_bracket: handleGenerateBracket,
  generate_team_elimination: handleGenerateTeamElimination,
  generate_team_playoffs: handleGenerateTeamPlayoffs,
  assign_court: handleAssignCourt,
  assign_umpire: handleAssignUmpire,
  open_court_pairing: handleOpenCourtPairing,
  revoke_court_device: handleRevokeCourtDevice,
  station_sync: handleStationSync,
  transition_match: handleTransitionMatch,
  start_match: handleStartMatch,
  coin_toss: handleCoinToss,
  score_event: handleScoreEvent,
  complete_match: handleCompleteMatch
};
async function handleCommand({ admin, actor, body }) {
  if (!actor?.id) throw httpError(401, "UNAUTHENTICATED", "Missing actor");
  const envelope = parseCommandEnvelope(body);
  try {
    assertStationMayIssue(actor, envelope.type, envelope.payload);
  } catch (err) {
    throw httpError(err.status || 403, err.code || "FORBIDDEN", err.message);
  }
  const prior = await existingReceipt(admin, envelope.command_id);
  if (prior) return { ok: true, idempotent: true, result: prior.result };
  const handler = HANDLERS[envelope.type];
  const result = await handler(admin, actor, envelope.payload, envelope);
  return { ok: true, idempotent: false, result };
}
export {
  STATION_COMMANDS,
  STATION_FORBIDDEN_COMMANDS,
  STATION_SCORE_EVENT_TYPES,
  assertStationMayIssue,
  handleCommand,
  resolveActor
};
