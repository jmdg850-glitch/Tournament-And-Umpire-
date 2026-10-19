import { rankIndividualPairsForSemifinals, buildTeamStandingsFromRoundRobin, buildOverallTeamStandings, matchScoringTarget } from "@tournament/engine";

export const TOURNAMENT_FLOW = [
  "draft",
  "registration",
  "registration_closed",
  "ready",
  "in_progress",
  "completed",
];

export const TOURNAMENT_STATUS_LABEL = {
  draft: "Draft",
  registration: "Registration",
  registration_closed: "Registration closed",
  ready: "Ready",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
  archived: "Archived",
};

export const MATCH_STATUS_LABEL = {
  scheduled: "Scheduled",
  ready: "Ready",
  assigned: "Assigned",
  in_progress: "Live",
  postponed: "Postponed",
  completed: "Completed",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
  bye: "Bye",
};

export const FORMAT_LABEL = {
  single_elim: "Single elimination",
  team_elimination: "Team elimination",
  round_robin: "Round robin",
};

export const DESK_TABS = [
  ["overview", "Overview"],
  ["matches", "Matches"],
  ["courts", "Courts"],
  ["players", "Players"],
  ["teams", "Teams"],
  ["divisions", "Divisions"],
  ["brackets", "Brackets"],
  ["umpires", "Umpires"],
  ["results", "Results"],
  ["settings", "Settings"],
];

export function labelStatus(status, map = MATCH_STATUS_LABEL) {
  return map[status] || String(status || "—").replaceAll("_", " ");
}

export function shortId(id) {
  return id ? `${id.slice(0, 8)}…` : "—";
}

export function isToday(iso) {
  if (!iso) return false;
  return iso.slice(0, 10) === new Date().toISOString().slice(0, 10);
}

export async function unwrap(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export function firstQueryError(results) {
  return results.find((r) => r?.error)?.error || null;
}

// The full tournament-desk dataset (divisions, persons, teams, participants,
// matches, and everything that hangs off them) — extracted from
// TournamentDesk.jsx's own `load()` so the read-only display windows
// (BracketWindow, MatchDisplayWindow) can reuse the exact same query shape
// instead of re-deriving it, since the shared board/match renderers
// (brackets.jsx, lib.js helpers like sideOf/courtFor/umpireFor) all expect
// this same `data` shape. Two phases: the tournament-scoped primary tables
// first (they carry their own tournament_id filter), then the dependent
// tables — which have no tournament_id column of their own — scoped by the
// resulting match/team/participant/division IDs via .in(). See the git
// history on TournamentDesk.jsx's load() for why unfiltered dependent-table
// queries are unsafe (PostgREST's default response cap silently truncated
// them once a project had enough tournaments).
// Reads every row of a query, a page at a time. The hosted API returns at
// most 1000 rows per request, so an unfiltered count ("players", "matches
// today") silently stopped at 1000. `makeQuery` must build a fresh, stably
// ordered query each call. Returns { data, error, status } like one query.
export async function selectAllPages(makeQuery, pageSize = 1000) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    const res = await makeQuery().range(from, from + pageSize - 1);
    if (res?.error) return { data: null, error: res.error, status: res.status ?? 0 };
    const page = res?.data || [];
    rows.push(...page);
    if (page.length < pageSize) return { data: rows, error: null, status: res?.status ?? 200 };
  }
}

export async function loadDeskData(supabase, tournamentId) {
  const primary = await Promise.all([
    supabase.from("tournaments").select("*").eq("id", tournamentId).maybeSingle(),
    supabase.from("divisions").select("*").eq("tournament_id", tournamentId),
    supabase.from("persons").select("*").eq("tournament_id", tournamentId).order("display_name"),
    supabase.from("teams").select("*").eq("tournament_id", tournamentId).order("name"),
    supabase.from("participants").select("*").eq("tournament_id", tournamentId),
    supabase.from("courts").select("*").eq("tournament_id", tournamentId).order("sort_order"),
    supabase.from("tournament_members").select("*").eq("tournament_id", tournamentId),
    supabase.from("matches").select("*").eq("tournament_id", tournamentId).order("round"),
    supabase.from("court_devices").select("*").eq("tournament_id", tournamentId),
    supabase.from("profiles").select("id, display_name"),
  ]);
  // `status` (0 = no answer from the server) lets callers tell "offline"
  // apart from a real server/permission error.
  const primaryFailed = primary.find((r) => r?.error);
  if (primaryFailed) return { data: null, error: primaryFailed.error, status: primaryFailed.status ?? 0 };
  const [t, divisions, persons, teams, participants, courts, members, matches, courtDevices, profiles] = primary;
  const matchIds = (matches.data || []).map((m) => m.id);
  const teamIds = (teams.data || []).map((x) => x.id);
  const participantIds = (participants.data || []).map((x) => x.id);
  const divisionIds = (divisions.data || []).map((x) => x.id);

  const empty = Promise.resolve({ data: [] });
  const dependent = await Promise.all([
    teamIds.length ? supabase.from("team_members").select("*").in("team_id", teamIds) : empty,
    matchIds.length ? supabase.from("match_results").select("*").in("match_id", matchIds) : empty,
    matchIds.length ? supabase.from("court_assignments").select("*").in("match_id", matchIds) : empty,
    matchIds.length ? supabase.from("umpire_assignments").select("*").in("match_id", matchIds) : empty,
    matchIds.length ? supabase.from("match_participants").select("*").in("match_id", matchIds) : empty,
    participantIds.length ? supabase.from("participant_members").select("*").in("participant_id", participantIds) : empty,
    divisionIds.length ? supabase.from("stages").select("*").in("division_id", divisionIds) : empty,
  ]);
  const dependentFailed = dependent.find((r) => r?.error);
  if (dependentFailed) return { data: null, error: dependentFailed.error, status: dependentFailed.status ?? 0 };
  const [teamMembers, results, courtsA, umpiresA, matchParticipants, participantMembers, stages] = dependent;

  return {
    error: null,
    data: {
      tournament: t.data,
      divisions: divisions.data || [],
      persons: persons.data || [],
      teams: teams.data || [],
      teamMembers: teamMembers.data || [],
      participants: participants.data || [],
      participantMembers: participantMembers.data || [],
      stages: stages.data || [],
      courts: courts.data || [],
      members: members.data || [],
      matches: matches.data || [],
      results: results.data || [],
      courtAssignments: courtsA.data || [],
      umpireAssignments: umpiresA.data || [],
      courtDevices: courtDevices.data || [],
      matchParticipants: matchParticipants.data || [],
      profiles: profiles.data || [],
    },
  };
}

export function isTeamMatchup(match) {
  if (!match || match.parent_match_id) return false;
  if (match.bracket_side === "pair") return false;
  return (
    match.bracket_side === "team_matchup" ||
    match.bracket_side === "round_robin" ||
    ["round_robin", "semifinal", "knockout", "final", "bronze"].includes(match.stage_label)
  );
}

export function playableMatches(matches) {
  return (matches || []).filter((m) => {
    if (m.parent_match_id) return true;
    if (isTeamMatchup(m)) return false;
    return true;
  });
}

export function sideOf(matchId, slot, data) {
  const side = (data.matchParticipants || []).find((p) => p.match_id === matchId && p.slot === slot);
  if (!side) return { name: `Side ${slot}`, team: null, participant: null };
  const participant = (data.participants || []).find((p) => p.id === side.participant_id) || null;
  const team = (data.teams || []).find((t) => t.id === side.team_id) || null;
  return {
    name: participant?.display_name || team?.name || `Side ${slot}`,
    team,
    participant,
  };
}

export function scoreLine(match, result) {
  // Won by default (declare_default_win): shown as a walkover, with the
  // administrative score when the organizer recorded one (e.g. "W/O 11–0").
  const dw = match?.score_state?.defaultWin;
  if (dw) return dw.score ? `W/O ${dw.score.a}–${dw.score.b}` : "W/O";
  const a = result?.score_a ?? match?.score_state?.scoreA;
  const b = result?.score_b ?? match?.score_state?.scoreB;
  if (a == null && b == null) return "—";
  return `${a ?? 0}–${b ?? 0}`;
}

// Win-by-default score boxes: both empty → undefined (no score); one empty →
// "invalid"; otherwise { a, b }.
export function parseOptionalScore(scoreA, scoreB) {
  const a = String(scoreA ?? "").trim();
  const b = String(scoreB ?? "").trim();
  if (!a && !b) return undefined;
  if (!a || !b) return "invalid";
  return { a: Number.parseInt(a, 10), b: Number.parseInt(b, 10) };
}

export function memberName(userId, profiles) {
  const p = (profiles || []).find((x) => x.id === userId);
  return p?.display_name || p?.email || shortId(userId);
}

export function resultFor(match, results) {
  return (results || []).find((r) => r.match_id === match.id);
}

export function courtFor(match, data) {
  const asg = (data.courtAssignments || []).find((c) => c.match_id === match.id);
  return (data.courts || []).find((c) => c.id === asg?.court_id) || null;
}

export function umpireFor(match, data) {
  const asg = (data.umpireAssignments || []).find((c) => c.match_id === match.id);
  if (!asg) return null;
  return { userId: asg.user_id, name: memberName(asg.user_id, data.profiles) };
}

export function stageTitle(label) {
  if (!label) return "Match";
  if (label === "round_robin") return "Qualification";
  if (label === "semifinal") return "Semifinals";
  if (label === "bronze") return "Bronze";
  if (label === "final") return "Final";
  if (label === "knockout") return "Playoffs";
  return String(label).replaceAll("_", " ");
}

// The stage a match belongs to, from the stored bracket model — never from
// display text. Team elimination stores the stage key on the matchup
// (matches.stage_label); its pair matches (the ones actually played) carry no
// label and inherit their matchup's stage. Single elimination stores no label,
// so the stage follows from the round: last round = Final (bronze match:
// Bronze), then Semifinals, Quarterfinals, otherwise "Round N".
export function matchStageTitle(match, matches = []) {
  if (!match) return "Match";
  if (match.parent_match_id) {
    const parent = matches.find((m) => m.id === match.parent_match_id);
    if (parent) return matchStageTitle(parent, matches);
  }
  const label = match.stage_label;
  if (label === "knockout") {
    const final = matches.find((m) => m.stage_id === match.stage_id && m.stage_label === "final" && !m.parent_match_id);
    const fromFinal = final && Number.isInteger(match.round) ? final.round - match.round : null;
    if (fromFinal === 2) return "Quarterfinals";
    if (fromFinal > 2) return `Round of ${2 ** (fromFinal + 1)}`;
    return stageTitle(label);
  }
  if (label) return stageTitle(label);
  if (match.bracket_side === "bronze") return "Bronze";
  if (!Number.isInteger(match.round)) return "Match";
  const bracket = matches.filter((m) => m.division_id === match.division_id && !m.parent_match_id && !m.stage_label && Number.isInteger(m.round));
  const maxRound = Math.max(match.round, ...bracket.map((m) => m.round));
  if (match.round === maxRound) return "Final";
  if (match.round === maxRound - 1) return "Semifinals";
  if (match.round === maxRound - 2) return "Quarterfinals";
  return `Round ${match.round}`;
}

// The race-to target for a match. Scoring targets are decided by stage (and
// the division's config.scoringTargets) and enforced server-side (packages/api
// matchScoringSettings → engine matchScoringTarget): once started, the
// persisted score_state.winTo is authoritative; before start, the same engine
// rule is applied to the loaded matches so the operator sees exactly what the
// server will use.
export function scoringTargetFor(match, matches = [], targets) {
  const started = Number(match?.score_state?.winTo);
  if (Number.isInteger(started) && started > 0) return started;
  return matchScoringTarget(match, matches, targets);
}

// The division-level per-stage targets for a match (undefined = defaults).
export function divisionTargetsFor(match, divisions = []) {
  return divisions.find((d) => d.id === match?.division_id)?.config?.scoringTargets;
}

// A stale-seq correction is rejected by the engine with
// "Events must be applied in seq order (lastSeq=N, got M)". Corrections set an
// absolute score, so they can safely be resent once at lastSeq + 1.
export function nextSeqAfterOutOfOrder(err) {
  const code = err?.code || err?.body?.error?.code;
  if (code !== "OUT_OF_ORDER") return null;
  const m = /lastSeq=(\d+)/.exec(err?.message || err?.body?.error?.message || "");
  return m ? Number(m[1]) + 1 : null;
}

export function membersOfParticipant(participantId, participantMembers = []) {
  return participantMembers.filter((m) => m.participant_id === participantId).sort((a, b) => a.slot - b.slot);
}

export function isPairEntry(participant, participantMembers = []) {
  return membersOfParticipant(participant.id, participantMembers).length >= 2 || participant.kind === "team_pair";
}

export function assignedPersonIdsInDivision(data, divisionId, {
  exceptTeamId = null,
  exceptParticipantId = null,
  exceptParticipantTeamId = null,
} = {}) {
  const teamIds = new Set(
    (data.teams || [])
      .filter((t) => t.division_id === divisionId && t.id !== exceptTeamId)
      .map((t) => t.id)
  );
  const ids = new Set();
  for (const m of data.teamMembers || []) {
    if (teamIds.has(m.team_id) && m.person_id) ids.add(m.person_id);
  }
  const participants = (data.participants || []).filter((p) => p.division_id === divisionId);
  const byId = new Map(participants.map((p) => [p.id, p]));
  for (const m of data.participantMembers || []) {
    if (m.participant_id === exceptParticipantId) continue;
    const p = byId.get(m.participant_id);
    if (!p) continue;
    if (exceptParticipantTeamId && p.team_id === exceptParticipantTeamId) continue;
    if (m.person_id) ids.add(m.person_id);
  }
  return ids;
}

export function personLabel(personId, persons = []) {
  return persons.find((p) => p.id === personId)?.display_name || personId;
}

export function normalizePersonName(value) {
  return String(value ?? "").trim().toLowerCase();
}

// Name key for cross-division "DOUBLE ENTRY" detection: case-insensitive and
// whitespace-normalized (trimmed, inner runs of spaces collapsed), so
// " JUAN  DELA CRUZ " and "Juan Dela Cruz" are the same name.
export function doubleEntryNameKey(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

// entries: [{ name, divisionId, divisionName }]. Returns Map(nameKey ->
// [divisionName, ...]) holding only names entered in two or more DISTINCT
// divisions — repeats within one division are never a double entry. This is
// an information label, never a validation error.
export function findDoubleEntries(entries = []) {
  const byName = new Map();
  for (const e of entries) {
    const key = doubleEntryNameKey(e?.name);
    if (!key || e.divisionId == null || e.divisionId === "") continue;
    if (!byName.has(key)) byName.set(key, new Map());
    const divisions = byName.get(key);
    if (!divisions.has(e.divisionId)) divisions.set(e.divisionId, e.divisionName || String(e.divisionId));
  }
  const out = new Map();
  for (const [key, divisions] of byName) {
    if (divisions.size >= 2) out.set(key, [...divisions.values()]);
  }
  return out;
}

// One entry per registered person per division, from persisted data.
export function registrationEntries(data) {
  const participantById = new Map((data.participants || []).map((p) => [p.id, p]));
  const divisionName = new Map((data.divisions || []).map((d) => [d.id, d.name]));
  const entries = [];
  for (const m of data.participantMembers || []) {
    const participant = participantById.get(m.participant_id);
    if (!participant) continue;
    const person = (data.persons || []).find((p) => p.id === m.person_id);
    if (!person) continue;
    entries.push({ name: person.display_name, divisionId: participant.division_id, divisionName: divisionName.get(participant.division_id) });
  }
  return entries;
}

export function doubleEntryIndex(data) {
  return findDoubleEntries(registrationEntries(data));
}

// Resolves one typed replacement string (Matches → Edit Players) against the
// tournament's existing persons — case-insensitive, whitespace-trimmed, same
// convention as the Excel importers. Returns null for a blank/untouched field
// ("no change"), otherwise { text, existingPerson } where existingPerson is
// null when the typed name doesn't match anyone yet (a new player is created
// for it at save time via the existing add_person command).
export function resolvePersonByName(text, persons = []) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const existingPerson = persons.find((p) => normalizePersonName(p.display_name) === normalizePersonName(trimmed)) || null;
  return { text: trimmed, existingPerson };
}

// Shared reshaping of this app's persisted rows into what packages/engine's
// team-elimination round-robin functions expect — used by both
// teamEliminationStandings (individual pair ranking) and teamStandings
// (team-level Wins/Losses/Points For/Against) below, so there's exactly one
// place that reads teams/matches/match_participants/results for this.
function teamEliminationRoundRobinInputs(division, data) {
  const teams = (data.teams || [])
    .filter((t) => t.division_id === division.id)
    .map((t) => ({
      teamId: t.id,
      teamName: t.name,
      pairs: (data.participants || []).filter((p) => p.team_id === t.id).map((p) => ({ id: p.id })),
    }));
  const parents = (data.matches || []).filter((m) => m.division_id === division.id && !m.parent_match_id);
  const teamMatchups = parents.map((m) => {
    const a = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === "A");
    const b = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === "B");
    return {
      id: m.id,
      stage: m.stage_label === "round_robin" || m.bracket_side === "round_robin" ? "round_robin" : m.stage_label,
      status: m.status,
      teamAId: a?.team_id,
      teamBId: b?.team_id,
      teamAWins: m.team_a_wins ?? 0,
      teamBWins: m.team_b_wins ?? 0,
      winnerTeamId: m.winner === "A" ? a?.team_id : m.winner === "B" ? b?.team_id : null,
    };
  });
  const pairMatches = (data.matches || [])
    .filter((m) => m.division_id === division.id && m.parent_match_id)
    .map((m) => {
      const a = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === "A");
      const b = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === "B");
      const result = resultFor(m, data.results);
      return {
        id: m.id,
        teamMatchupId: m.parent_match_id,
        status: m.status,
        winner: m.winner,
        registrationAId: a?.participant_id,
        registrationBId: b?.participant_id,
        score: {
          scoreA: result?.score_a ?? m.score_state?.scoreA ?? 0,
          scoreB: result?.score_b ?? m.score_state?.scoreB ?? 0,
        },
      };
    });
  return { teams, teamMatchups, pairMatches };
}

// Round-robin qualification standings for a team_elimination division — the single
// source of truth reused by the Brackets tab, the Results tab, and the Excel export
// (packages/engine's rankIndividualPairsForSemifinals does the actual ranking; this
// just reshapes this app's persisted rows into what that function expects).
export function teamEliminationStandings(division, data) {
  const { teams, teamMatchups, pairMatches } = teamEliminationRoundRobinInputs(division, data);
  try {
    return rankIndividualPairsForSemifinals(teams, teamMatchups, pairMatches);
  } catch {
    return [];
  }
}

// Groups of pair names the engine could only order by its stable fallback
// (equal W, L, +/- and PF) — shown as a note so the tie is never silent.
export function unresolvedTieGroups(standings, data) {
  const groups = [];
  let current = [];
  standings.forEach((row, i) => {
    const prev = standings[i - 1];
    const continues = prev && prev.tieUnresolved && row.tieUnresolved
      && prev.wins === row.wins && prev.losses === row.losses
      && prev.pointDiff === row.pointDiff && prev.pointsFor === row.pointsFor;
    if (!continues && current.length) { groups.push(current); current = []; }
    if (row.tieUnresolved) current.push(data.participants.find((p) => p.id === row.registrationId)?.display_name || row.registrationId);
  });
  if (current.length) groups.push(current);
  return groups.filter((g) => g.length > 1);
}

// Team-level round-robin standings (Wins/Losses/Matches Played/Points For/
// Against/Diff) for a team_elimination division — round-robin stage only,
// same scope as teamEliminationStandings above (semifinal/bronze/final
// results are deliberately excluded, matching this app's existing standings
// convention — see publicLive/PublicStandingsTab.jsx). Reuses packages/engine's
// buildTeamStandingsFromRoundRobin, the same tested aggregator the legacy
// root app already used — not a new ranking algorithm.
export function teamStandings(division, data) {
  const { teams, teamMatchups, pairMatches } = teamEliminationRoundRobinInputs(division, data);
  try {
    return buildTeamStandingsFromRoundRobin(teams, teamMatchups, pairMatches);
  } catch {
    return [];
  }
}

// Overall Team Standings across every team-elimination division of the
// tournament (Results tab). The aggregation policy lives with the pure
// calculation in packages/engine (overallTeamStandings.js): teams combined by
// name across divisions; every COMPLETED pair match counts, in every stage;
// a win by default is a W/L with its recorded score (or 0–0); ranked
// W → point diff → points for, full ties share a rank. Scores come from the
// same place as the division standings (match_results, then score_state).
export function overallTeamStandings(data) {
  const divisions = (data.divisions || []).filter((d) => d.format === "team_elimination");
  const divisionIds = new Set(divisions.map((d) => d.id));
  const teams = (data.teams || [])
    .filter((t) => divisionIds.has(t.division_id))
    .map((t) => ({ id: t.id, name: t.name, divisionId: t.division_id }));
  const pairResults = (data.matches || [])
    .filter((m) => divisionIds.has(m.division_id) && m.parent_match_id && m.status === "completed" && (m.winner === "A" || m.winner === "B"))
    .map((m) => {
      const a = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === "A");
      const b = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === "B");
      const result = resultFor(m, data.results);
      return {
        matchId: m.id,
        divisionId: m.division_id,
        teamAId: a?.team_id,
        teamBId: b?.team_id,
        winnerSlot: m.winner,
        scoreA: result?.score_a ?? m.score_state?.scoreA ?? 0,
        scoreB: result?.score_b ?? m.score_state?.scoreB ?? 0,
      };
    });
  return buildOverallTeamStandings({ teams, divisions: divisions.map((d) => ({ id: d.id, name: d.name })), pairResults });
}

const NOT_STARTED = new Set(["scheduled", "ready", "assigned"]);

// The seeded playoff slots of a team-elimination division — the slots filled
// from qualification (no earlier match feeds them) — for Edit qualifiers.
// `autoParticipantId` is the automatic qualifier (from the knockout stage's
// config.auto_slots once an override exists); `locked` once the matchup or its
// pair match has started (the server refuses changes then too).
export function seededPlayoffSlots(division, data) {
  const stage = (data.stages || []).find((s) => s.division_id === division.id && s.kind === "team_knockout");
  if (!stage) return [];
  const matchups = (data.matches || [])
    .filter((m) => m.stage_id === stage.id && !m.parent_match_id)
    .sort((x, y) => (x.round - y.round) || ((x.bracket_position ?? 0) - (y.bracket_position ?? 0)));
  const fed = (mid, s) => matchups.some((m) => (m.next_match_id === mid && m.next_match_slot === s)
    || (m.loser_next_match_id === mid && m.loser_next_match_slot === s));
  const cfg = stage.config || {};
  const notStarted = (m) => NOT_STARTED.has(m.status) && !m.started_at;
  return matchups.flatMap((m) => ["A", "B"].filter((slot) => !fed(m.id, slot)).map((slot) => {
    const side = (data.matchParticipants || []).find((p) => p.match_id === m.id && p.slot === slot);
    const participantId = side?.participant_id ?? null;
    const auto = (cfg.auto_slots || []).find((x) => x.match_id === m.id && x.slot === slot);
    const autoParticipantId = auto ? auto.participant_id : participantId;
    const kids = (data.matches || []).filter((k) => k.parent_match_id === m.id);
    return {
      match: m,
      slot,
      stageTitle: matchStageTitle(m, data.matches),
      participantId,
      teamId: side?.team_id ?? null,
      autoParticipantId,
      overridden: participantId !== autoParticipantId,
      overrides: (cfg.overrides || []).filter((o) => o.match_id === m.id && o.slot === slot),
      locked: !notStarted(m) || kids.some((k) => !notStarted(k)),
    };
  }));
}

export function finalMatchOf(division, matches) {
  const inDivision = matches.filter((m) => m.division_id === division.id && !m.parent_match_id);
  if (!inDivision.length) return null;
  if (division.format === "team_elimination") {
    return inDivision.find((m) => m.stage_label === "final") || null;
  }
  return inDivision.find((m) => !m.next_match_id) || null;
}

export function bronzeMatchOf(division, matches) {
  return matches.find((m) => m.division_id === division.id && m.stage_label === "bronze") || null;
}

// Champion/runner-up/third place for a division, derived purely from persisted match
// winners — never a computed ranking. Shared by the Results tab and the Excel export.
export function placementsForDivision(division, data) {
  const final = finalMatchOf(division, data.matches);
  const bronze = bronzeMatchOf(division, data.matches);
  const placements = { champion: "", runnerUp: "", third: "" };
  if (final && final.status === "completed" && final.winner) {
    const winner = sideOf(final.id, final.winner, data);
    const loser = sideOf(final.id, final.winner === "A" ? "B" : "A", data);
    placements.champion = winner.name;
    placements.runnerUp = loser.name;
  }
  if (bronze && bronze.status === "completed" && bronze.winner) {
    placements.third = sideOf(bronze.id, bronze.winner, data).name;
  }
  return placements;
}

export function pairingQrText(payload) {
  return JSON.stringify({
    v: payload?.v ?? 1,
    sid: payload?.sid || "",
    g: payload?.g || "",
  });
}

// The public "Live" spectator page's shareable URL — see publicLive/route.js
// (the /live/<slug-or-id> route it points to) and screens/SettingsPanel.jsx
// (where this is surfaced to organizers as a copy-link/QR).
export function liveShareUrl(origin, slugOrId) {
  return `${origin}/live/${slugOrId}`;
}

// The deployed web origin, used as a fallback below. Also asserted directly
// in lib.test.js so a drift between the two is caught.
export const PUBLIC_LIVE_PRODUCTION_ORIGIN = "https://tournament-operator.vercel.app";

// Electron loads the UI from file://, which has no real, shareable origin —
// window.location.origin there is useless for a link/QR a phone can open.
// Fall back to the production web origin so the desktop app can still show a
// working Public Live share link/QR instead of punting to "open the website".
export function resolveShareOrigin(win) {
  const protocol = win?.location?.protocol;
  const origin = win?.location?.origin;
  return /^https?:$/.test(protocol || "") && origin ? origin : PUBLIC_LIVE_PRODUCTION_ORIGIN;
}
