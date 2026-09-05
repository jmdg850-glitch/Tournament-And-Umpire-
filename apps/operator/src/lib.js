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
  ["live", "Live"],
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
  const a = result?.score_a ?? match?.score_state?.scoreA;
  const b = result?.score_b ?? match?.score_state?.scoreB;
  if (a == null && b == null) return "—";
  return `${a ?? 0}–${b ?? 0}`;
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

export function pairingQrText(payload) {
  return JSON.stringify({
    v: payload?.v ?? 1,
    sid: payload?.sid || "",
    g: payload?.g || "",
  });
}
