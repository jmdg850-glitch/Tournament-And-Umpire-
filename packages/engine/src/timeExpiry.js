// End a match on time: once the game timer has run out, the organizer or the
// assigned umpire may record the result at the ACTUAL score, even though no
// side reached the race-to target. Pure — whether the timer really expired is
// decided by the caller (the server, with its own clock, via timerView).
//
// Rules:
//   - the score is never changed: no points are added to reach the target;
//   - the side ahead wins; a tied score is refused (play continues until a
//     rally puts one side ahead — "next point wins");
//   - single-game matches only (a best-of-N match has no single score line).
//
// The result is a normal completed score_state (winner + status) so results,
// standings and bracket advancement treat it exactly like a played win;
// score_state.timeExpired marks it as ended on time.
export function settleOnTimeExpiry(state, { at } = {}) {
  const st = state || {};
  if ((st.bestOf || 1) > 1) {
    return { ok: false, code: "CORRECTION_UNSUPPORTED", reason: "A multi-game match can't be ended on time." };
  }
  const scoreA = st.scoreA ?? 0;
  const scoreB = st.scoreB ?? 0;
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    return { ok: false, code: "INVALID_SCORE", reason: "Scores must be whole numbers of 0 or more." };
  }
  if (scoreA === scoreB) {
    return { ok: false, code: "TIED_ON_TIME", reason: "The score is tied — play continues until one side leads." };
  }
  const winner = scoreA > scoreB ? "A" : "B";
  return {
    ok: true,
    state: {
      ...st,
      status: "completed",
      winner,
      timeExpired: { at: at ?? st.timeExpired?.at ?? null, scoreA, scoreB },
    },
  };
}
