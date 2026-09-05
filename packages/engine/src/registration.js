// Division-scoped player assignment — a person may not sit on two teams/pairs at once.

export function assignedPersonIds({
  divisionTeams = [],
  teamMembers = [],
  divisionParticipants = [],
  participantMembers = [],
  exceptTeamId = null,
  exceptParticipantId = null,
  exceptParticipantTeamId = null,
} = {}) {
  const teamIds = new Set(divisionTeams.map((t) => t.id).filter((id) => id !== exceptTeamId));
  const ids = new Set();
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

export function validatePersonIdsForAssignment(personIds, assignedIds) {
  const ids = (personIds || []).filter(Boolean);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    return {
      ok: false,
      code: "DUPLICATE_PLAYER_IN_PAIR",
      message: "The same player cannot be selected twice in one pair",
    };
  }
  for (const id of ids) {
    if (assignedIds.has(id)) {
      return {
        ok: false,
        code: "PLAYER_ALREADY_ASSIGNED",
        message: "This player is already assigned to another team or pair in this division",
      };
    }
  }
  return { ok: true };
}
