import { describe, test, expect } from "vitest";
import { generateTeamRoundRobinMatchups, rankIndividualPairsForSemifinals, isTeamRoundRobinComplete } from "./teamRoundRobin.js";
import { selectQualifiers, generateQualifierBracketShell } from "./teamPlayoffs.js";
import { advanceIndividualMatchup } from "./teamVsTeam.js";

const idGen = () => { let i = 0; return () => "id" + (i++); };

function buildTeams(teamCount, pairsPerTeam) {
  const teams = [];
  let seed = 1;
  for (let t = 0; t < teamCount; t++) {
    const teamId = "team" + t;
    const pairs = [];
    for (let p = 0; p < pairsPerTeam; p++) {
      pairs.push({ id: `${teamId}-p${p + 1}`, seed, teamId });
      seed++;
    }
    teams.push({ teamId, teamName: "Team " + String.fromCharCode(65 + t), pairs });
  }
  return teams;
}

function opponentMap(pairMatches) {
  const matchesByPair = new Map();
  const opponentsByPair = new Map();
  const unorderedKeys = new Set();
  for (const m of pairMatches) {
    const key = [m.registrationAId, m.registrationBId].sort().join("|");
    expect(unorderedKeys.has(key), `repeated pair-vs-pair ${key}`).toBe(false);
    unorderedKeys.add(key);
    for (const [self, opp] of [[m.registrationAId, m.registrationBId], [m.registrationBId, m.registrationAId]]) {
      matchesByPair.set(self, (matchesByPair.get(self) || 0) + 1);
      if (!opponentsByPair.has(self)) opponentsByPair.set(self, new Set());
      expect(opponentsByPair.get(self).has(opp), `${self} repeated opponent ${opp}`).toBe(false);
      opponentsByPair.get(self).add(opp);
    }
  }
  return { matchesByPair, opponentsByPair, unorderedKeys };
}

describe("MASTER: 5 pairs per team — each pair gets 4 unique elimination opponents", () => {
  test("2 teams × 5 pairs: 20 matches, every pair plays exactly 4, no repeated opponent", () => {
    const teams = buildTeams(2, 5);
    const { teamMatchups, pairMatches } = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });
    expect(teamMatchups).toHaveLength(1);
    expect(pairMatches).toHaveLength(20);
    expect(teamMatchups.every((m) => m.stage === "round_robin")).toBe(true);

    const { matchesByPair, opponentsByPair } = opponentMap(pairMatches);
    for (const team of teams) {
      for (const pair of team.pairs) {
        expect(matchesByPair.get(pair.id)).toBe(4);
        expect(opponentsByPair.get(pair.id).size).toBe(4);
      }
    }
  });

  test("3 pairs (smaller config): each pair plays exactly 2 unique opponents", () => {
    const teams = buildTeams(2, 3);
    const { pairMatches } = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });
    expect(pairMatches).toHaveLength(6);
    const { matchesByPair, opponentsByPair } = opponentMap(pairMatches);
    for (const team of teams) {
      for (const pair of team.pairs) {
        expect(matchesByPair.get(pair.id)).toBe(2);
        expect(opponentsByPair.get(pair.id).size).toBe(2);
      }
    }
  });

  test("4 pairs: each pair plays exactly 3 unique opponents", () => {
    const teams = buildTeams(2, 4);
    const { pairMatches } = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });
    expect(pairMatches).toHaveLength(12);
    const { matchesByPair } = opponentMap(pairMatches);
    for (const team of teams) {
      for (const pair of team.pairs) expect(matchesByPair.get(pair.id)).toBe(3);
    }
  });
});

describe("MASTER: standings → automatic semis (no same-team) → final may be same-team", () => {
  test("5 pairs × 2 teams: standings, points, top-4 semis, same-team SF forbidden, same-team final allowed", () => {
    const teams = buildTeams(2, 5);
    const { teamMatchups: rrMatchups, pairMatches: rrPairs } = generateTeamRoundRobinMatchups(teams, { makeId: idGen() });

    const completedPairs = rrPairs.map((pm) => {
      const rankOf = (id) => {
        const [teamPart, pairPart] = id.split("-p");
        return Number(pairPart) * 2 + Number(teamPart.replace("team", ""));
      };
      const aWins = rankOf(pm.registrationAId) < rankOf(pm.registrationBId);
      return {
        ...pm,
        status: "completed",
        winner: aWins ? "A" : "B",
        score: aWins ? { scoreA: 11, scoreB: 5 } : { scoreA: 5, scoreB: 11 },
      };
    });
    const aWins = completedPairs.filter((m) => m.winner === "A").length;
    const completedMatchups = rrMatchups.map((m) => ({
      ...m,
      status: "completed",
      teamAWins: aWins,
      teamBWins: completedPairs.length - aWins,
      winnerTeamId: aWins >= completedPairs.length - aWins ? m.teamAId : m.teamBId,
    }));
    expect(isTeamRoundRobinComplete(completedMatchups)).toBe(true);

    const ranked = rankIndividualPairsForSemifinals(teams, completedMatchups, completedPairs);
    expect(ranked).toHaveLength(10);
    for (const row of ranked) {
      expect(row.matchesPlayed).toBe(4);
      expect(row.wins + row.losses).toBe(4);
      expect(row.pointsFor).toBeGreaterThan(0);
    }
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

    expect(selectQualifiers(ranked, "top_x", 4)).toHaveLength(4);
    const qualifiers = selectQualifiers(ranked, "top_x_per_team", 2);
    expect(qualifiers).toHaveLength(4);
    expect(new Set(qualifiers.map((q) => q.teamId))).toEqual(new Set(["team0", "team1"]));

    const repaired = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "avoid_semis" });

    const sfs = repaired.teamMatchups.filter((m) => m.stage === "semifinal");
    expect(sfs).toHaveLength(2);
    for (const sf of sfs) {
      expect(sf.pairAId).toBeTruthy();
      expect(sf.pairBId).toBeTruthy();
      expect(sf.teamAId).not.toBe(sf.teamBId);
    }
    const final = repaired.teamMatchups.find((m) => m.stage === "final");
    expect(final).toBeTruthy();
    expect(repaired.pairMatches.filter((pm) => sfs.some((sf) => sf.id === pm.teamMatchupId))).toHaveLength(2);

    let matchups = repaired.teamMatchups;
    const apply = (patch) => {
      if (patch) matchups = matchups.map((m) => (m.id === patch.matchupId ? { ...m, ...patch.patch } : m));
    };
    const team0From = (sf) => (sf.teamAId === "team0"
      ? { id: sf.pairAId, teamId: sf.teamAId }
      : { id: sf.pairBId, teamId: sf.teamBId });
    apply(advanceIndividualMatchup(matchups, sfs[0].id, team0From(sfs[0]).id, team0From(sfs[0]).teamId));
    apply(advanceIndividualMatchup(matchups, sfs[1].id, team0From(sfs[1]).id, team0From(sfs[1]).teamId));
    const filledFinal = matchups.find((m) => m.stage === "final");
    expect(filledFinal.pairAId).toBeTruthy();
    expect(filledFinal.pairBId).toBeTruthy();
    expect(filledFinal.teamAId).toBe("team0");
    expect(filledFinal.teamBId).toBe("team0");
    expect(filledFinal.pairAId).not.toBe(filledFinal.pairBId);
  });

  test("qualified A1,A2,B1,C1 with avoid_semis never produces a same-team semifinal", () => {
    const qualifiers = [
      { registrationId: "A1", teamId: "tA" },
      { registrationId: "A2", teamId: "tA" },
      { registrationId: "B1", teamId: "tB" },
      { registrationId: "C1", teamId: "tC" },
    ];
    const { teamMatchups } = generateQualifierBracketShell(qualifiers, { makeId: idGen(), sameTeamPolicy: "avoid_semis" });
    const sfs = teamMatchups.filter((m) => m.stage === "semifinal");
    expect(sfs).toHaveLength(2);
    for (const sf of sfs) expect(sf.teamAId).not.toBe(sf.teamBId);
    const occupied = sfs.flatMap((sf) => [sf.pairAId, sf.pairBId]);
    expect(new Set(occupied)).toEqual(new Set(["A1", "A2", "B1", "C1"]));
  });
});
