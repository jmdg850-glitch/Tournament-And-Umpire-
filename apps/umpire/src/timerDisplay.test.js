// Scenario E on the umpire's screen: a winning point scored offline freezes
// the game timer at that point, before the server has seen it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOptimisticScore, configureTimer, createInitialScoreState, startTimer, timerView } from "@tournament/engine";
import { canUmpireSetGameTime, markLocalCompletion, timerDisplayMatch } from "./timerDisplay.js";

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
const SETTINGS = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" };

function liveMatch() {
  return {
    id: "m1",
    status: "in_progress",
    started_at: new Date(T0).toISOString(),
    completed_at: null,
    score_state: createInitialScoreState(SETTINGS),
    timer: startTimer(configureTimer(600, { now: T0 }), T0),
  };
}

// Same shape as the umpire's applyEntryToMatch score_event branch.
function applyPoint(match, seq, team, queuedAt, type = "point") {
  const r = applyOptimisticScore(match, { id: `e${seq}`, seq, type, payload: type === "point" ? { team } : {} });
  assert.ok(r.applied, `event ${seq} applied`);
  return markLocalCompletion(match, r.match, { queuedAt });
}

function winGame(match, fromMs) {
  let m = match;
  let seq = 0;
  // Side-out scoring with A serving: A wins every rally until the game ends.
  while (m.score_state.status !== "completed") {
    seq += 1;
    m = applyPoint(m, seq, "A", fromMs + seq * 1000);
    assert.ok(seq < 100);
  }
  return { match: m, seq, wonAt: fromMs + seq * 1000 };
}

test("a live match with no local winner is shown unchanged", () => {
  const m = applyPoint(liveMatch(), 1, "A", T0 + 1000);
  assert.equal(m.localCompletedAt, undefined);
  assert.equal(timerDisplayMatch(m), m);
  assert.equal(timerView(timerDisplayMatch(m), T0 + 60_000).state, "running");
});

test("winning point offline: the clock freezes at that point and stays frozen", () => {
  const { match, wonAt } = winGame(liveMatch(), T0);
  assert.equal(match.status, "in_progress"); // the row itself is untouched
  assert.equal(match.localCompletedAt, new Date(wonAt).toISOString());
  const frozen = timerView(timerDisplayMatch(match), wonAt + 5_000);
  assert.equal(frozen.state, "finished");
  assert.equal(frozen.remainingMs, 600_000 - (wonAt - T0));
  // Much later (even past the original expiry) it has not moved.
  assert.deepEqual(timerView(timerDisplayMatch(match), T0 + 3_600_000), frozen);
});

test("undoing the winning point offline lets the clock run again from the original anchor", () => {
  const { match, seq } = winGame(liveMatch(), T0);
  const undone = applyPoint(match, seq + 1, null, T0 + 90_000, "undo");
  assert.notEqual(undone.score_state.status, "completed");
  assert.equal(undone.localCompletedAt, undefined);
  const view = timerView(timerDisplayMatch(undone), T0 + 120_000);
  assert.equal(view.state, "running");
  assert.equal(view.remainingMs, 480_000);
});

test("after sync the server's completed match is used as-is", () => {
  const { match } = winGame(liveMatch(), T0);
  const serverDone = { ...match, localCompletedAt: undefined, status: "completed", completed_at: new Date(T0 + 200_000).toISOString() };
  assert.equal(timerDisplayMatch(serverDone), serverDone);
  assert.equal(timerView(serverDone, T0 + 999_000).remainingMs, 400_000);
});

test("no timer, or no queue timestamp: nothing changes", () => {
  const noTimer = { ...liveMatch(), timer: null };
  const { match } = winGame(noTimer, T0);
  assert.equal(timerView(timerDisplayMatch(match), T0).state, "none");
  const r = applyOptimisticScore(liveMatch(), { id: "x", seq: 1, type: "point", payload: { team: "A" } });
  assert.equal(markLocalCompletion(liveMatch(), r.match, {}).localCompletedAt, undefined);
});

test("game-time setup is offered only before the match has ever started", () => {
  for (const status of ["scheduled", "assigned", "ready"]) {
    assert.equal(canUmpireSetGameTime({ status, started_at: null }), true, status);
  }
});

test("no game-time setup once started, after a resume, or when finished", () => {
  assert.equal(canUmpireSetGameTime({ status: "in_progress", started_at: "2026-09-28T10:00:00.000Z" }), false);
  assert.equal(canUmpireSetGameTime({ status: "ready", started_at: "2026-09-28T10:00:00.000Z" }), false); // resumed after Hold
  assert.equal(canUmpireSetGameTime({ status: "postponed", started_at: "2026-09-28T10:00:00.000Z" }), false);
  assert.equal(canUmpireSetGameTime({ status: "completed", started_at: "2026-09-28T10:00:00.000Z" }), false);
  assert.equal(canUmpireSetGameTime(null), false);
});

test("a court station never gets game-time setup", () => {
  assert.equal(canUmpireSetGameTime({ status: "ready", started_at: null }, { station: true }), false);
});
