import {
  assertTransitionTournament,
  assertTransitionMatch,
  generateBracket,
  advanceBracket,
  advanceBronzeMatchSlot,
  scoreStateForMatchStart,
  applyScoreEvent,
  reduceScoreEvents,
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
  generateQualifierBracketShell,
  assignedPersonIds,
  validatePersonIdsForAssignment,
} from "@tournament/engine";
import { parseCommandEnvelope, isUuid } from "@tournament/contracts";
import { applyBatch, createBatch, httpError, nowIso, uuid } from "./writes.js";
import {
  loadMember,
  requireOrganizer,
  requireProfile,
  requireScoreAccess,
  requireStationScoreAccess,
  assertStationMayIssue,
  assertAllowedScoreEventType,
} from "./authz.js";
export { STATION_COMMANDS, STATION_SCORE_EVENT_TYPES, STATION_FORBIDDEN_COMMANDS, assertStationMayIssue } from "./authz.js";
import { randomToken, sha256Hex } from "./stationAuth.js";
export { resolveActor } from "./stationAuth.js";

function scoringSettings(config = {}) {
  return {
    winTo: config.winTo ?? 11,
    winBy: config.winBy ?? "two",
    bestOf: config.bestOf ?? 1,
    isDoubles: config.isDoubles !== false,
    timeoutsAllowed: config.timeoutsAllowed ?? 2,
  };
}

async function commit(admin, batch, { command_id, type, actorId, actorDeviceId, tournamentId, matchId, result }) {
  batch.upsert("command_receipts", {
    id: command_id,
    actor_id: actorDeviceId ? null : actorId,
    actor_device_id: actorDeviceId || null,
    command_type: type,
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
    detail: { ok: true },
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

async function reconcilePlayoffChildren(admin, divisionId) {
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
    if (finalized) {
      persistMatch(batch, {
        ...parent,
        status: "completed",
        winner: finalized.winnerTeamId === parentSides.find((s) => s.slot === "A")?.team_id ? "A" : "B",
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
  requireOrganizer(member);
  const next = {
    ...tournament,
    name: payload.name != null ? String(payload.name).trim() : tournament.name,
    settings: payload.settings != null ? payload.settings : tournament.settings,
    updated_at: nowIso(),
  };
  if (!next.name) throw httpError(400, "INVALID_COMMAND", "name is required");
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
    result: { tournament: next },
  });
}

async function handleCreateDivision(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  const name = String(payload.name || "").trim();
  if (!name) throw httpError(400, "INVALID_COMMAND", "name is required");
  const format = payload.format || "single_elim";
  const config = { ...(payload.config || { winTo: 11, bestOf: 1, winBy: "two", isDoubles: true }) };
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
  requireOrganizer(member);
  const next = {
    ...division,
    name: payload.name != null ? String(payload.name).trim() : division.name,
    format: payload.format || division.format,
    config: payload.config != null ? { ...division.config, ...payload.config } : division.config,
    updated_at: nowIso(),
  };
  const batch = createBatch();
  batch.upsert("divisions", next);
  return commit(admin, batch, {
    ...envelope,
    actorId: actor.id,
    tournamentId: division.tournament_id,
    result: { division: next },
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
  requireOrganizer(member);
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
    result: { team_member_id: row.id, removed: true },
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
    result: { participant_id: participant.id, removed: true },
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
  requireOrganizer(member);
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

async function handleAddMember(admin, actor, payload, envelope) {
  const tournament = await getTournament(admin, payload.tournament_id);
  const member = await loadMember(admin, tournament.id, actor.id);
  requireOrganizer(member);
  if (!["admin", "umpire", "viewer"].includes(payload.role)) {
    throw httpError(400, "INVALID_COMMAND", "role must be admin, umpire, or viewer");
  }
  if (payload.user_id === actor.id && payload.role !== "organizer") {
    // Organizer may not change their own role through this command.
  }
  if (!isUuid(payload.user_id)) throw httpError(400, "INVALID_COMMAND", "user_id must be a UUID");
  await requireProfile(admin, payload.user_id);
  const { data: existing } = await admin
    .from("tournament_members")
    .select("*")
    .eq("tournament_id", tournament.id)
    .eq("user_id", payload.user_id)
    .maybeSingle();
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
  requireOrganizer(member);
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
  requireOrganizer(member);
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
  const mode = division.config?.qualifierMode || "top_x";
  const count = Number(division.config?.qualifierCount || 4);
  const qualifiers = selectQualifiers(ranked, mode, count);
  if (qualifiers.length < 2) throw httpError(400, "TE_INVALID", "Not enough qualifiers for playoffs");

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
    config: { qualifierMode: mode, qualifierCount: count },
    created_at: nowIso(),
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
      qualifiers: qualifiers.map((q) => q.registrationId),
    },
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
    assigned_at: nowIso(),
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
    result: { match_id: match.id, court_id: court.id, status: match.status === "scheduled" ? "ready" : match.status },
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
    assigned_at: nowIso(),
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
    result: { match_id: match.id, umpire_id: payload.user_id, status },
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
    result: { match: { ...match, status: payload.status } },
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
    result: { match: next },
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
  }, match.serving_team);
  if (!payload.result && !payload.winner && !payload.serving_team) {
    throw httpError(400, "INVALID_COMMAND", "coin toss result is required");
  }
  const event = {
    id: payload.event_id,
    seq: payload.seq ?? 1,
    type: "coin_toss",
    payload: toss,
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
  persistMatch(batch, next);
  return commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: coinTossResult(next),
  });
}

async function handleScoreEvent(admin, actor, payload, envelope) {
  const match = await getMatch(admin, payload.match_id);
  await authorizeMatchOperation(admin, actor, match);
  if (match.status !== "in_progress") {
    throw httpError(409, "ILLEGAL_TRANSITION", "Match is not in progress");
  }
  if (!isUuid(payload.event_id)) throw httpError(400, "INVALID_COMMAND", "event_id must be a UUID");
  try {
    assertAllowedScoreEventType(payload.type);
  } catch (err) {
    throw httpError(err.status || 403, err.code || "FORBIDDEN", err.message);
  }
  if (typeof payload.seq !== "number") throw httpError(400, "INVALID_COMMAND", "seq is required");
  const { data: dup } = await admin.from("score_events").select("id").eq("id", payload.event_id).maybeSingle();
  const division = await getDivision(admin, match.division_id);
  const settings = scoringSettings(division.config);
  const cached = match.score_state && typeof match.score_state.lastSeq === "number" ? match.score_state : null;
  const canFastForward = Boolean(cached) && payload.seq === cached.lastSeq + 1;

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
    payload: payload.event_payload || payload.payload || {},
  };
  let applied;
  try {
    const base = canFastForward ? cached : await reducedState();
    applied = applyScoreEvent(base, event);
  } catch (err) {
    throw httpError(409, err.code || "OUT_OF_ORDER", err.message);
  }
  const state = applied.state;
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
  persistMatch(batch, { ...match, score_state: state });
  let progressed = null;
  let completed = null;
  if (state.status === "completed") {
    const fin = await finishMatchIfWon(admin, batch, { ...match, score_state: state }, state, actor.kind === "station" ? actor.deviceId : actor.id);
    completed = fin.match;
    progressed = fin.progressed;
  }
  const result = await commit(admin, batch, {
    ...envelope,
    ...actorCommit(actor),
    tournamentId: match.tournament_id,
    matchId: match.id,
    result: { match: completed || { ...match, score_state: state }, score_state: state, duplicate: false, progressed },
  });
  if (state.status === "completed") {
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
    result: { match: fin.match, progressed: fin.progressed },
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
  requireOrganizer(member);
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
  add_person: handleAddPerson,
  create_team: handleCreateTeam,
  add_team_member: handleAddTeamMember,
  remove_team_member: handleRemoveTeamMember,
  register_participant: handleRegisterParticipant,
  remove_participant: handleRemoveParticipant,
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
};

export async function handleCommand({ admin, actor, body }) {
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
