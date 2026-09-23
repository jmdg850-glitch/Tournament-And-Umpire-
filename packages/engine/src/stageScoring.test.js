import { describe, test, expect } from "vitest";
import {
  applyScoreEvent,
  createInitialScoreState,
  reduceScoreEvents,
  scoreStateForMatchStart,
  stageScoringTarget,
  matchScoringStage,
  matchScoringTarget,
  validateFinalScore,
  SCORING_WIN_BY,
} from "./scoring.js";

// Product rules: qualification race to 11, semifinal/final (and bronze) race
// to 15, first to the target wins immediately — no deuce, no win-by-2.
function rulesFor(stage) {
  return { winTo: stageScoringTarget(stage), winBy: SCORING_WIN_BY, bestOf: 1, isDoubles: false, servingTeam: "A" };
}

function correction(state, scoreA, scoreB, seq = (state.lastSeq || 0) + 1) {
  return applyScoreEvent(state, { id: `c${seq}`, type: "correction", seq, payload: { scoreA, scoreB } });
}

// Rally-scores each side up to the requested score via real "point" events
// (singles: the serving side scores; a side-out hands serve over).
function rallyTo(stage, targetA, targetB) {
  let st = createInitialScoreState(rulesFor(stage));
  let seq = 1;
  const point = (team) => { st = applyScoreEvent(st, { id: `p${seq}`, type: "point", seq, payload: { team } }).state; seq++; };
  while (st.status === "in_progress" && (st.scoreA < targetA || st.scoreB < targetB)) {
    const want = st.scoreA < targetA && (st.scoreB >= targetB || st.scoreA <= st.scoreB) ? "A" : "B";
    if (st.servingTeam !== want) point(want); // side-out to gain serve
    point(want);
  }
  return st;
}

describe("stageScoringTarget", () => {
  test("qualification and other rounds race to 11", () => {
    for (const stage of [null, undefined, "", "round_robin", "qualification", "knockout", "quarterfinal"]) {
      expect(stageScoringTarget(stage)).toBe(11);
    }
  });
  test("semifinal, final and bronze race to 15", () => {
    for (const stage of ["semifinal", "final", "bronze", "FINAL"]) {
      expect(stageScoringTarget(stage)).toBe(15);
    }
  });
});

describe("matchScoringStage / matchScoringTarget", () => {
  // 8-player single-elim: R1 quarterfinals, R2 semifinals, R3 final, + bronze.
  const s = "stage-1";
  const se = [
    { id: "q1", stage_id: s, round: 1, bracket_side: "main", stage_label: null },
    { id: "q2", stage_id: s, round: 1, bracket_side: "main", stage_label: null },
    { id: "s1", stage_id: s, round: 2, bracket_side: "main", stage_label: null },
    { id: "s2", stage_id: s, round: 2, bracket_side: "main", stage_label: null },
    { id: "f", stage_id: s, round: 3, bracket_side: "main", stage_label: null },
    { id: "b", stage_id: s, round: 3, bracket_side: "bronze", stage_label: null },
  ];
  const byId = (id) => se.find((m) => m.id === id);

  test("single-elim rounds resolve by position", () => {
    expect(matchScoringStage(byId("q1"), se)).toBe("qualification");
    expect(matchScoringTarget(byId("q1"), se)).toBe(11);
    expect(matchScoringStage(byId("s1"), se)).toBe("semifinal");
    expect(matchScoringTarget(byId("s2"), se)).toBe(15);
    expect(matchScoringStage(byId("f"), se)).toBe("final");
    expect(matchScoringTarget(byId("f"), se)).toBe(15);
    expect(matchScoringStage(byId("b"), se)).toBe("bronze");
    expect(matchScoringTarget(byId("b"), se)).toBe(15);
  });

  test("without sibling data a single-elim match falls back to qualification", () => {
    expect(matchScoringTarget(byId("f"), [])).toBe(11);
  });

  test("team pair matches inherit the parent matchup's stage", () => {
    const rr = { id: "rr", stage_label: "round_robin", bracket_side: "round_robin", round: 1 };
    const semi = { id: "sm", stage_label: "semifinal", bracket_side: "semifinal", round: 1 };
    const fin = { id: "fn", stage_label: "final", bracket_side: "final", round: 2 };
    const kids = [
      { id: "k1", parent_match_id: "rr", stage_label: null, bracket_side: "pair", round: 1 },
      { id: "k2", parent_match_id: "sm", stage_label: "semifinal", bracket_side: "pair", round: 1 },
      { id: "k3", parent_match_id: "fn", stage_label: null, bracket_side: "pair", round: 2 },
    ];
    const all = [rr, semi, fin, ...kids];
    expect(matchScoringTarget(kids[0], all)).toBe(11);
    expect(matchScoringTarget(kids[1], all)).toBe(15);
    expect(matchScoringTarget(kids[2], all)).toBe(15);
    expect(matchScoringTarget({ id: "kx", parent_match_id: "missing", bracket_side: "pair" }, all)).toBe(11);
  });

  test("team knockout (quarterfinal) rounds race to 11", () => {
    expect(matchScoringTarget({ id: "ko", stage_label: "knockout", round: 1 }, [])).toBe(11);
  });
});

for (const [stage, T] of [["qualification", 11], ["semifinal", 15], ["final", 15]]) {
  describe(`${stage} — race to ${T}, no deuce`, () => {
    test(`${T}–0 wins`, () => {
      const r = correction(createInitialScoreState(rulesFor(stage)), T, 0);
      expect(r.applied).toBe(true);
      expect(r.state.status).toBe("completed");
      expect(r.state.winner).toBe("A");
    });
    test(`${T}–${T - 1} wins`, () => {
      const r = correction(createInitialScoreState(rulesFor(stage)), T, T - 1);
      expect(r.state.status).toBe("completed");
      expect(r.state.winner).toBe("A");
    });
    test(`${T - 1}–${T} wins`, () => {
      const r = correction(createInitialScoreState(rulesFor(stage)), T - 1, T);
      expect(r.state.status).toBe("completed");
      expect(r.state.winner).toBe("B");
    });
    test(`${T - 1}–${T - 1} is not complete`, () => {
      const r = correction(createInitialScoreState(rulesFor(stage)), T - 1, T - 1);
      expect(r.applied).toBe(true);
      expect(r.state.status).toBe("in_progress");
      expect(r.state.winner).toBe(null);
    });
    test(`${T}–${T} is rejected (cannot occur)`, () => {
      const st = createInitialScoreState(rulesFor(stage));
      const r = correction(st, T, T);
      expect(r.applied).toBe(false);
      expect(r.code).toBe("INVALID_SCORE");
      expect(r.state).toBe(st);
    });
    test(`no extension past ${T} (${T + 1}–${T - 1} rejected)`, () => {
      const r = correction(createInitialScoreState(rulesFor(stage)), T + 1, T - 1);
      expect(r.applied).toBe(false);
      expect(r.code).toBe("INVALID_SCORE");
    });
    test(`rally scoring ends immediately at ${T}–${T - 1} (no deuce)`, () => {
      const st = rallyTo(stage, T, T - 1);
      expect(st.scoreA).toBe(T);
      expect(st.scoreB).toBe(T - 1);
      expect(st.status).toBe("completed");
      expect(st.winner).toBe("A");
    });
  });
}

describe("validateFinalScore", () => {
  test("classifies complete / incomplete / invalid", () => {
    expect(validateFinalScore(11, 10, 11)).toMatchObject({ ok: true, complete: true });
    expect(validateFinalScore(10, 11, 11)).toMatchObject({ ok: true, complete: true });
    expect(validateFinalScore(10, 10, 11)).toMatchObject({ ok: true, complete: false });
    expect(validateFinalScore(11, 11, 11).ok).toBe(false);
    expect(validateFinalScore(12, 10, 11).ok).toBe(false);
    expect(validateFinalScore(15, 14, 15)).toMatchObject({ ok: true, complete: true });
    expect(validateFinalScore(16, 14, 15).ok).toBe(false);
    expect(validateFinalScore(-1, 3, 11).ok).toBe(false);
    expect(validateFinalScore(1.5, 3, 11).ok).toBe(false);
  });
});

describe("stage target is applied to persisted state", () => {
  test("coin toss written with the wrong target is corrected at match start", () => {
    // Coin toss reduced with qualification rules (winTo 11), lastSeq 1.
    const tossed = reduceScoreEvents(rulesFor("qualification"), [
      { id: "t1", type: "coin_toss", seq: 1, payload: { result: "heads", servingTeam: "A" } },
    ]);
    expect(tossed.lastSeq).toBe(1);
    const started = scoreStateForMatchStart({ score_state: tossed }, rulesFor("semifinal"));
    expect(started.winTo).toBe(15);
    expect(started.winBy).toBe("none");
    expect(started.coinToss).toBe("heads");
    expect(started.lastSeq).toBe(1);
  });
  test("a match with rallies played keeps its state", () => {
    const played = rallyTo("semifinal", 3, 0);
    const again = scoreStateForMatchStart({ score_state: played }, rulesFor("qualification"));
    expect(again).toBe(played);
  });
  test("re-reducing a semifinal's events with its stage rules completes at 15–14, not 11", () => {
    const events = [{ id: "c1", type: "correction", seq: 1, payload: { scoreA: 14, scoreB: 13 } }];
    const semi = reduceScoreEvents(rulesFor("semifinal"), events);
    expect(semi.status).toBe("in_progress");
    const done = reduceScoreEvents(rulesFor("semifinal"), [...events, { id: "c2", type: "correction", seq: 2, payload: { scoreA: 14, scoreB: 15 } }]);
    expect(done.status).toBe("completed");
    expect(done.winner).toBe("B");
    expect(done.winTo).toBe(15);
  });
});
