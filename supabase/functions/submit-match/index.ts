// POST { matchId: string }
// Submits one completed PickleLive match to DUPR. See the plan doc's
// "Submission flow" section for the full step-by-step rationale.
import { authorizeMatch } from "../_shared/authorizeMatch.ts";
import { getDupr } from "../_shared/duprClient.ts";
import { resolveDuprIds } from "../_shared/idResolver.ts";
import { toExternalMatchRequest } from "../_shared/matchMapper.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { verifyCaller } from "../_shared/verifyCaller.ts";
import type { PickleLiveMatch } from "../_shared/types.ts";

const RETRY_SCHEDULE_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000]; // 30s,2m,10m,1h,6h
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function nextRetryAt(attemptCount: number): string | null {
  const delay = RETRY_SCHEDULE_MS[attemptCount - 1];
  return delay ? new Date(Date.now() + delay).toISOString() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const caller = await verifyCaller(req);
  if ("error" in caller) return json({ ok: false, error: caller.error }, caller.status);

  const body = await req.json().catch(() => ({}));

  // Read-only lookup of a match already submitted to DUPR, by its numeric
  // matchCode — for independently verifying a submission against DUPR's own
  // record. No DB writes, no re-submission, no retry.
  if (body.mode === "view") {
    const matchCode = Number(body.matchCode);
    if (!matchCode || !Number.isFinite(matchCode)) {
      return json({ ok: false, error: "matchCode is required" }, 400);
    }
    const result = await getDupr().viewMatch(matchCode);
    if (result.requestId) console.log(`[dupr] view-match ${matchCode} — X-Request-Id: ${result.requestId}`);
    if (!result.ok) {
      return json({ ok: false, error: result.error, httpStatus: result.httpStatus, requestId: result.requestId }, 200);
    }
    return json({ ok: true, match: result.data, requestId: result.requestId });
  }

  const { matchId } = body;
  if (!matchId || typeof matchId !== "string") {
    return json({ ok: false, error: "matchId is required" }, 400);
  }

  const admin = supabaseAdmin();

  const { data: matchRow, error: matchErr } = await admin
    .from("matches")
    .select("id, data")
    .eq("id", matchId)
    .maybeSingle();
  if (matchErr || !matchRow) return json({ ok: false, error: "Match not found" }, 404);

  const raw = matchRow.data as Record<string, unknown>;
  const match: PickleLiveMatch = {
    id: matchRow.id,
    isDoubles: !!raw.isDoubles,
    teamA: (raw.teamA as string[]) || [],
    teamB: (raw.teamB as string[]) || [],
    finalScoreA: Number(raw.finalScoreA ?? 0),
    finalScoreB: Number(raw.finalScoreB ?? 0),
    date: String(raw.date || ""),
    location: (raw.location as string) || null,
    organizerId: String(raw.organizerId || ""),
    organizerIds: (raw.organizerIds as string[]) || [],
    tournamentName: (raw.tournamentName as string) || undefined,
    divisionName: (raw.divisionName as string) || undefined,
    tournamentDivisionId: (raw.tournamentDivisionId as string) || undefined,
    tournamentRound: raw.tournamentRound != null ? Number(raw.tournamentRound) : undefined,
    games: Array.isArray(raw.games) && raw.games.length
      ? (raw.games as { scoreA: number; scoreB: number }[])
      : undefined,
  };

  const authorized = await authorizeMatch(caller.userId, match);
  if (!authorized) return json({ ok: false, error: "Not authorized for this match" }, 403);

  // Read-only rating-impact sync for an already-submitted match, by matchId
  // (not a raw DUPR matchCode) so it goes through the same authorizeMatch
  // check as everything else. Manual/on-demand only — no polling loop, no
  // scheduled job. Merges DUPR's per-team delta/teamRating/preMatchRating
  // into the existing response_payload jsonb (no schema change) rather than
  // creating any new record — never resubmits, never touches matchSource.
  if (body.mode === "sync-rating") {
    const { data: sub } = await admin
      .from("dupr_match_submissions")
      .select("status, dupr_match_code, response_payload")
      .eq("match_id", matchId)
      .maybeSingle();
    if (!sub || sub.status !== "submitted" || !sub.dupr_match_code) {
      return json({ ok: false, error: "Match has not been submitted to DUPR yet" }, 400);
    }
    const result = await getDupr().viewMatch(Number(sub.dupr_match_code));
    if (result.requestId) console.log(`[dupr] sync-rating ${matchId} — X-Request-Id: ${result.requestId}`);
    if (!result.ok) {
      return json({ ok: false, error: result.error, httpStatus: result.httpStatus, requestId: result.requestId }, 200);
    }
    const remoteMatch = (result.data || {}) as Record<string, unknown>;
    const teams = Array.isArray(remoteMatch.teams) ? (remoteMatch.teams as Record<string, unknown>[]) : [];
    const ratingSync = {
      eloCalculated: remoteMatch.eloCalculated ?? null,
      teams: teams.map((t) => {
        const player1 = (t.player1 || {}) as Record<string, unknown>;
        return {
          duprId: player1.duprId ?? null,
          delta: t.delta ?? null,
          teamRating: t.teamRating ?? null,
          preMatchRatingAndImpact: t.preMatchRatingAndImpact ?? null,
        };
      }),
      syncedAt: new Date().toISOString(),
      requestId: result.requestId,
    };
    await admin
      .from("dupr_match_submissions")
      .update({
        response_payload: { ...(sub.response_payload || {}), ratingSync },
        updated_at: new Date().toISOString(),
      })
      .eq("match_id", matchId);
    return json({ ok: true, ...ratingSync });
  }

  // Authoritative CLUB-vs-PARTNER decision — looked up server-side against
  // tournament_divisions.dupr_rated rather than trusted from the client-
  // authored matches.data JSON, since it decides which DUPR club a match is
  // attributed to. Also decides eligibility below: a tournament match whose
  // division isn't dupr_rated never gets submitted, auto or manual.
  let isDuprRatedDivision = false;
  if (match.tournamentDivisionId) {
    const { data: divisionRow } = await admin
      .from("tournament_divisions")
      .select("dupr_rated")
      .eq("id", match.tournamentDivisionId)
      .maybeSingle();
    isDuprRatedDivision = !!divisionRow?.dupr_rated;
  }
  const clubIdEnv = Deno.env.get("DUPR_CLUB_ID");
  const clubId = clubIdEnv ? Number(clubIdEnv) : null;

  // Tournament matches always reach this function (App.jsx's endMatch enqueues
  // unconditionally for any match with a tournamentDivisionId — see its own
  // comment); this is the actual eligibility gate. Never overwrites an
  // already-successful submission (e.g. if a division's dupr_rated flag gets
  // toggled off after matches were already submitted).
  if (match.tournamentDivisionId && !isDuprRatedDivision) {
    const { data: existing } = await admin
      .from("dupr_match_submissions")
      .select("status, dupr_match_code")
      .eq("match_id", matchId)
      .maybeSingle();
    if (existing?.status === "submitted") {
      return json({ ok: true, status: "submitted", matchCode: existing.dupr_match_code, note: "Already submitted" });
    }
    await admin
      .from("dupr_match_submissions")
      .upsert(
        { match_id: matchId, identifier: matchId, organizer_id: match.organizerId, status: "not_rated", last_error: null, updated_at: new Date().toISOString() },
        { onConflict: "match_id" },
      );
    return json({ ok: true, status: "not_rated" });
  }

  // Atomic claim — the real idempotency guard. Ensure a row exists first
  // (first submission attempt for this match), then attempt to claim it.
  // "not_rated" is reclaimable so a retry after the organizer flips a
  // division to DUPR-rated after matches were already played works.
  await admin
    .from("dupr_match_submissions")
    .upsert(
      { match_id: matchId, identifier: matchId, organizer_id: match.organizerId, status: "pending" },
      { onConflict: "match_id", ignoreDuplicates: true },
    );

  const { data: claimed } = await admin
    .from("dupr_match_submissions")
    .update({ status: "submitting", last_attempt_at: new Date().toISOString() })
    .eq("match_id", matchId)
    .in("status", ["pending", "failed", "not_rated"])
    .select()
    .maybeSingle();

  if (!claimed) {
    const { data: current } = await admin
      .from("dupr_match_submissions")
      .select()
      .eq("match_id", matchId)
      .maybeSingle();
    return json({ ok: true, status: current?.status, matchCode: current?.dupr_match_code, note: "Already claimed or terminal" });
  }

  // attempt_count increment done separately (Postgres can't self-reference
  // in a plain .update() payload via supabase-js) — read-modify-write here,
  // acceptable since we already hold the exclusive "submitting" claim.
  const attemptCount = (claimed.attempt_count || 0) + 1;
  await admin.from("dupr_match_submissions").update({ attempt_count: attemptCount }).eq("match_id", matchId);

  console.log(`[DUPR] Tournament match player ids — teamA=${JSON.stringify(match.teamA)} teamB=${JSON.stringify(match.teamB)} (matchId=${matchId})`);
  const { resolved, missing } = await resolveDuprIds([...match.teamA, ...match.teamB]);
  console.log(`[DUPR] Tournament participant resolution — resolved=${resolved.size} missing=${missing.length}`);
  if (missing.length > 0) {
    const errMsg = `Missing DUPR ID: ${missing.map((m) => m.name).join(", ")}`;
    await admin
      .from("dupr_match_submissions")
      .update({ status: "skipped", last_error: errMsg, updated_at: new Date().toISOString() })
      .eq("match_id", matchId);
    return json({ ok: false, retryable: false, reason: "missing_dupr_id", missing }, 200);
  }

  const requestPayload = toExternalMatchRequest(match, resolved, isDuprRatedDivision, clubId);
  console.log(`[DUPR] Final submission payload — matchPlayType=${requestPayload.matchPlayType} matchSource=${requestPayload.matchSource} teamA=${JSON.stringify(requestPayload.teamA)} teamB=${JSON.stringify(requestPayload.teamB)}`);
  const dupr = getDupr();
  const result = await dupr.createMatch(requestPayload);
  if (result.requestId) console.log(`[dupr] submit-match ${matchId} — X-Request-Id: ${result.requestId}`);

  if (result.ok && result.data) {
    await admin
      .from("dupr_match_submissions")
      .update({
        status: "submitted",
        dupr_match_code: result.data.matchCode,
        dupr_hashed_match_code: result.data.hashedMatchCode,
        request_payload: requestPayload,
        response_payload: { ...result.data, requestId: result.requestId },
        updated_at: new Date().toISOString(),
      })
      .eq("match_id", matchId);
    return json({ ok: true, status: "submitted", matchCode: result.data.matchCode });
  }

  // Always written as "failed" in dupr_match_submissions regardless of retryable — the
  // Outbox-visible distinction (retry vs. give up) comes from the `retryable` flag in the
  // response below and next_retry_at, not from the stored status itself.
  await admin
    .from("dupr_match_submissions")
    .update({
      status: "failed",
      last_error: result.error,
      next_retry_at: result.retryable ? nextRetryAt(attemptCount) : null,
      request_payload: requestPayload,
      response_payload: { error: result.error, httpStatus: result.httpStatus, requestId: result.requestId },
      updated_at: new Date().toISOString(),
    })
    .eq("match_id", matchId);

  return json({ ok: false, retryable: result.retryable, error: result.error }, 200);
});
