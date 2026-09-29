import test from "node:test";
import assert from "node:assert/strict";
import { applyScoreEvent, createInitialScoreState } from "@tournament/engine";
import { hasUndoablePoint, matchPointPreview } from "./scoringGuards.js";

// Race to 3, no deuce, doubles, A serving — small enough to reach match point.
function start(settings = {}) {
  return createInitialScoreState({ winTo: 3, winBy: "none", isDoubles: true, servingTeam: "A", ...settings });
}
function play(state, ...events) {
  let st = state;
  for (const e of events) {
    const seq = (st.lastSeq || 0) + 1;
    st = applyScoreEvent(st, { id: `e${seq}`, seq, type: e.type || "point", payload: e.team ? { team: e.team } : {} }).state;
  }
  return st;
}
const A = { team: "A" };
const B = { team: "B" };
const UNDO = { type: "undo" };
const matchOf = (st) => ({ id: "m1", status: "in_progress", score_state: st });

test("a normal point needs no confirmation (stays one tap)", () => {
  const st = start();
  assert.equal(matchPointPreview(matchOf(st), st.lastSeq, "A"), null);
  const st1 = play(st, A);
  assert.equal(st1.scoreA, 1);
  assert.equal(matchPointPreview(matchOf(st1), st1.lastSeq, "A"), null);
});

test("a rally lost by the serving side (side-out) never asks, even at match point", () => {
  const st = play(start(), A, A); // A leads 2–0 and serves
  assert.equal(matchPointPreview(matchOf(st), st.lastSeq, "B"), null);
});

test("only the point that ends the match asks, and the preview matches the engine", () => {
  const st = play(start(), A, A);
  const preview = matchPointPreview(matchOf(st), st.lastSeq, "A");
  assert.deepEqual(preview && { team: preview.team, scoreA: preview.scoreA, scoreB: preview.scoreB }, { team: "A", scoreA: 3, scoreB: 0 });
  const real = play(st, A);
  assert.equal(real.status, "completed");
  assert.equal(real.scoreA, preview.scoreA);
});

test("preview does not change the score it was given", () => {
  const st = play(start(), A, A);
  const snapshot = JSON.stringify(st);
  matchPointPreview(matchOf(st), st.lastSeq, "A");
  assert.equal(JSON.stringify(st), snapshot);
});

test("best-of-3: winning a game does not ask; winning the match does", () => {
  let st = play(start({ bestOf: 3 }), A, A);
  assert.equal(matchPointPreview(matchOf(st), st.lastSeq, "A"), null, "game point, not match point");
  st = play(st, A); // game 1 to A; game 2 starts with A serving
  assert.equal(st.status, "in_progress");
  assert.equal(st.gamesWonA, 1);
  st = play(st, A, A);
  const preview = matchPointPreview(matchOf(st), st.lastSeq, "A");
  assert.ok(preview, "match point in game 2");
  assert.equal(preview.gamesWonA, 2);
  assert.equal(preview.bestOf, 3);
});

test("no preview for a completed or missing score", () => {
  const done = play(start(), A, A, A);
  assert.equal(done.status, "completed");
  assert.equal(matchPointPreview(matchOf(done), done.lastSeq, "A"), null);
  assert.equal(matchPointPreview({ id: "m1", status: "in_progress", score_state: null }, 0, "A"), null);
  assert.equal(matchPointPreview(null, 0, "A"), null);
});

test("undo availability mirrors the engine", () => {
  const fresh = start();
  assert.equal(hasUndoablePoint(fresh), false);
  const afterPoint = play(fresh, A);
  assert.equal(hasUndoablePoint(afterPoint), true);
  const undone = play(afterPoint, UNDO);
  assert.equal(undone.scoreA, 0);
  assert.equal(hasUndoablePoint(undone), false);
  // A side-out is a recorded rally too, and the engine's undo reverses it.
  const sideOut = play(fresh, B);
  assert.equal(hasUndoablePoint(sideOut), true);
  // New game in best-of-3: empty history, but undo steps back into game 1.
  const game2 = play(start({ bestOf: 3 }), A, A, A);
  assert.equal(game2.history.length, 0);
  assert.equal(hasUndoablePoint(game2), true);
  assert.equal(play(game2, UNDO).gameNumber, 1);
});

test("whenever undo is unavailable, an engine undo would change nothing", () => {
  for (const st of [start(), play(start(), A, UNDO), play(start(), B, UNDO)]) {
    assert.equal(hasUndoablePoint(st), false);
    const after = play(st, UNDO);
    assert.deepEqual([after.scoreA, after.scoreB, after.servingTeam, after.server, after.gameNumber], [st.scoreA, st.scoreB, st.servingTeam, st.server, st.gameNumber]);
  }
});

test("unknown score shapes keep undo enabled (never wrongly disabled)", () => {
  assert.equal(hasUndoablePoint(null), true);
  assert.equal(hasUndoablePoint({ scoreA: 2, scoreB: 1 }), true);
});
