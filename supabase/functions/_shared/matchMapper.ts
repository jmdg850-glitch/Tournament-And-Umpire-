// Pure function: PickleLive completed-match record + resolved DUPR ids ->
// ExternalMatchRequest. Field choices verified directly against the live
// spec's components.schemas.ExternalMatchRequest/ExternalMatchTeam (fetched
// raw, not paraphrased) — see types.ts's header comment.
import type { DuprMatchTeam, ExternalMatchRequest, PickleLiveMatch } from "./types.ts";

function toDuprDate(isoOrDateStr: string): string {
  // match.date is already stored as yyyy-MM-dd in PickleLive (src/lib/utils.js
  // `today()`), but truncate defensively in case a full ISO timestamp slips
  // through. Known v1 limitation: no timezone reconciliation for matches
  // played right around midnight.
  return (isoOrDateStr || "").slice(0, 10);
}

// `games` holds this team's own per-game scores (index-aligned with the
// opposing team's) when the match went more than one game; falls back to the
// single finalScoreA/B value as game1 for a casual single-game match.
function team(
  playerIds: string[],
  resolved: Map<string, string>,
  score: number,
  games: number[] | undefined,
): DuprMatchTeam {
  const [p1, p2] = playerIds;
  const scores = games && games.length ? games.slice(0, 5) : [score];
  const [game1, game2, game3, game4, game5] = scores;
  return {
    player1: resolved.get(p1) as string,
    player2: p2 ? (resolved.get(p2) as string) : undefined,
    game1,
    game2,
    game3,
    game4,
    game5,
  };
}

// `event` is REQUIRED by DUPR (previously omitted entirely — every real
// submission would have failed validation). Tournament matches get the
// tournament + division name; casual/Open Play matches get a fixed label,
// since PickleLive has no other per-match "event" concept to draw from.
function eventName(match: PickleLiveMatch): string {
  if (match.tournamentName) {
    return match.divisionName ? `${match.tournamentName} — ${match.divisionName}` : match.tournamentName;
  }
  return "PickleLive Match";
}

export function toExternalMatchRequest(
  match: PickleLiveMatch,
  resolved: Map<string, string>,
  isDuprRatedDivision: boolean,
  clubId: number | null,
): ExternalMatchRequest {
  // A DUPR-rated tournament division submits under the partner's club
  // (matchSource:"CLUB" + clubId — exercises the UAT club DUPR provisioned
  // for testing); every other match — casual, Open Play, or a non-rated
  // tournament division — submits as a plain partner match, unchanged from
  // the original design.
  const useClub = isDuprRatedDivision && clubId != null;
  return {
    identifier: match.id,
    matchDate: toDuprDate(match.date),
    matchCompletionType: "COMPLETED", // PickleLive has no forfeit/retirement concept today
    matchPlayType: match.tournamentName ? "TOURNAMENT" : "RECREATIONAL",
    matchSource: useClub ? "CLUB" : "PARTNER",
    clubId: useClub ? clubId : undefined,
    location: match.location || undefined,
    format: match.isDoubles ? "DOUBLES" : "SINGLES",
    event: eventName(match),
    bracket: match.tournamentRound ? `Round ${match.tournamentRound}` : undefined,
    teamA: team(match.teamA, resolved, match.finalScoreA, match.games?.map((g) => g.scoreA)),
    teamB: team(match.teamB, resolved, match.finalScoreB, match.games?.map((g) => g.scoreB)),
    extras: {
      pickleLiveMatchId: match.id,
      pickleLiveOrganizerId: match.organizerId,
    },
  };
}
