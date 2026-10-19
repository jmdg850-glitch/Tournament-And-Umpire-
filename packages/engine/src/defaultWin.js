import { validateFinalScore } from "./scoring.js";

// Optional administrative score recorded with a win by default (walkover).
// The official result stays "won by default" (score_state.defaultWin); this
// only validates the score the organizer typed in. Shared by the server
// (authoritative) and the Operator form (early feedback).
//
// Rules:
//   - null / undefined = no score (a plain W/O, the existing behaviour);
//   - whole numbers of 0 or more, within the match's race-to-N target;
//   - the winner by default must be strictly ahead (a score can't contradict
//     the official winner);
//   - single-game matches only (a multi-game score has no single line).
export function validateDefaultWinScore(score, winner, { winTo, bestOf } = {}) {
  if (score == null) return { ok: true, score: null };
  if (typeof score !== "object" || Array.isArray(score)) {
    return { ok: false, code: "INVALID_SCORE", reason: "Score must be { a, b }." };
  }
  if ((bestOf || 1) > 1) {
    return { ok: false, code: "CORRECTION_UNSUPPORTED", reason: "A score can't be recorded for a multi-game win by default." };
  }
  const a = score.a;
  const b = score.b;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
    return { ok: false, code: "INVALID_SCORE", reason: "Scores must be whole numbers of 0 or more." };
  }
  if (Number.isInteger(winTo) && winTo > 0) {
    const check = validateFinalScore(a, b, winTo);
    if (!check.ok) return { ok: false, code: "INVALID_SCORE", reason: check.reason };
  }
  if (winner !== "A" && winner !== "B") {
    return { ok: false, code: "INVALID_COMMAND", reason: "winner must be A or B" };
  }
  const winnerAhead = winner === "A" ? a > b : b > a;
  if (!winnerAhead) {
    return { ok: false, code: "SCORE_WINNER_MISMATCH", reason: "The side that wins by default must have the higher score." };
  }
  return { ok: true, score: { a, b } };
}
