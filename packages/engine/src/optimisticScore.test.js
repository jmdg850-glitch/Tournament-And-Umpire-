import { describe, expect, test } from "vitest";
import { applyScoreEvent, createInitialScoreState } from "./scoring.js";
import {
  LIVE_WINDOW_FORBIDDEN_COMMANDS,
  UMPIRE_FORBIDDEN_COMMANDS,
  applyOptimisticScore,
  isUmpireScoreEventType,
  mergeMatchFromResult,
  reconcileAuthoritativeScore,
  scoreStateForOptimistic,
} from "./optimisticScore.js";

const settings = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" };

describe("optimistic scoring", () => {
  test("tap applies expected score before the server returns", () => {
    const match = { id: "m1", status: "in_progress", score_state: createInitialScoreState(settings) };
    const local = applyOptimisticScore(match, { id: "e1", seq: 1, type: "point", payload: { team: "A" } }, settings);
    expect(local.state.scoreA).toBe(1);
    expect(local.match.score_state.scoreA).toBe(1);
    expect(local.applied).toBe(true);
  });

  test("authoritative result replaces optimistic state when seq matches", () => {
    let st = createInitialScoreState(settings);
    st = applyScoreEvent(st, { id: "e1", seq: 1, type: "point", payload: { team: "A" } }).state;
    const auth = applyScoreEvent(st, { id: "e2", seq: 2, type: "point", payload: { team: "B" } }).state;
    const rec = reconcileAuthoritativeScore(st, auth);
    expect(rec.replaced).toBe(true);
    expect(rec.state.lastSeq).toBe(2);
  });

  test("stale server result does not overwrite a newer local seq", () => {
    let newer = createInitialScoreState(settings);
    newer = applyScoreEvent(newer, { id: "e1", seq: 1, type: "point", payload: { team: "A" } }).state;
    newer = applyScoreEvent(newer, { id: "e2", seq: 2, type: "point", payload: { team: "A" } }).state;
    const stale = applyScoreEvent(createInitialScoreState(settings), { id: "e1", seq: 1, type: "point", payload: { team: "A" } }).state;
    const rec = reconcileAuthoritativeScore(newer, stale);
    expect(rec.replaced).toBe(false);
    expect(rec.state.scoreA).toBe(newer.scoreA);
    expect(rec.state.lastSeq).toBe(2);
  });

  test("failed command rolls back to the snapshot, not a silent official score", () => {
    const snapshot = { id: "m1", status: "in_progress", score_state: createInitialScoreState(settings) };
    const optimistic = applyOptimisticScore(snapshot, { id: "e1", seq: 1, type: "point", payload: { team: "A" } }, settings).match;
    expect(optimistic.score_state.scoreA).toBe(1);
    const rolled = snapshot;
    expect(rolled.score_state.scoreA).toBe(0);
  });

  test("mergeMatchFromResult patches score_state without a full tournament reload", () => {
    const current = { id: "m1", status: "in_progress", score_state: { lastSeq: 0, scoreA: 0, scoreB: 0 } };
    const merged = mergeMatchFromResult(current, { match: { id: "m1", status: "in_progress", score_state: { lastSeq: 1, scoreA: 1, scoreB: 0 } } });
    expect(merged.score_state.scoreA).toBe(1);
    expect(merged.id).toBe("m1");
  });

  test("empty score_state still produces an initial optimistic board", () => {
    const st = scoreStateForOptimistic({ score_state: {} }, settings);
    expect(st.lastSeq).toBe(0);
    expect(st.scoreA).toBe(0);
  });
});

describe("umpire / live-window command restrictions", () => {
  test("timeout is not an umpire scoring action", () => {
    expect(isUmpireScoreEventType("timeout")).toBe(false);
    expect(isUmpireScoreEventType("point")).toBe(true);
    expect(isUmpireScoreEventType("undo")).toBe(true);
  });

  test("umpire cannot issue administrative commands", () => {
    for (const type of ["transition_match", "assign_court", "assign_umpire", "revoke_court_device"]) {
      expect(UMPIRE_FORBIDDEN_COMMANDS).toContain(type);
    }
  });

  test("live window cannot score or mutate matches", () => {
    for (const type of ["score_event", "start_match", "complete_match", "assign_court", "transition_match"]) {
      expect(LIVE_WINDOW_FORBIDDEN_COMMANDS).toContain(type);
    }
  });
});
