import { describe, test, expect } from "vitest";
import { assignedPersonIds, validatePersonIdsForAssignment } from "./registration.js";

const juan = "juan";
const pedro = "pedro";
const mark = "mark";
const carlo = "carlo";
const ben = "ben";
const alex = "alex";

const snapshot = {
  divisionTeams: [{ id: "team1" }, { id: "team2" }],
  teamMembers: [],
  divisionParticipants: [],
  participantMembers: [],
};

describe("assignedPersonIds / validatePersonIdsForAssignment", () => {
  test("all six players start available", () => {
    const assigned = assignedPersonIds(snapshot);
    expect(assigned.size).toBe(0);
    expect(validatePersonIdsForAssignment([juan, pedro], assigned).ok).toBe(true);
  });

  test("after Team/Pair 1 (Juan + Pedro) is saved, they are not selectable for Team 2", () => {
    const afterTeam1 = assignedPersonIds({
      ...snapshot,
      divisionParticipants: [{ id: "pair1", team_id: "team1" }],
      participantMembers: [
        { participant_id: "pair1", person_id: juan },
        { participant_id: "pair1", person_id: pedro },
      ],
    });
    expect([...afterTeam1].sort()).toEqual([juan, pedro].sort());
    expect(validatePersonIdsForAssignment([mark, carlo], afterTeam1).ok).toBe(true);
    expect(validatePersonIdsForAssignment([juan, mark], afterTeam1)).toEqual(expect.objectContaining({
      ok: false,
      code: "PLAYER_ALREADY_ASSIGNED",
    }));
  });

  test("removing Juan from Team 1 (edit) makes Juan available again", () => {
    const assigned = assignedPersonIds({
      ...snapshot,
      divisionParticipants: [{ id: "pair1", team_id: "team1" }],
      participantMembers: [{ participant_id: "pair1", person_id: pedro }],
    });
    expect(assigned.has(juan)).toBe(false);
    expect(assigned.has(pedro)).toBe(true);
    expect(validatePersonIdsForAssignment([juan, ben], assigned).ok).toBe(true);
  });

  test("deleting Team 1 returns both players to the pool", () => {
    const assigned = assignedPersonIds(snapshot);
    expect(validatePersonIdsForAssignment([juan, pedro], assigned).ok).toBe(true);
  });

  test("editing a pair excludes its current members from the conflict set", () => {
    const assigned = assignedPersonIds({
      ...snapshot,
      divisionParticipants: [
        { id: "pair1", team_id: "team1" },
        { id: "pair2", team_id: "team2" },
      ],
      participantMembers: [
        { participant_id: "pair1", person_id: juan },
        { participant_id: "pair1", person_id: pedro },
        { participant_id: "pair2", person_id: mark },
        { participant_id: "pair2", person_id: carlo },
      ],
      exceptParticipantId: "pair1",
    });
    expect(assigned.has(juan)).toBe(false);
    expect(assigned.has(pedro)).toBe(false);
    expect(assigned.has(mark)).toBe(true);
    expect(validatePersonIdsForAssignment([juan, alex], assigned).ok).toBe(true);
    expect(validatePersonIdsForAssignment([juan, mark], assigned).ok).toBe(false);
  });

  test("same person twice in one pair is rejected even if otherwise free", () => {
    expect(validatePersonIdsForAssignment([juan, juan], new Set())).toEqual(expect.objectContaining({
      ok: false,
      code: "DUPLICATE_PLAYER_IN_PAIR",
    }));
  });

  test("roster members of the selected team stay available for that team's pairs", () => {
    const assigned = assignedPersonIds({
      ...snapshot,
      teamMembers: [
        { team_id: "team1", person_id: juan },
        { team_id: "team1", person_id: pedro },
        { team_id: "team2", person_id: mark },
      ],
      exceptTeamId: "team1",
    });
    expect(assigned.has(juan)).toBe(false);
    expect(assigned.has(pedro)).toBe(false);
    expect(assigned.has(mark)).toBe(true);
  });
});
