import {
  assertTransitionTournament,
  assertTransitionMatch,
  generateBracket,
  advanceBracket,
  advanceBronzeMatchSlot,
  scoreStateForMatchStart,
  applyScoreEvent,
  reduceScoreEvents,
  matchScoringTarget,
  QUALIFICATION_TARGET,
  SCORING_WIN_BY,
  normalizeCoinTossPayload,
  readCoinToss,
  groupRegistrationsByTeam,
  generateTeamRoundRobinMatchups,
  finalizeCrossTeamMatchup,
  advanceIndividualMatchup,
  advanceBronzeIndividualMatchup,
  isTeamRoundRobinComplete,
  rankIndividualPairsForSemifinals,
  selectQualifiers,
  expectedQualifierCount,
  findCutoffTies,
  generateQualifierBracketShell,
  assignedPersonIds,
  validatePersonIdsForAssignment,
  MIN_GAME_TIME_SEC,
  MAX_GAME_TIME_SEC,
  MAX_ADJUST_SEC,
  isValidGameTimeSec,
  isValidTimerAdjustSec,
  normalizeTimer,
  configureTimer,
  timerFromDivisionConfig,
  startTimer,
  pauseTimer,
  adjustTimer,
  resetTimer,
} from "@tournament/engine";
import { parseCommandEnvelope, isUuid } from "@tournament/contracts";
import { applyBatch, createBatch, httpError, isUniqueViolation, nowIso, uuid } from "./writes.js";
import { ensureUniqueSlug } from "./slug.js";
import {
  loadMember,
  requireOrganizer,
  requireOrganizerLicensed,
  requireLicense,
  requireProfile,
  requireScoreAccess,
  requireStationScoreAccess,
  assertStationMayIssue,
  assertAllowedScoreEventType,
} from "./authz.js";
export { STATION_COMMANDS, STATION_SCORE_EVENT_TYPES, STATION_FORBIDDEN_COMMANDS, assertStationMayIssue } from "./authz.js";
import { randomToken, sha256Hex } from "./stationAuth.js";
export { resolveActor } from "./stationAuth.js";

// Team elimination qualification is always per team; qualifierCount = pairs per team.
// Retired modes (top_x, top_x_overall, manual) stay readable on old rows but are
// never accepted on a write, and never used to generate playoffs.
const TEAM_QUALIFIER_MODE = "top_x_per_team";
const DEFAULT_QUALIFIERS_PER_TEAM = 2;
// supabase/migrations/0017_one_team_knockout_stage_per_division.sql
const KNOCKOUT_STAGE_UNIQUE_INDEX = "stages_one_team_knockout_per_division_uidx";

// A qualifier count must be a real positive whole number — no coercion, so
// "2", 1.5, 0, -1, NaN, Infinity, "", null are all rejected rather than
// silently turned into some other number.
function isValidQualifierCount(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

// Optional division default game time. null clears it; anything else present
// must be a valid whole number of seconds.
function assertGameTimeConfig(config) {
  if (!config || !Object.hasOwn(config, "gameTimeSeconds") || config.gameTimeSeconds === null) return;
  if (!isValidGameTimeSec(config.gameTimeSeconds)) {
    throw httpError(400, "INVALID_GAME_TIME", `Game time must be a whole number of seconds from ${MIN_GAME_TIME_SEC} to ${MAX_GAME_TIME_SEC}`);
  }
}

function assertTeamQualificationConfig(config) {
  if (Object.hasOwn(config, "qualifierMode") && config.qualifierMode !== TEAM_QUALIFIER_MODE) {
    throw httpError(
      400,
      "INVALID_QUALIFIER_MODE",
      `Qualification mode "${config.qualifierMode}" is retired. Team elimination only supports "${TEAM_QUALIFIER_MODE}" (qualifiers per team).`,
    );
  }
  if (Object.hasOwn(config, "qualifierCount") && !isValidQualifierCount(config.qualifierCount)) {
    throw httpError(
      400,
      "INVALID_QUALIFIER_COUNT",
      `Qualifiers per team must be a whole number of 1 or more (got ${JSON.stringify(config.qualifierCount) ?? "undefined"}).`,
    );
  }
}

function scoringSettings(config = {}) {
  return {
    winTo: QUALIFICATION_TARGET,
    // This product's scoring rule: first to reach the target wins
    // immediately — no deuce/win-by-2. checkGameWin (scoring.js) still
    // generically supports "two"/"one" win-by modes, but this product only
    // ever uses "none", regardless of what a division's config may have
    // stored previously.
    winBy: SCORING_WIN_BY,
    bestOf: config.bestOf ?? 1,
    isDoubles: config.isDoubles !== false,
    timeoutsAllowed: config.timeoutsAllowed ?? 2,
  };
}

// The authoritative scoring rules for one match. The target is decided by the
// match's stage (qualification 11; semifinal/final/bronze 15) — never by the
// division's stored winTo or a client-chosen override — and is used for every
// path that builds or re-reduces a match's score state (start, coin toss,
// score events, complete), so a recompute can never silently change targets.
async function matchScoringSettings(admin, division, match) {
  let related = [];
  if (!match.stage_label) {
    const cols = "id, round, bracket_side, parent_match_id, stage_id, stage_label, division_id";
    if (match.parent_match_id) {
      const { data: parent } = await admin.from("matches").select(cols).eq("id", match.parent_match_id).maybeSingle();
      related = parent ? [parent] : [];
    } else if (match.stage_id) {
      const { data: siblings } = await admin.from("matches").select(cols).eq("stage_id", match.stage_id);
      related = siblings || [];
    }
  }
  return { ...scoringSettings(division.config), winTo: matchScoringTarget(match, related), winBy: SCORING_WIN_BY };
}

// One transaction (apply_official_writes): the receipt claim, the optional
// version checks and every domain write commit together or not at all.
async function commit(admin, batch, { command_id, type, request_hash, precondition, actorId, actorDeviceId, tournamentId, matchId, result, detail }) {
  // Client-supplied "I last saw this version of the match" (optional; used by
  // future offline writes; validated in handleCommand). Stale → 409
  // STALE_STATE, nothing written. Never silently dropped.
  if (precondition) {
    if (!matchId) throw httpError(500, "INTERNAL", "precondition could not be applied");
    batch.preconditionMatch(matchId, precondition.match_updated_at);
  }
  batch.upsert("command_receipts", {
    id: command_id,
    actor_id: actorDeviceId ? null : actorId,
    actor_device_id: actorDeviceId || null,
    command_type: type,
    ...(request_hash ? { request_hash } : {}),
    result,
    created_at: nowIso(),
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
    created_at: nowIso(),
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

function matchNotReady(message) {
  return httpError(409, "MATCH_NOT_READY", message);
}

// Server-side gate for start/coin toss/score/complete. A match can only be
// played when it is a real playable match with both sides filled by valid
// participants of its own division:
// - a team_elimination team-matchup shell (round robin, semifinal, final,
//   bronze parent) is a container and is never played directly — its pair
//   match is;
// - both slots must hold a participant (a final/bronze pair match only exists
//   once both semifinal winners/losers are in, but this is enforced here too);
// - a knockout pair match must sit in its parent's stage and carry exactly the
//   pairs its parent slot holds.
async function assertMatchPlayable(admin, match, division) {
  if (division.format === "team_elimination" && !match.parent_match_id) {
    throw matchNotReady("This is a team matchup; its pair match is played instead.");
  }
  const sides = await matchSides(admin, match.id);
  const a = sides.find((s) => s.slot === "A");
  const b = sides.find((s) => s.slot === "B");
  if (!a?.participant_id || !b?.participant_id) {
    throw matchNotReady("Both sides of this match must be filled before it can be started or scored.");
  }
  if (a.participant_id === b.participant_id) {
    throw matchNotReady("A pair cannot play against itself.");
  }
  const { data: participants, error } = await admin
    .from("participants")
    .select("id, division_id")
    .in("id", [a.participant_id, b.participant_id]);
  if (error) throw error;
  const valid = (participants || []).filter((p) => p.division_id === match.division_id);
  if (valid.length !== 2) {
    throw matchNotReady("This match references a participant that is not registered in its division.");
  }
  if (match.parent_match_id) {
    const parent = await getMatch(admin, match.parent_match_id);
    if (parent.division_id !== match.division_id || parent.stage_id !== match.stage_id) {
      throw matchNotReady("This pair match does not belong to its matchup's stage.");
    }
    if (parent.stage_label && parent.stage_label !== "round_robin") {
      const parentSides = await matchSides(admin, parent.id);
      const pa = parentSides.find((s) => s.slot === "A")?.participant_id;
      const pb = parentSides.find((s) => s.slot === "B")?.participant_id;
      if (pa !== a.participant_id || pb !== b.participant_id) {
        throw matchNotReady("This playoff match's pairs do not match its bracket slot yet.");
      }
    }
  }
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
  // Only the organizer/admin-capability path consumes a license seat here —
  // an umpire scoring their own assigned match never needs one (see
  // docs/LICENSING.md: Umpire's own login doesn't consume an Operator seat).
  if (member.role === "organizer" || member.role === "admin") {
    await requireLicense(admin, actor);
  }
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

// A malformed id makes Postgres refuse the query (22P02 invalid uuid). That is
// the caller's mistake, not a server failure — a 500 here would be retried
// by clients forever.
function lookupError(error, what) {
  if (error?.code === "22P02") return httpError(400, "INVALID_COMMAND", `${what} must be a UUID`);
  return error;
}

async function getTournament(admin, id) {
  const { data, error } = await admin.from("tournaments").select("*").eq("id", id).maybeSingle();
  if (error) throw lookupError(error, "tournament_id");
  if (!data) throw httpError(404, "NOT_FOUND", "Tournament not found");
  return data;
}

async function getDivision(admin, id) {
  const { data, error } = await admin.from("divisions").select("*").eq("id", id).maybeSingle();
  if (error) throw lookupError(error, "division_id");
  if (!data) throw httpError(404, "NOT_FOUND", "Division not found");
  return data;
}

async function getMatch(admin, id) {
  const { data, error } = await admin.from("matches").select("*").eq("id", id).maybeSingle();
  if (error) throw lookupError(error, "match_id");
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
    updated_at: nowIso(),
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
    const winnerSlot = bye && mu.winnerTeamId
      ? (mu.winnerTeamId === mu.teamAId ? "A" : "B")
      : null;
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
      updated_at: ts,
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: mu.id,
      slot: "A",
      participant_id: mu.pairAId || null,
      team_id: mu.teamAId || null,
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: mu.id,
      slot: "B",
      participant_id: mu.pairBId || null,
      team_id: mu.teamBId || null,
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
      updated_at: ts,
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: pm.id,
      slot: "A",
      participant_id: pm.registrationAId,
      team_id: pairTeamId(grouped, pm.registrationAId),
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: pm.id,
      slot: "B",
      participant_id: pm.registrationBId,
      team_id: pairTeamId(grouped, pm.registrationBId),
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
    team_id: teamId ?? null,
  });
}

function applyIndividualPatch(batch, matchups, muSides, adv) {
  if (!adv) return;
  const next = (matchups || []).find((m) => m.id === adv.matchupId);
  if (next) {
    // Rewrites the whole next-matchup row read earlier in this request: it
    // must still be that version (e.g. two semifinals finishing at once both
    // advance into the same final). A race re-runs the command on fresh state.
    batch.expectMatch(next);
    persistMatch(batch, { ...next, status: next.status === "bye" ? "bye" : "scheduled" });
  }
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
    updated_at: ts,
  });
  const { data: childSides } = existing
    ? await admin.from("match_participants").select("*").eq("match_id", childId)
    : { data: [] };
  for (const slot of ["A", "B"]) {
    const parentSide = overlaySides.find((s) => s.slot === slot);
    const row = (childSides || []).find((x) => x.slot === slot);
    batch.upsert("match_participants", {
      id: row?.id || uuid(),
      match_id: childId,
      slot,
      participant_id: parentSide.participant_id,
      team_id: parentSide.team_id ?? null,
    });
  }
  return true;
}

async function reconcilePlayoffChildren(admin, divisionId, format) {
  if (format !== "team_elimination") return;
  if (!divisionId) return;
  const { data: parents } = await admin
    .from("matches")
    .select("*")
    .eq("division_id", divisionId)
    .is("parent_match_id", null);
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
    // Concurrent unique (parent_match_id, pair_slot) — child already persisted.
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
    updated_at: nowIso(),
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
    completed_at: nowIso(),
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
        status: m.status,
      };
    });
    const patch = advanceBracket(engineMatches, match.id, winnerSide.participant_id);
    if (patch) {
      const next = (all || []).find((m) => m.id === patch.matchId);
      if (next) {
        batch.expectMatch(next);
        persistMatch(batch, { ...next });
        if (patch.patch.registrationAId) {
          const row = (allSides || []).find((x) => x.match_id === patch.matchId && x.slot === "A");
          batch.upsert("match_participants", {
            id: row?.id || uuid(),
            match_id: patch.matchId,
            slot: "A",
            participant_id: patch.patch.registrationAId,
            team_id: row?.team_id ?? null,
          });
        }
        if (patch.patch.registrationBId) {
          const row = (allSides || []).find((x) => x.match_id === patch.matchId && x.slot === "B");
          batch.upsert("match_participants", {
            id: row?.id || uuid(),
            match_id: patch.matchId,
            slot: "B",
            participant_id: patch.patch.registrationBId,
            team_id: row?.team_id ?? null,
          });
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
            team_id: null,
          });
        }
        if (bronze.patch.registrationBId) {
          const rowB = (allSides || []).find((x) => x.match_id === bronze.matchId && x.slot === "B");
          batch.upsert("match_participants", {
            id: rowB?.id || uuid(),
            match_id: bronze.matchId,
            slot: "B",
            participant_id: bronze.patch.registrationBId,
            team_id: null,
          });
        }
        progressed = { ...(progressed || {}), bronze };
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
      score: m.id === match.id
        ? { scoreA: scoreState.scoreA, scoreB: scoreState.scoreB }
        : (m.score_state || {}),
    }));
    const finalized = finalizeCrossTeamMatchup(
      {
        id: parent.id,
        teamAId: parentSides.find((s) => s.slot === "A")?.team_id,
        teamBId: parentSides.find((s) => s.slot === "B")?.team_id,
      },
      pairMatches,
    );
    // Always version-check (and touch) the parent matchup, even when this win
    // doesn't decide it: two pair matches finishing at the same moment would
    // otherwise each see the other still in progress, neither would finalize
    // the matchup, and it would never complete. Touching the parent makes the
    // second request fail its check (STALE_WRITE) and re-run against the
    // first one's committed result.
    batch.expectMatch(parent);
    if (!finalized) persistMatch(batch, { ...parent });
    if (finalized) {
      persistMatch(batch, {
        ...parent,
        status: "completed",
        winner: finalized.winnerSlot,
        team_a_wins: finalized.teamAWins,
        team_b_wins: finalized.teamBWins,
        completed_at: nowIso(),
      });
      const { data: matchups } = await admin
        .from("matches")
        .select("*")
        .eq("division_id", parent.division_id)
        .is("parent_match_id", null);
      const { data: muSides } = await admin
        .from("match_participants")
        .select("*")
        .in("match_id", (matchups || []).map((m) => m.id));
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
          status: m.status,
        };
      });
      const winnerPairId = winnerSide?.participant_id ?? null;
      const loserPairId = loserSide?.participant_id ?? null;
      const winnerTeamId = winnerSlot === "A"
        ? parentSides.find((s) => s.slot === "A")?.team_id
        : parentSides.find((s) => s.slot === "B")?.team_id;
      const loserTeamId = winnerSlot === "A"
        ? parentSides.find((s) => s.slot === "B")?.team_id
        : parentSides.find((s) => s.slot === "A")?.team_id;
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
  await requireLicense(admin, actor);
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
    updated_at: ts,
  };
  const batch = createBatch();
  batch.upsert("tournaments", tournament);
  batch.upsert("tournament_members", {
    id: uuid(),
    tournament_id: id,
    user_id: actor.id,
    role: "organizer",
    created_at: ts,
  });
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: id,
    result: { tournament },
  });
}

async function handleUpdateTournament(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const next = {
    ...tournament,
    name: payload.name != null ? String(payload.name).trim() : tournament.name,
    settings: payload.settings != null ? payload.settings : tournament.settings,
    updated_at: nowIso(),
  };
  if (!next.name) throw httpError(400, "INVALID_COMMAND", "name is required");
  // Public "Live" spectator page (see supabase/migrations/0012_public_live_tournaments.sql).
  // A slug is generated once, the first time is_public flips on — never
  // organizer-typed, and never regenerated/cleared afterward, so a
  // previously shared/QR'd link keeps working even if the organizer toggles
  // the page private and public again later.
  if (payload.is_public != null) {
    next.is_public = Boolean(payload.is_public);
    if (next.is_public && !next.slug) {
      next.slug = await ensureUniqueSlug(admin, tournament.id, next.name);
    }
  }
  const batch = createBatch();
  batch.upsert("tournaments", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { tournament: next },
  });
}

async function handleTransitionTournament(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
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
    result: { tournament: next },
  });
}

async function handleCreateDivision(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const format = payload.format || "single_elim";
  const config = { ...(payload.config || { bestOf: 1, winBy: "none", isDoubles: true }) };
  assertGameTimeConfig(config);
  if (format === "team_elimination") {
    assertTeamQualificationConfig(config);
    if (config.sameTeamPolicy == null) config.sameTeamPolicy = "avoid_semis";
    if (!Object.hasOwn(config, "qualifierMode")) config.qualifierMode = TEAM_QUALIFIER_MODE;
    if (!Object.hasOwn(config, "qualifierCount")) config.qualifierCount = DEFAULT_QUALIFIERS_PER_TEAM;
    if (config.progressionMode == null) config.progressionMode = "playoffs";
  }
  const ts = nowIso();
  const division = {
    id: uuid(),
    tournament_id: tournament.id,
    name,
    format,
    config,
    created_at: ts,
    updated_at: ts,
  };
  const batch = createBatch();
  batch.upsert("divisions", division);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { division },
  });
}

async function handleUpdateDivision(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  if (payload.config != null) assertGameTimeConfig(payload.config);
  const next = {
    ...division,
    name: payload.name != null ? String(payload.name).trim() : division.name,
    format: payload.format || division.format,
    config: payload.config != null ? { ...division.config, ...payload.config } : division.config,
    updated_at: nowIso(),
  };
  // Only the fields this request actually sends are validated; untouched
  // legacy values already stored on the row are left exactly as they are.
  if (next.format === "team_elimination" && payload.config != null) {
    assertTeamQualificationConfig(payload.config);
  }
  const batch = createBatch();
  batch.upsert("divisions", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { division: next },
  });
}

// Division deletion is a real, hard delete — not an archive/status flag. The
// `divisions` row is deleted through the same apply_official_writes path as
// every other write; everything scoped to it (teams, participants/participant
// members, stages, matches and everything matches cascade to — match_participants,
// score_events, match_results, court_assignments, umpire_assignments) is removed
// by the existing `on delete cascade` foreign keys already defined in
// supabase/migrations/0001_initial_schema.sql — no migration or schema change is
// needed for this. Courts and persons are tournament-scoped, not division-scoped,
// so they are correctly left untouched. A division with a match currently
// in_progress is protected — deleting it out from under a live umpire session
// would destroy in-flight scoring state, so that must be resolved (completed,
// held, or cancelled) before the division itself can be deleted.
async function handleDeleteDivision(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const { data: liveMatches } = await admin
    .from("matches")
    .select("id")
    .eq("division_id", division.id)
    .eq("status", "in_progress")
    .limit(1);
  if (liveMatches?.length) {
    throw httpError(
      409,
      "DIVISION_HAS_LIVE_MATCHES",
      "This division has a match in progress. Complete, hold, or cancel it before deleting the division.",
    );
  }
  const batch = createBatch();
  batch.delete("divisions", division.id);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { division_id: division.id, deleted: true },
  });
}

async function handleAddPerson(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const display_name = String(payload.display_name || "").trim();
  if (!display_name) throw httpError(400, "INVALID_COMMAND", "display_name is required");
  const person = {
    id: uuid(),
    tournament_id: tournament.id,
    display_name,
    user_id: payload.user_id || null,
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("persons", person);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { person },
  });
}

async function handleUpdatePerson(admin, actor, payload, envelope) {
  if (!isUuid(payload.person_id)) throw httpError(400, "INVALID_COMMAND", "person_id must be a UUID");
  const { data: person } = await admin.from("persons").select("*").eq("id", payload.person_id).maybeSingle();
  if (!person) throw httpError(404, "NOT_FOUND", "Person not found");
  const member = await loadMember(admin, person.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const display_name = String(payload.display_name || "").trim();
  if (!display_name) throw httpError(400, "INVALID_COMMAND", "display_name is required");
  const next = { ...person, display_name };
  const batch = createBatch();
  batch.upsert("persons", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: person.tournament_id,
    result: { person: next },
  });
}

async function handleRemovePerson(admin, actor, payload, envelope) {
  if (!isUuid(payload.person_id)) throw httpError(400, "INVALID_COMMAND", "person_id must be a UUID");
  const { data: person } = await admin.from("persons").select("*").eq("id", payload.person_id).maybeSingle();
  if (!person) throw httpError(404, "NOT_FOUND", "Person not found");
  const member = await loadMember(admin, person.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const { data: used } = await admin.from("participant_members").select("id").eq("person_id", person.id).limit(1);
  if (used?.length) throw httpError(409, "PERSON_IN_USE", "Cannot remove a player who is already registered into a division");
  const batch = createBatch();
  batch.delete("persons", person.id);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: person.tournament_id,
    result: { person_id: person.id, removed: true },
  });
}

async function handleCreateTeam(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  if (payload.division_id) {
    const division = await getDivision(admin, payload.division_id);
    if (division.tournament_id !== tournament.id) {
      throw httpError(400, "INVALID_COMMAND", "Division does not belong to this tournament");
    }
  }
  const team = {
    id: uuid(),
    tournament_id: tournament.id,
    division_id: payload.division_id || null,
    name,
    ranking: payload.ranking ?? null,
    bracket_group: payload.bracket_group ?? null,
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("teams", team);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { team },
  });
}

async function handleAddTeamMember(admin, actor, payload, envelope) {
  const { data: team, error } = await admin.from("teams").select("*").eq("id", payload.team_id).maybeSingle();
  if (error) throw error;
  if (!team) throw httpError(404, "NOT_FOUND", "Team not found");
  const member = await loadMember(admin, team.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  if (!isUuid(payload.person_id)) throw httpError(400, "INVALID_COMMAND", "person_id must be a UUID");
  const { data: person } = await admin.from("persons").select("*").eq("id", payload.person_id).maybeSingle();
  if (!person || person.tournament_id !== team.tournament_id) {
    throw httpError(400, "INVALID_PLAYER", "Person is not in this tournament");
  }
  const { data: existing } = await admin
    .from("team_members")
    .select("*")
    .eq("team_id", team.id)
    .eq("person_id", payload.person_id)
    .maybeSingle();
  if (existing) throw httpError(409, "DUPLICATE_MEMBER", "Player is already on this team");
  if (team.division_id) {
    const snapshot = await loadDivisionAssignment(admin, team.division_id);
    const assigned = assignedPersonIds({
      divisionTeams: snapshot.teams,
      teamMembers: snapshot.teamMembers,
      divisionParticipants: snapshot.participants,
      participantMembers: snapshot.participantMembers,
      exceptTeamId: team.id,
      exceptParticipantTeamId: team.id,
    });
    const check = validatePersonIdsForAssignment([payload.person_id], assigned);
    if (!check.ok) throw httpError(409, check.code, check.message);
  }
  const row = {
    id: uuid(),
    team_id: team.id,
    person_id: payload.person_id,
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("team_members", row);
  try {
    return await commit(admin, batch, {
      ...envelope,
      actorId: actor.id,
      tournamentId: team.tournament_id,
      result: { team_member: row },
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
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
  await requireOrganizerLicensed(admin, actor, member);
  const batch = createBatch();
  batch.delete("team_members", row.id);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: team.tournament_id,
    result: { team_member_id: row.id, removed: true },
  });
}

async function handleRegisterParticipant(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
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
    exceptTeamId: payload.team_id || null,
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
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("participants", participant);
  for (const [i, personId] of personIds.entries()) {
    batch.upsert("participant_members", {
      id: uuid(),
      participant_id: participant.id,
      person_id: personId,
      slot: i + 1,
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
        created_at: nowIso(),
      });
    }
  }
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { participant },
  });
}

async function handleRemoveParticipant(admin, actor, payload, envelope) {
  if (!isUuid(payload.participant_id)) throw httpError(400, "INVALID_COMMAND", "participant_id must be a UUID");
  const { data: participant } = await admin.from("participants").select("*").eq("id", payload.participant_id).maybeSingle();
  if (!participant) throw httpError(404, "NOT_FOUND", "Participant not found");
  const member = await loadMember(admin, participant.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
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
    result: { participant_id: participant.id, removed: true },
  });
}

const MATCH_PARTICIPANT_EDITABLE_STATUSES = new Set(["scheduled", "ready", "assigned", "postponed"]);

// Changes who is assigned to one side of a not-yet-started match — e.g.
// swapping a doubles partner. This never mutates the master `persons` record,
// and never mutates the existing `participants`/`participant_members` rows
// either (those may still be referenced by other matches — e.g. an earlier
// completed round in the same bracket that this same pair already played).
// Instead it creates a fresh participant with the new membership and
// repoints only this match's `match_participants` row at it, leaving every
// other match (past or future) that references the old participant intact.
async function handleUpdateMatchParticipant(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);

  const slot = payload.slot;
  if (slot !== "A" && slot !== "B") throw httpError(400, "INVALID_COMMAND", "slot must be A or B");

  if (!MATCH_PARTICIPANT_EDITABLE_STATUSES.has(match.status)) {
    throw httpError(409, "MATCH_NOT_EDITABLE", "Players can only be changed before the match starts");
  }
  // A team playoff pair match must carry exactly the pairs its matchup slot
  // holds (assertMatchPlayable), so repointing only this match would leave it
  // permanently unplayable.
  if (match.parent_match_id) {
    const parent = await getMatch(admin, match.parent_match_id);
    if (parent.stage_label && parent.stage_label !== "round_robin") {
      throw httpError(409, "MATCH_LOCKED_BY_TEAM_MATCHUP", "Players in a team playoff match come from its bracket slot and can't be changed here");
    }
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
  const { data: personsRows } = await admin.from("persons").select("id, display_name, tournament_id").in("id", [...new Set([...personIds, ...oldPersonIds])]);
  const personById = new Map((personsRows || []).map((p) => [p.id, p]));
  for (const personId of personIds) {
    const person = personById.get(personId);
    if (!person || person.tournament_id !== match.tournament_id) {
      throw httpError(400, "INVALID_PLAYER", "Person is not in this tournament");
    }
  }

  const division = await getDivision(admin, match.division_id);
  const snapshot = await loadDivisionAssignment(admin, division.id);
  // This command creates a fresh participant on every edit and never deletes
  // the one it replaces (see comment above), so a division can accumulate
  // orphaned "history" participants that still have participant_members rows
  // but are no longer placed in any match. Those must be excluded from the
  // "already assigned elsewhere" scan below — otherwise a player kept across
  // an edit (or the same edit resubmitted) spuriously collides with their own
  // match history instead of a real double-booking.
  const { data: divisionMatches } = await admin.from("matches").select("id").eq("division_id", division.id);
  const { data: placedRows } = (divisionMatches || []).length
    ? await admin.from("match_participants").select("participant_id").in("match_id", divisionMatches.map((m) => m.id))
    : { data: [] };
  const placedParticipantIds = new Set((placedRows || []).map((r) => r.participant_id).filter(Boolean));
  const liveParticipants = snapshot.participants.filter((p) => placedParticipantIds.has(p.id));
  const liveParticipantIds = new Set(liveParticipants.map((p) => p.id));
  const liveParticipantMembers = snapshot.participantMembers.filter((m) => liveParticipantIds.has(m.participant_id));
  const assigned = assignedPersonIds({
    divisionTeams: snapshot.teams,
    teamMembers: snapshot.teamMembers,
    divisionParticipants: liveParticipants,
    participantMembers: liveParticipantMembers,
    // exceptTeamId matches exceptParticipantTeamId below (both scope to the
    // side's own team) — without it, assignedPersonIds' team_members scan has
    // no exception at all and flags this side's OWN currently-kept player as
    // "already assigned" purely for being on their own team's roster.
    exceptTeamId: oldParticipant.team_id || null,
    exceptParticipantId: oldParticipant.id,
    exceptParticipantTeamId: oldParticipant.team_id || null,
  });
  const check = validatePersonIdsForAssignment(personIds, assigned);
  if (!check.ok) throw httpError(409, check.code, check.message);

  // For a team-elimination side, the replacement player(s) must actually be
  // registered members of the team this side represents — otherwise the new
  // participant would silently inherit oldParticipant.team_id (see below)
  // while representing a team its real players never joined, corrupting team
  // standings. assignedPersonIds (above) already rejects a person who is on
  // a DIFFERENT team's roster (it scans team_members for every other team in
  // the division) or already placed elsewhere — the residual gap this closes
  // is a person with no team affiliation in this division at all.
  if (oldParticipant.team_id) {
    const teamMemberIds = new Set(
      snapshot.teamMembers.filter((tm) => tm.team_id === oldParticipant.team_id).map((tm) => tm.person_id)
    );
    const outsiders = personIds.filter((id) => !teamMemberIds.has(id));
    if (outsiders.length) {
      throw httpError(409, "PLAYER_NOT_ON_TEAM", "Every player on this side must be a registered member of the team this side represents");
    }
  }

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
    created_at: nowIso(),
  };

  const batch = createBatch();
  batch.upsert("participants", newParticipant);
  for (const [i, personId] of personIds.entries()) {
    batch.upsert("participant_members", {
      id: uuid(),
      participant_id: newParticipant.id,
      person_id: personId,
      slot: i + 1,
    });
  }
  batch.upsert("match_participants", {
    id: mp.id,
    match_id: match.id,
    slot,
    participant_id: newParticipant.id,
    team_id: mp.team_id,
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
        new: { participant_id: newParticipant.id, players: personIds.map((id) => ({ id, name: nameFor(id) })) },
      },
    },
  });
}

async function loadDivisionAssignment(admin, divisionId) {
  const { data: teams } = await admin.from("teams").select("*").eq("division_id", divisionId);
  const teamIds = (teams || []).map((t) => t.id);
  const { data: teamMembers } = teamIds.length
    ? await admin.from("team_members").select("*").in("team_id", teamIds)
    : { data: [] };
  const { data: participants } = await admin.from("participants").select("*").eq("division_id", divisionId);
  const pids = (participants || []).map((p) => p.id);
  const { data: participantMembers } = pids.length
    ? await admin.from("participant_members").select("*").in("participant_id", pids)
    : { data: [] };
  return {
    teams: teams || [],
    teamMembers: teamMembers || [],
    participants: participants || [],
    participantMembers: participantMembers || [],
  };
}

async function handleCreateCourt(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const court = {
    id: uuid(),
    tournament_id: tournament.id,
    name,
    sort_order: payload.sort_order ?? 0,
    station_public_id: newStationPublicId(),
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("courts", court);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { court },
  });
}

function sameUuid(a, b) {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

async function handleAddMember(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  if (!["admin", "umpire", "viewer"].includes(payload.role)) {
    throw httpError(400, "INVALID_COMMAND", "role must be admin, umpire, or viewer");
  }
  if (!isUuid(payload.user_id)) throw httpError(400, "INVALID_COMMAND", "user_id must be a UUID");
  // No one may change their own role here, and the organizer's role can't be
  // changed at all: add_member can't grant "organizer" back, so a demotion
  // would be permanent.
  // Postgres compares UUIDs case-insensitively, so these checks must too — an
  // upper-cased id would otherwise slip past them and still match the row.
  if (sameUuid(payload.user_id, actor.id)) throw httpError(403, "FORBIDDEN", "You can't change your own role");
  await requireProfile(admin, payload.user_id);
  const { data: existing } = await admin
    .from("tournament_members")
    .select("*")
    .eq("tournament_id", tournament.id)
    .eq("user_id", payload.user_id)
    .maybeSingle();
  if (existing?.role === "organizer" || sameUuid(payload.user_id, tournament.owner_id)) {
    throw httpError(403, "FORBIDDEN", "The tournament organizer's role can't be changed");
  }
  const row = {
    id: existing?.id || uuid(),
    tournament_id: tournament.id,
    user_id: payload.user_id,
    role: payload.role,
    created_at: existing?.created_at || nowIso(),
  };
  const batch = createBatch();
  batch.upsert("tournament_members", row);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: tournament.id,
    result: { member: row },
  });
}

async function handleGenerateBracket(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  if (division.format === "team_elimination") {
    throw httpError(400, "INVALID_COMMAND", "Team elimination divisions use generate_team_elimination");
  }
  const { data: existingMatches } = await admin.from("matches").select("id").eq("division_id", division.id).limit(1);
  if (existingMatches?.length) throw httpError(409, "BRACKET_EXISTS", "Division already has matches");
  const { data: participants, error } = await admin
    .from("participants")
    .select("*")
    .eq("division_id", division.id)
    .order("seed", { ascending: true, nullsFirst: false });
  if (error) throw error;
  const regs = (participants || []).map((p) => ({ id: p.id, seed: p.seed }));
  if (regs.length < 2) throw httpError(400, "INVALID_COMMAND", "Need at least 2 participants");
  const stage = {
    id: uuid(),
    division_id: division.id,
    kind: "bracket",
    name: "Main draw",
    config: {},
    created_at: nowIso(),
  };
  const shells = generateBracket(regs, {
    makeId: uuid,
    bronzeMatch: Boolean(division.config?.bronzeMatch),
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
      updated_at: ts,
    };
    persistMatch(batch, match);
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: match.id,
      slot: "A",
      participant_id: shell.registrationAId || null,
      team_id: null,
    });
    batch.upsert("match_participants", {
      id: uuid(),
      match_id: match.id,
      slot: "B",
      participant_id: shell.registrationBId || null,
      team_id: null,
    });
  }
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { stage, match_count: shells.length },
  });
}

async function handleGenerateTeamElimination(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  if (division.format !== "team_elimination") {
    throw httpError(400, "INVALID_COMMAND", "Division is not team elimination");
  }
  const { data: existingMatches } = await admin.from("matches").select("id").eq("division_id", division.id).limit(1);
  if (existingMatches?.length) throw httpError(409, "BRACKET_EXISTS", "Division already has matches");
  const { data: teams } = await admin.from("teams").select("*").eq("division_id", division.id);
  const { data: participants } = await admin.from("participants").select("*").eq("division_id", division.id);
  const grouped = groupRegistrationsByTeam(
    (participants || []).map((p) => ({ ...p, teamId: p.team_id })),
    (teams || []).map((t) => ({ id: t.id, name: t.name, bracketGroup: t.bracket_group })),
  );
  if (!grouped.ok) throw httpError(400, "TE_INVALID", grouped.error);
  const { teamMatchups, pairMatches } = generateTeamRoundRobinMatchups(grouped.teams, { makeId: uuid });
  const stage = {
    id: uuid(),
    division_id: division.id,
    kind: "team_round_robin",
    name: "Team round robin",
    config: {},
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("stages", stage);
  persistTeamBracket(batch, division, stage, teamMatchups, pairMatches, grouped, nowIso());
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { stage, team_matchups: teamMatchups.length, pair_matches: pairMatches.length },
  });
}

async function handleGenerateTeamPlayoffs(admin, actor, payload, envelope) {
  const division = await getDivision(admin, payload.division_id);
  const member = await loadMember(admin, division.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
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
    (teams || []).map((t) => ({ id: t.id, name: t.name, bracketGroup: t.bracket_group })),
  );
  if (!grouped.ok) throw httpError(400, "TE_INVALID", grouped.error);

  const { data: allMatches } = await admin.from("matches").select("*").eq("division_id", division.id);
  const parents = (allMatches || []).filter((m) => !m.parent_match_id);
  if (!parents.length) throw httpError(409, "RR_INCOMPLETE", "Generate qualification matches first");
  const { data: allSides } = await admin
    .from("match_participants")
    .select("*")
    .in("match_id", (allMatches || []).map((m) => m.id));
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
      winnerTeamId: winnerSlot ? s.find((x) => x.slot === winnerSlot)?.team_id : null,
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
      score: { scoreA: m.score_state?.scoreA ?? 0, scoreB: m.score_state?.scoreB ?? 0 },
    };
  });
  const ranked = rankIndividualPairsForSemifinals(grouped.teams, rrMatchups, pairRows);
  // Team elimination always qualifies PER TEAM: qualifierCount is the number of
  // pairs taken from EACH team. A row still carrying a retired mode (top_x
  // meant a TOTAL count) is never reinterpreted automatically — the organizer
  // must re-save the division as "qualifiers per team" first. This also keeps
  // the Operator's automatic generation from firing on such rows.
  const mode = TEAM_QUALIFIER_MODE;
  const storedMode = division.config?.qualifierMode;
  if (storedMode !== TEAM_QUALIFIER_MODE) {
    throw httpError(
      409,
      "QUALIFICATION_NOT_CONFIGURED",
      `This division uses a retired qualification setting (${storedMode ?? "none"}). Open Divisions, set Qualifiers per team, and save before generating playoffs.`,
    );
  }
  const count = division.config?.qualifierCount;
  if (!isValidQualifierCount(count)) {
    throw httpError(
      409,
      "INVALID_QUALIFIER_COUNT",
      `Qualifiers per team must be a whole number of 1 or more (stored: ${JSON.stringify(count) ?? "none"}). Open Divisions and save a valid value.`,
    );
  }
  const pairsPerTeam = Math.min(...grouped.teams.map((t) => t.pairs.length));
  if (count > pairsPerTeam) {
    throw httpError(
      400,
      "INVALID_QUALIFIER_COUNT",
      `Qualifiers per team (${count}) cannot exceed the number of pairs per team (${pairsPerTeam}).`,
    );
  }
  const progressionMode = division.config?.progressionMode || "playoffs";
  const expected = expectedQualifierCount(mode, count, grouped.teams.length);
  if (progressionMode === "direct_semifinals" && expected !== 4) {
    const math = `Top ${count} per team × ${grouped.teams.length} teams = ${expected}`;
    const fix = 4 % grouped.teams.length === 0
      ? ` Set qualifiers per team to ${4 / grouped.teams.length}.`
      : " Use Playoffs / Elimination for this number of teams.";
    throw httpError(
      400,
      "DIRECT_SEMIS_INVALID_COUNT",
      `Direct Semifinals requires exactly 4 qualifying pairs; ${math}.${fix}`,
    );
  }
  const qualifiers = selectQualifiers(ranked, mode, count);
  if (new Set(qualifiers.map((q) => q.registrationId)).size !== qualifiers.length) {
    throw httpError(500, "QUALIFIER_DUPLICATE", "Qualifier list contains a duplicate pair");
  }
  if (progressionMode === "direct_semifinals" && qualifiers.length !== 4) {
    throw httpError(
      400,
      "DIRECT_SEMIS_INVALID_COUNT",
      `Direct Semifinals requires exactly 4 qualifying pairs (got ${qualifiers.length}). A team may have fewer pairs than the qualifier count.`,
    );
  }
  if (qualifiers.length < 2) throw httpError(400, "TE_INVALID", "Not enough qualifiers for playoffs");
  const unresolvedTies = findCutoffTies(ranked, qualifiers, mode);

  const startRound = Math.max(0, ...parents.map((m) => m.round || 0)) + 1;
  const { teamMatchups, pairMatches } = generateQualifierBracketShell(qualifiers, {
    makeId: uuid,
    startRound,
    sameTeamPolicy: division.config?.sameTeamPolicy || "avoid_semis",
  });
  const stage = {
    id: uuid(),
    division_id: division.id,
    kind: "team_knockout",
    name: "Team playoffs",
    config: { qualifierMode: mode, qualifierCount: count, progressionMode },
    created_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("stages", stage);
  persistTeamBracket(batch, division, stage, teamMatchups, pairMatches, grouped, nowIso());
  try {
    return await commit(admin, batch, {
      ...envelope,
      actorId: actor.id,
      tournamentId: division.tournament_id,
      result: {
        stage,
        team_matchups: teamMatchups.length,
        pair_matches: pairMatches.length,
        qualifiers: qualifiers.map((q) => q.registrationId),
        unresolved_ties: unresolvedTies,
      },
    });
  } catch (err) {
    // A concurrent request created the knockout stage between our check above
    // and this write. The one-knockout-stage-per-division unique index
    // (migration 0017) rejected this whole batch atomically — no stage, no
    // matches were written — so report it like the sequential case.
    if (err?.constraint === KNOCKOUT_STAGE_UNIQUE_INDEX) {
      throw httpError(409, "PLAYOFFS_EXIST", "Knockout stage already generated");
    }
    throw err;
  }
}

async function handleAssignCourt(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
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
    assigned_at: nowIso(),
  });
  if (match.status === "scheduled") {
    assertTransitionMatch(match.status, "ready");
    batch.expectMatch(match);
    persistMatch(batch, { ...match, status: "ready" });
  }
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match_id: match.id, court_id: court.id, status: match.status === "scheduled" ? "ready" : match.status },
  });
}

async function handleAssignUmpire(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
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
    assigned_at: nowIso(),
  });
  let status = match.status;
  if (match.status === "ready" || match.status === "scheduled") {
    assertTransitionMatch(match.status, "assigned");
    status = "assigned";
    batch.expectMatch(match);
    persistMatch(batch, { ...match, status });
  }
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match_id: match.id, umpire_id: payload.user_id, status },
  });
}

async function handleTransitionMatch(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  const isOrganizer = Boolean(member) && ["organizer", "admin"].includes(member.role);
  if (isOrganizer) {
    await requireLicense(admin, actor);
  } else {
    // The one self-service transition a non-organizer may make is putting
    // their own currently-live match on hold (Umpire Cancel/Hold) — anything
    // else falls through to the exact original organizer-only error. Never
    // license-gated: an umpire's own login doesn't consume an Operator seat.
    if (payload.status !== "postponed" || match.status !== "in_progress") {
      requireOrganizer(member);
    }
    const ump = await matchUmpire(admin, match.id);
    requireScoreAccess(member, ump?.user_id, actor.id);
  }
  // Starting and completing a match have their own commands, which set up the
  // score, record the winner/result and advance the bracket. A bare status
  // change would skip all of that.
  if (payload.status === "completed" || payload.status === "in_progress") {
    throw httpError(409, "ILLEGAL_TRANSITION", `Use ${payload.status === "completed" ? "complete_match" : "start_match"} to move a match to ${payload.status}`);
  }
  try {
    assertTransitionMatch(match.status, payload.status);
  } catch (err) {
    throw httpError(409, err.code || "ILLEGAL_TRANSITION", err.message);
  }
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  const next = { ...match, status: payload.status };
  // Leaving play (Hold / abandon) pauses the game timer: the time left is
  // banked so start_match resumes from it. No timer → the row is untouched.
  if (match.status === "in_progress" && normalizeTimer(match.timer)) {
    next.timer = pauseTimer(match.timer, nowIso());
  }
  const batch = createBatch();
  batch.expectMatch(match);
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: next },
    detail: reason ? { ok: true, transition: { match_id: match.id, from: match.status, to: payload.status, reason } } : undefined,
  });
}

async function handleStartMatch(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  const { member } = await authorizeMatchOperation(admin, actor, match);
  // Organizers have always been able to start any match directly (the same
  // command umpires use) — that is normal, pre-existing behavior and must
  // stay reason-free. "Override Start" is a distinct, explicit action the
  // Operator UI opts into via payload.override; only then is a reason
  // required and recorded as a separate audit event, never inferred from
  // role/assignment alone (which would incorrectly flag ordinary organizer
  // usage as an override).
  const isOverride = payload.override === true;
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  if (isOverride) {
    if (!member || !["organizer", "admin"].includes(member.role)) {
      throw httpError(403, "FORBIDDEN", "Only an organizer can override-start a match");
    }
    if (!reason) throw httpError(400, "REASON_REQUIRED", "A reason is required to override-start a match");
  }
  try {
    assertTransitionMatch(match.status, "in_progress");
  } catch (err) {
    throw httpError(409, err.code || "ILLEGAL_TRANSITION", err.message);
  }
  const division = await getDivision(admin, match.division_id);
  await assertMatchPlayable(admin, match, division);
  // payload.scoring_override (sent by older Operator/Umpire builds) is
  // accepted but ignored: the target is always derived from the stage.
  const settings = await matchScoringSettings(admin, division, match);
  const score_state = scoreStateForMatchStart(match, settings);
  const started_at = nowIso();
  const next = { ...match, status: "in_progress", started_at, score_state };
  // The game timer starts here — the one real transition into in_progress —
  // and nowhere else. A match timer (possibly paused by a Hold) wins over the
  // division default. No timer, or a database without the column (migration
  // 0019 not applied): the match is started exactly as before.
  // The division default is only for the match's FIRST start (no started_at
  // yet): a restart after Hold never gains a fresh timer mid-match.
  if (Object.hasOwn(match, "timer")) {
    const timer = normalizeTimer(match.timer)
      || (!match.started_at ? timerFromDivisionConfig(division.config, { now: started_at, by: actor.id }) : null);
    if (timer) next.timer = startTimer(timer, started_at);
  }
  const batch = createBatch();
  batch.expectMatch(match);
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: next },
    detail: isOverride ? { ok: true, override_start: { match_id: match.id, reason } } : undefined,
  });
}

function coinTossResult(match, extra = {}) {
  const coin_toss = readCoinToss(match);
  return {
    match,
    match_id: match.id,
    coin_toss,
    score_state: match.score_state,
    ...extra,
  };
}

async function handleCoinToss(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  if (!["assigned", "in_progress", "ready"].includes(match.status)) {
    throw httpError(409, "ILLEGAL_TRANSITION", `Cannot coin toss from ${match.status}`);
  }
  await assertMatchPlayable(admin, match, await getDivision(admin, match.division_id));
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
      serving_team: match.serving_team || already.servingTeam,
    };
    return commit(admin, createBatch(), {
      ...envelope,
      ...actorCommit(actor),
      tournamentId: match.tournament_id,
      matchId: match.id,
      result: coinTossResult(kept, { duplicate: true }),
    });
  }
  const toss = normalizeCoinTossPayload({
    result: payload.result,
    winner: payload.winner,
    servingTeam: payload.serving_team,
    courtSide: payload.court_side,
  }, match.serving_team);
  if (!payload.result && !payload.winner && !payload.serving_team) {
    throw httpError(400, "INVALID_COMMAND", "coin toss result is required");
  }
  const seq = payload.seq ?? 1;
  if (!Number.isSafeInteger(seq) || seq < 1) throw httpError(400, "INVALID_COMMAND", "seq must be a positive integer");
  const event = {
    id: payload.event_id,
    seq,
    type: "coin_toss",
    payload: toss,
  };
  // Same mapping as score_event: a sequence conflict is a 409 the client can
  // resolve, not a 500 it would retry forever.
  let state;
  let applied;
  try {
    state = reduceScoreEvents(await matchScoringSettings(admin, division, match), events || []);
    applied = applyScoreEvent(state, event);
  } catch (err) {
    if (err?.status) throw err;
    throw httpError(409, err.code || "OUT_OF_ORDER", err.message);
  }
  state = applied.state;
  if (!applied.applied) {
    const kept = { ...match, coin_toss: already || toss, serving_team: match.serving_team || toss.servingTeam, score_state: state };
    return commit(admin, createBatch(), {
      ...envelope,
      ...actorCommit(actor),
      tournamentId: match.tournament_id,
      matchId: match.id,
      result: coinTossResult(kept, { duplicate: true }),
    });
  }
  const next = {
    ...match,
    coin_toss: toss,
    serving_team: toss.servingTeam,
    score_state: state,
  };
  const batch = createBatch();
  batch.upsert("score_events", {
    id: event.id,
    match_id: match.id,
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    ...scoreActor(actor),
    created_at: nowIso(),
  });
  batch.expectMatch(match);
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: coinTossResult(next),
  }).catch((err) => rethrowSeqConflict(admin, err, match.id, event.seq));
}

// Another event already holds this (match_id, seq) — e.g. two devices scored
// the same point concurrently. Nothing from this request was written. Report
// it exactly like a stale seq (the engine's OUT_OF_ORDER, with the server's
// current lastSeq) so existing clients handle it the same way.
async function rethrowSeqConflict(admin, err, matchId, seq) {
  if (err?.code !== "SEQ_CONFLICT") throw err;
  const { data } = await admin.from("matches").select("score_state").eq("id", matchId).maybeSingle();
  const lastSeq = Number(data?.score_state?.lastSeq);
  const shown = Number.isFinite(lastSeq) ? lastSeq : seq;
  throw httpError(409, "OUT_OF_ORDER", `Events must be applied in seq order (lastSeq=${shown}, got ${seq})`);
}

async function handleScoreEvent(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  const { member: scoringMember } = await authorizeMatchOperation(admin, actor, match);
  try {
    assertAllowedScoreEventType(payload.type, actor);
  } catch (err) {
    throw httpError(err.status || 403, err.code || "FORBIDDEN", err.message);
  }
  const isCorrection = payload.type === "correction";
  const wasCompleted = match.status === "completed";
  const division = await getDivision(admin, match.division_id);
  await assertMatchPlayable(admin, match, division);
  const settings = await matchScoringSettings(admin, division, match);
  // Event-specific fields (scoreA/scoreB, and for a correction: reason /
  // confirm_completed) live in the nested event payload, same place as every
  // other score_event type's fields (e.g. payload.payload.team for "point").
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
  if (!Number.isSafeInteger(payload.seq) || payload.seq < 1) throw httpError(400, "INVALID_COMMAND", "seq must be a positive integer");
  const { data: dup } = await admin.from("score_events").select("id").eq("id", payload.event_id).maybeSingle();
  const cached = match.score_state && typeof match.score_state.lastSeq === "number" ? match.score_state : null;
  // A cached state built under different rules (e.g. before stage-based
  // targets) is never fast-forwarded; it is re-reduced with this match's rules.
  const canFastForward = Boolean(cached) && payload.seq === cached.lastSeq + 1
    && cached.winTo === settings.winTo && cached.winBy === settings.winBy;

  async function reducedState() {
    const { data: events } = await admin.from("score_events").select("*").eq("match_id", match.id).order("seq");
    return reduceScoreEvents(settings, events || []);
  }

  if (dup) {
    const known = cached && (cached.appliedEventIds || []).includes(payload.event_id);
    const state = known ? cached : await reducedState();
    return { match: { ...match, score_state: state }, duplicate: true };
  }
  const event = {
    id: payload.event_id,
    seq: payload.seq,
    type: payload.type,
    payload: eventPayload,
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
    if (applied.code === "INVALID_SCORE") throw httpError(400, "INVALID_SCORE", applied.reason);
    throw httpError(400, "INVALID_COMMAND", "That score event could not be applied");
  }
  const state = applied.state;

  // A completed match may only be corrected in a way that preserves the
  // existing winner — anything else would require reversing bracket
  // advancement/standings that already happened, which is out of scope.
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
    created_at: nowIso(),
  });

  let progressed = null;
  let completed = null;
  let detail;
  if (isCorrection) {
    const actorRole = scoringMember && ["organizer", "admin"].includes(scoringMember.role) ? "operator" : (scoringMember?.role || actor.kind);
    detail = {
      ok: true,
      correction: {
        match_id: match.id,
        game: state.gameNumber,
        previous: { scoreA: base.scoreA ?? null, scoreB: base.scoreB ?? null },
        next: { scoreA: state.scoreA, scoreB: state.scoreB },
        reason: eventPayload.reason || null,
        actor_role: actorRole,
      },
    };
  }

  if (wasCompleted) {
    // Already-completed, same-winner correction (validated above): update the
    // persisted score line only. finishMatchIfWon is NOT re-run — it asserts
    // a genuine status transition into "completed" and would either throw or
    // redundantly re-advance the bracket for a match that already advanced it.
    batch.expectMatch(match);
    persistMatch(batch, { ...match, score_state: state });
    const { data: existingResult } = await admin.from("match_results").select("*").eq("match_id", match.id).maybeSingle();
    if (existingResult) {
      batch.upsert("match_results", { ...existingResult, games: state.games || [], score_a: state.scoreA, score_b: state.scoreB });
    }
  } else {
    batch.expectMatch(match);
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
    detail,
  }).catch((err) => rethrowSeqConflict(admin, err, match.id, payload.seq));
  if (!wasCompleted && state.status === "completed") {
    await reconcilePlayoffChildren(admin, match.division_id, division.format);
  }
  return result;
}

async function handleCompleteMatch(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  const division = await getDivision(admin, match.division_id);
  if (match.status === "completed") {
    await reconcilePlayoffChildren(admin, match.division_id, division.format);
    return { match, already_complete: true };
  }
  await assertMatchPlayable(admin, match, division);
  const { data: events } = await admin.from("score_events").select("*").eq("match_id", match.id).order("seq");
  const state = reduceScoreEvents(await matchScoringSettings(admin, division, match), events || []);
  if (state.status !== "completed") {
    throw httpError(409, "MATCH_NOT_WON", "Scoring has not produced a winner");
  }
  const batch = createBatch();
  batch.expectMatch(match);
  const fin = await finishMatchIfWon(admin, batch, match, state, actor.kind === "station" ? actor.deviceId : actor.id);
  const result = await commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: fin.match, progressed: fin.progressed },
  });
  await reconcilePlayoffChildren(admin, match.division_id, division.format);
  return result;
}

// Game timer control. Enforced here, never in the client:
//   - organizer/admin (licensed): every action below (Operator/SA override);
//   - the umpire assigned to THIS match: only set/clear before the match has
//     ever started (game-time setup). Anything once started → FORBIDDEN;
//   - anyone else (other umpires, members, strangers) → FORBIDDEN; court
//     stations never reach this (not in STATION_COMMANDS).
// Only matches.timer changes: status, score, winner and progression are never
// touched, and the countdown itself only starts in handleStartMatch.
//   set    { duration_seconds }  before the match has ever started: configure.
//                                Once started, only if the match has NO timer
//                                (Operator taking over): a live match counts
//                                from now; a held/resumed one stays paused
//                                until start_match.
//   clear                        before the match has ever started: remove
//   adjust { delta_seconds }     once started (live, held, or resumed): add/remove time
//   reset                        once started (live, held, or resumed): back to the full duration
// "Ever started" is matches.started_at (set by the first start_match and kept
// through Hold → Resume), so a resumed match in `ready` keeps its banked time.
const TIMER_SETUP_STATUSES = new Set(["scheduled", "ready", "assigned", "postponed"]);

async function handleSetMatchTimer(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const match = await getMatch(admin, payload.match_id);
  const member = await loadMember(admin, match.tournament_id, actor.id);
  const isOrganizer = Boolean(member) && ["organizer", "admin"].includes(member.role);
  if (isOrganizer) {
    await requireOrganizerLicensed(admin, actor, member);
  } else {
    // Only this match's assigned umpire; like their own Hold, not license-gated.
    const ump = await matchUmpire(admin, match.id);
    requireScoreAccess(member, ump?.user_id, actor.id);
  }
  if (!Object.hasOwn(match, "timer")) {
    throw httpError(409, "TIMER_UNAVAILABLE", "Game timer is not available on this server yet");
  }
  const action = payload.action;
  const now = nowIso();
  const meta = { now, by: actor.id };
  const current = normalizeTimer(match.timer);
  let timer;
  const started = match.status === "in_progress" || (TIMER_SETUP_STATUSES.has(match.status) && Boolean(match.started_at));
  if (!isOrganizer && (started || (action !== "set" && action !== "clear"))) {
    throw httpError(403, "FORBIDDEN", "Once the match has started, only the organizer can change the game timer");
  }
  if (action === "set" || action === "clear") {
    // A started match may only be given a timer it doesn't have yet; one that
    // already has a timer is adjusted or reset, never replaced or removed.
    if (started && (action === "clear" || current)) {
      throw httpError(409, "MATCH_ALREADY_STARTED", "The game has already started. Add or remove time, or reset the timer instead.");
    }
    if (!started && !TIMER_SETUP_STATUSES.has(match.status)) {
      throw httpError(409, "MATCH_NOT_ACTIVE", `Cannot change the game time of a ${match.status} match`);
    }
    if (action === "set") {
      if (!isValidGameTimeSec(payload.duration_seconds)) {
        throw httpError(400, "INVALID_GAME_TIME", `Game time must be a whole number of seconds from ${MIN_GAME_TIME_SEC} to ${MAX_GAME_TIME_SEC}`);
      }
      timer = configureTimer(payload.duration_seconds, meta);
      if (match.status === "in_progress") timer = startTimer(timer, now);
    } else {
      timer = null;
    }
  } else if (action === "adjust" || action === "reset") {
    if (!started) {
      throw httpError(409, "MATCH_NOT_ACTIVE", match.status === "completed"
        ? "This game is already completed"
        : TIMER_SETUP_STATUSES.has(match.status)
          ? "The game has not started yet. Set the game time instead."
          : `Cannot change the timer of a ${match.status} match`);
    }
    if (!current) throw httpError(409, "NO_TIMER", "This match has no game timer");
    if (action === "adjust") {
      if (!isValidTimerAdjustSec(payload.delta_seconds)) {
        throw httpError(400, "INVALID_COMMAND", `delta_seconds must be a non-zero whole number up to ±${MAX_ADJUST_SEC}`);
      }
      timer = adjustTimer(current, payload.delta_seconds, meta);
    } else {
      timer = resetTimer(current, meta);
    }
  } else {
    throw httpError(400, "INVALID_COMMAND", "action must be set, clear, adjust or reset");
  }
  const next = { ...match, timer };
  const batch = createBatch();
  batch.expectMatch(match);
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: next },
  });
}

async function handleOpenCourtPairing(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const { data: court } = await admin.from("courts").select("*").eq("id", payload.court_id).maybeSingle();
  if (!court) throw httpError(404, "NOT_FOUND", "Court not found");
  const member = await loadMember(admin, court.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const { data: openGrants } = await admin
    .from("court_pairing_grants")
    .select("*")
    .eq("court_id", court.id)
    .is("consumed_at", null);
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
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    consumed_at: null,
    created_by: actor.id,
    created_at: now,
  };
  batch.upsert("court_pairing_grants", grant);
  const persisted = {
    grant_id: grant.id,
    court_id: court.id,
    station_public_id: court.station_public_id,
    expires_at: grant.expires_at,
  };
  await commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: court.tournament_id,
    result: persisted,
  });
  return {
    ...persisted,
    pairing_token: pairingToken,
    pairing_payload: { v: 1, sid: court.station_public_id, g: pairingToken },
  };
}

async function handleRevokeCourtDevice(admin, actor, payload, envelope) {
  requireUserActor(actor);
  const { data: court } = await admin.from("courts").select("*").eq("id", payload.court_id).maybeSingle();
  if (!court) throw httpError(404, "NOT_FOUND", "Court not found");
  const member = await loadMember(admin, court.tournament_id, actor.id);
  await requireOrganizerLicensed(admin, actor, member);
  const { data: device } = await admin
    .from("court_devices")
    .select("*")
    .eq("court_id", court.id)
    .eq("status", "active")
    .maybeSingle();
  if (!device) throw httpError(404, "NOT_FOUND", "No active device on this court");
  const batch = createBatch();
  batch.upsert("court_devices", {
    ...device,
    status: "revoked",
    revoked_at: nowIso(),
  });
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: court.tournament_id,
    result: { court_id: court.id, device_id: device.id, status: "revoked" },
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
  const { data: sides } = matchIds.length
    ? await admin.from("match_participants").select("*").in("match_id", matchIds)
    : { data: [] };
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
    done,
  };
}

const HANDLERS = {
  create_tournament: handleCreateTournament,
  update_tournament: handleUpdateTournament,
  transition_tournament: handleTransitionTournament,
  create_division: handleCreateDivision,
  update_division: handleUpdateDivision,
  delete_division: handleDeleteDivision,
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
  complete_match: handleCompleteMatch,
  set_match_timer: handleSetMatchTimer,
};

// Deterministic JSON (object keys sorted, recursively) so the same request
// always produces the same fingerprint regardless of key order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export async function requestHash(type, payload) {
  return sha256Hex(canonicalJson({ type, payload }));
}

// A stored receipt answers this request only if it is the SAME request from
// the SAME actor. Receipts written before migration 0018 have no hash; for
// those the command type must still match.
function receiptMatches(receipt, actor, type, hash) {
  const sameActor = actor.kind === "station"
    ? receipt.actor_device_id === actor.deviceId
    : receipt.actor_id === actor.id;
  if (!sameActor) return false;
  if (receipt.request_hash) return receipt.request_hash === hash;
  return receipt.command_type === type;
}

function replay(receipt, actor, envelope, hash) {
  if (!receiptMatches(receipt, actor, envelope.type, hash)) {
    throw Object.assign(
      httpError(409, "IDEMPOTENCY_KEY_REUSED", "This command id was already used for a different request."),
      { commandId: envelope.command_id },
    );
  }
  // The pairing QR token is returned once and never stored, so a replay
  // can't show it again. Ask for a fresh pairing window instead of returning
  // a result with no QR code.
  if (envelope.type === "open_court_pairing") {
    throw httpError(409, "PAIRING_REPLAY", "This pairing window was already opened. Open a new pairing window to show the QR code.");
  }
  return { ok: true, idempotent: true, result: receipt.result };
}

// A handler's read-then-write raced another command on the same match
// (STALE_WRITE: nothing was written). Re-running it re-reads current state.
const STALE_WRITE_ATTEMPTS = 3;

// Commands whose every write is covered by the match version check, so a
// client "I last saw this match version" precondition is fully enforced.
// Anything else (e.g. assign_court: its court_assignments row has no version
// check) refuses a precondition rather than silently ignoring it.
export const PRECONDITION_COMMANDS = Object.freeze(["transition_match", "start_match", "coin_toss", "score_event", "complete_match"]);

function validatePrecondition(type, payload) {
  const pre = payload?.precondition;
  if (pre === undefined) return undefined;
  const bad = (message) => httpError(400, "INVALID_COMMAND", message);
  if (!PRECONDITION_COMMANDS.includes(type)) throw bad(`precondition is not supported for ${type}`);
  if (!pre || typeof pre !== "object" || Array.isArray(pre)) throw bad("precondition must be an object");
  const keys = Object.keys(pre);
  if (keys.length !== 1 || keys[0] !== "match_updated_at") throw bad("precondition supports only match_updated_at");
  if (typeof pre.match_updated_at !== "string" || Number.isNaN(Date.parse(pre.match_updated_at))) {
    throw bad("precondition.match_updated_at must be a timestamp");
  }
  if (!isUuid(payload.match_id)) throw bad("precondition requires match_id");
  return pre;
}

export async function handleCommand({ admin, actor, body }) {
  if (!actor?.id) throw httpError(401, "UNAUTHENTICATED", "Missing actor");
  const envelope = parseCommandEnvelope(body);
  try {
    assertStationMayIssue(actor, envelope.type, envelope.payload);
  } catch (err) {
    throw httpError(err.status || 403, err.code || "FORBIDDEN", err.message);
  }
  const precondition = validatePrecondition(envelope.type, envelope.payload);
  const hash = await requestHash(envelope.type, envelope.payload);
  // Fast path for a sequential retry. Concurrent duplicates are resolved
  // atomically by the database (the receipt claim in apply_official_writes).
  const prior = await existingReceipt(admin, envelope.command_id);
  if (prior) return replay(prior, actor, envelope, hash);
  const handler = HANDLERS[envelope.type];
  const context = { ...envelope, request_hash: hash, precondition };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await handler(admin, actor, envelope.payload, context);
      return { ok: true, idempotent: false, result };
    } catch (err) {
      if (err?.code === "COMMAND_ALREADY_APPLIED") {
        // Another request with this command_id committed first; this one
        // wrote nothing. Answer with that request's stored result.
        const winner = await existingReceipt(admin, envelope.command_id);
        if (winner) return replay(winner, actor, envelope, hash);
        throw httpError(503, "RETRY_LATER", "The server is busy. Please retry.");
      }
      if (err?.code === "STALE_WRITE") {
        if (attempt < STALE_WRITE_ATTEMPTS) continue;
        throw httpError(503, "RETRY_LATER", "The server is busy. Please retry.");
      }
      throw err;
    }
  }
}

// The command API's error response. Errors raised deliberately by the API
// (httpError: they carry a status) keep their code and message. Anything
// else (a raw database/runtime error) is reported generically: no SQL text,
// constraint names, tokens or stack traces ever reach the client.
export function errorResponse(err, commandId) {
  const known = Number.isFinite(Number(err?.status)) && Number(err.status) > 0;
  const status = known ? Number(err.status) : 500;
  const error = known
    ? { code: err.code || "INTERNAL", message: err.message }
    : { code: "INTERNAL", message: "Something went wrong on the server. Please retry." };
  if (status === 409 && commandId) error.command_id = commandId;
  if (err?.code === "STALE_STATE" && err.current) error.current_revision = err.current;
  return { status, body: { ok: false, error } };
}
