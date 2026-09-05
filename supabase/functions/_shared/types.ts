// Shared types for the DUPR integration Edge Functions.
// Mirrors the ExternalMatchRequest contract as CONFIRMED against the live
// spec (fetched raw from https://uat.mydupr.com/api/v3/api-docs and read
// programmatically from components.schemas.ExternalMatchRequest /
// ExternalMatchTeam — not paraphrased, not AI-summarized).

export type DuprEnvelope<T> =
  | { status: "SUCCESS"; result: T }
  | { status: "FAILURE"; message: string };

export interface DuprTokenResult {
  token: string;
  expiry: string; // ISO timestamp, per the live spec's example
}

export type MatchFormat = "SINGLES" | "DOUBLES";
// Confirmed enum from the live spec. FORFEIT/WITHDRAWAL/RETIREMENT/TIE are
// non-rated and require UNCALCULATED_MATCH::ADD permission — PickleLive has
// no forfeit/retirement concept today, so only COMPLETED is ever sent.
export type MatchCompletionType = "COMPLETED" | "FORFEIT" | "WITHDRAWAL" | "RETIREMENT" | "TIE" | "UNKNOWN";
export type MatchSource = "DUPR" | "LEAGUE" | "PARTNER" | "CLUB";
// Confirmed enum from the live spec (matchPlayType) — INFORMATIONAL requires
// partner whitelisting, not used here.
export type MatchPlayType = "RECREATIONAL" | "TOURNAMENT" | "LEAGUE" | "UNKNOWN";

// Confirmed against components.schemas.ExternalMatchTeam: game1 is the only
// required field (PickleLive plays single-game matches); game2-5 optional,
// omitted entirely when not played (per DUPR's own doc guidance).
export interface DuprMatchTeam {
  player1: string; // DUPR id
  player2?: string; // DUPR id, doubles only
  game1: number;
  game2?: number;
  game3?: number;
  game4?: number;
  game5?: number;
}

export interface ExternalMatchRequest {
  identifier: string; // globally unique, our idempotency key — never reused
  matchDate: string; // yyyy-MM-dd
  matchCompletionType: MatchCompletionType;
  matchPlayType: MatchPlayType;
  // matchSource is optional in the schema (omit for a non-club match), but we
  // always send it explicitly for clarity — PARTNER for casual matches,
  // CLUB (+ clubId) for matches played in a DUPR-rated tournament division.
  matchSource: MatchSource;
  clubId?: number; // required by DUPR only when matchSource === "CLUB"
  location?: string;
  format: MatchFormat;
  teamA: DuprMatchTeam;
  teamB: DuprMatchTeam;
  // REQUIRED by DUPR (components.schemas.ExternalMatchRequest.required) —
  // the previous implementation never set this, which would have failed
  // validation on every real submission.
  event: string;
  bracket?: string;
  extras?: Record<string, unknown>;
}

export interface DuprMatchCreateResult {
  identifier: string;
  matchCode: string;
  hashedMatchCode: string;
}

// Normalized shape every _shared/duprClient.ts (and mockDupr.ts) call
// resolves to, so callers never touch the raw DUPR envelope.
export interface DuprCallResult<T> {
  ok: boolean;
  retryable: boolean;
  data?: T;
  error?: string;
  httpStatus?: number;
  requestId?: string; // DUPR's X-Request-Id response header, for support escalation
}

export interface SubmissionRow {
  match_id: string;
  identifier: string;
  organizer_id: string;
  status: "pending" | "submitting" | "submitted" | "failed" | "skipped";
  dupr_match_code: string | null;
  dupr_hashed_match_code: string | null;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  next_retry_at: string | null;
  request_payload: unknown;
  response_payload: unknown;
  created_at: string;
  updated_at: string;
}

// The subset of a PickleLive completed-match record (see App.jsx endMatch's
// `syncedMatch`) that matchMapper.ts needs. Deliberately narrow rather than
// importing the whole app's match shape into the function runtime.
export interface PickleLiveMatch {
  id: string;
  isDoubles: boolean;
  teamA: string[];
  teamB: string[];
  finalScoreA: number;
  finalScoreB: number;
  date: string;
  location: string | null;
  organizerId: string;
  organizerIds?: string[];
  // Tournament bridge fields (see App.jsx's startTournamentMatch) — undefined
  // for a casual/Open Play match. tournamentDivisionId is looked up
  // server-side (submit-match/index.ts) against tournament_divisions.dupr_rated
  // rather than trusted from this client-authored JSON directly, since that
  // flag decides matchSource/clubId.
  tournamentName?: string;
  divisionName?: string;
  tournamentDivisionId?: string;
  tournamentRound?: number;
  // Per-game score history for a best-of-N match (see App.jsx's live scoring
  // `st.games`). Undefined/empty for a single-game casual match — matchMapper.ts
  // falls back to finalScoreA/finalScoreB as game1 in that case.
  games?: { scoreA: number; scoreB: number }[];
}
