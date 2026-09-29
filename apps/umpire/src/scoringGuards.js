// UI guards for the scoring buttons. Pure, no React, no I/O — they only ASK
// the shared engine reducer what an action would do; they never decide a rule
// themselves (tested against the real engine in scoringGuards.test.js).
import { applyOptimisticScore } from "@tournament/engine";

// If recording a point for `team` would end the MATCH, returns what the
// confirmation shows ({ team, scoreA, scoreB, gamesWonA, gamesWonB, bestOf });
// otherwise null. A game win inside best-of-N is not a match end (Undo can
// still reverse it), so it returns null. Nothing is saved or sent.
export function matchPointPreview(match, localLastSeq, team) {
  const before = match?.score_state;
  if (!before || typeof before !== "object" || before.status === "completed") return null;
  try {
    const r = applyOptimisticScore(match, {
      id: "match-point-preview",
      seq: Number(localLastSeq || 0) + 1,
      type: "point",
      payload: { team },
    });
    if (!r.applied) return null;
    const st = r.state;
    if (st?.status !== "completed") return null;
    return { team, scoreA: st.scoreA ?? 0, scoreB: st.scoreB ?? 0, gamesWonA: st.gamesWonA, gamesWonB: st.gamesWonB, bestOf: st.bestOf || 1 };
  } catch {
    return null; // not applicable here — the real enqueue reports why
  }
}

// Mirrors the engine's undo: with no rally history in this game and no
// earlier game to step back into, undo changes nothing. Unknown shapes
// (no history array) stay undoable so the button is never wrongly disabled.
export function hasUndoablePoint(scoreState) {
  if (!scoreState || !Array.isArray(scoreState.history)) return true;
  return scoreState.history.length > 0 || Boolean(scoreState.games?.length);
}
