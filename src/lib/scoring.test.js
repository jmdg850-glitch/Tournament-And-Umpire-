import { describe, test, expect } from "vitest";
import { checkGameWin, newMatchState, applyPoint, undoPoint, applyEditedScore } from "./scoring.js";

function pressUntil(st, team, pred) {
  let cur = st;
  let guard = 0;
  while (!pred(cur)) {
    cur = applyPoint(cur, team);
    if (++guard > 500) throw new Error("scoring loop did not terminate");
  }
  return cur;
}

describe("checkGameWin", () => {
  test("win-by-2 requires both winTo and a 2-point lead", () => {
    expect(checkGameWin(10, 9, 11)).toBe(null);
    expect(checkGameWin(11, 9, 11)).toBe("A");
    expect(checkGameWin(11, 10, 11)).toBe(null);
    expect(checkGameWin(12, 10, 11)).toBe("A");
    expect(checkGameWin(9, 11, 11)).toBe("B");
  });

  test("win-by-one and race-to (none)", () => {
    expect(checkGameWin(11, 10, 11, "one")).toBe("A");
    expect(checkGameWin(11, 10, 11, "none")).toBe("A");
  });
});

describe("applyPoint — side-out singles", () => {
  test("only the serving side scores; side-out otherwise", () => {
    let st = newMatchState({ isDoubles: false, winTo: 11 });
    expect(st.servingTeam).toBe("A");
    st = applyPoint(st, "A");
    expect(st.scoreA).toBe(1);
    st = applyPoint(st, "B");
    expect(st.scoreA).toBe(1);
    expect(st.scoreB).toBe(0);
    expect(st.servingTeam).toBe("B");
  });

  test("single-game match completes at 11-9", () => {
    let st = newMatchState({ isDoubles: false, winTo: 11 });
    st = pressUntil(st, "A", s => s.status === "completed");
    expect(st.winner).toBe("A");
    expect(st.scoreA).toBe(11);
  });
});

describe("applyPoint — best-of-3", () => {
  test("game 1 win does not complete a best-of-3 match", () => {
    let st = newMatchState({ isDoubles: false, winTo: 11, bestOf: 3 });
    st = pressUntil(st, "A", s => (s.games || []).length >= 1);
    expect(st.status).toBe("in_progress");
    expect(st.winner).toBe(null);
    expect(st.gamesWonA).toBe(1);
    expect(st.gamesWonB).toBe(0);
    expect(st.scoreA).toBe(0);
    expect(st.gameNumber).toBe(2);
  });

  test("two games to A completes best-of-3", () => {
    let st = newMatchState({ isDoubles: false, winTo: 11, bestOf: 3 });
    st = pressUntil(st, "A", s => s.status === "completed");
    expect(st.winner).toBe("A");
    expect(st.gamesWonA).toBe(2);
  });
});

describe("undoPoint", () => {
  test("steps back a scored point", () => {
    let st = newMatchState({ isDoubles: false, winTo: 11 });
    st = applyPoint(st, "A");
    st = undoPoint(st);
    expect(st.scoreA).toBe(0);
    expect(st.status).toBe("in_progress");
  });
});

describe("applyEditedScore", () => {
  test("single-game edit to a winning score completes the match", () => {
    const st = newMatchState({ isDoubles: false, winTo: 11 });
    const ns = applyEditedScore(st, 11, 5);
    expect(ns.status).toBe("completed");
    expect(ns.winner).toBe("A");
  });

  test("best-of-3 game-1 winning edit does not complete the match", () => {
    const st = newMatchState({ isDoubles: false, winTo: 11, bestOf: 3 });
    const ns = applyEditedScore(st, 11, 5);
    expect(ns.status).toBe("in_progress");
    expect(ns.winner).toBe(null);
    expect(ns.gamesWonA).toBe(1);
    expect(ns.gameNumber).toBe(2);
    expect(ns.scoreA).toBe(0);
  });

  test("best-of-3 second-game winning edit completes the match", () => {
    let st = newMatchState({ isDoubles: false, winTo: 11, bestOf: 3 });
    st = applyEditedScore(st, 11, 5);
    st = applyEditedScore(st, 11, 3);
    expect(st.status).toBe("completed");
    expect(st.winner).toBe("A");
    expect(st.gamesWonA).toBe(2);
  });

  test("non-winning edit leaves match in progress", () => {
    const st = newMatchState({ isDoubles: false, winTo: 11, bestOf: 3 });
    const ns = applyEditedScore(st, 6, 4);
    expect(ns.status).toBe("in_progress");
    expect(ns.scoreA).toBe(6);
    expect(ns.scoreB).toBe(4);
    expect(ns.gamesWonA).toBe(0);
  });
});
