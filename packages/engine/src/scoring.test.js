import { describe, test, expect } from "vitest";
import {
  checkGameWin,
  createInitialScoreState,
  applyScoreEvent,
  reduceScoreEvents,
  serveNumber,
  serveStatusLabel,
  SECOND_SERVE,
  FIRST_SERVE,
  coinFaceFromByte,
  normalizeCoinTossPayload,
  readCoinToss,
  scoreStateForMatchStart,
} from "./scoring.js";

const settings = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: false, servingTeam: "A" };

function ev(id, type, seq, payload = {}) {
  return { id, type, seq, payload };
}

function applyPoint(state, team, seq, id = `p${seq}`) {
  return applyScoreEvent(state, ev(id, "point", seq, { team }));
}

function pressUntil(initial, team, pred) {
  let state = initial;
  let seq = (state.lastSeq || 0) + 1;
  let guard = 0;
  while (!pred(state)) {
    const result = applyPoint(state, team, seq);
    state = result.state;
    seq++;
    if (++guard > 500) throw new Error("scoring loop did not terminate");
  }
  return state;
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

describe("createInitialScoreState", () => {
  test("defaults serving team A, bestOf 1, winBy two", () => {
    const st = createInitialScoreState({ winTo: 11, isDoubles: false });
    expect(st.servingTeam).toBe("A");
    expect(st.bestOf).toBe(1);
    expect(st.winBy).toBe("two");
    expect(st.scoreA).toBe(0);
    expect(st.status).toBe("in_progress");
    expect(st.appliedEventIds).toEqual([]);
  });

  test("new match always starts on SECOND SERVE", () => {
    const st = createInitialScoreState({ winTo: 11, isDoubles: true });
    expect(st.server).toBe(SECOND_SERVE);
    expect(serveNumber(st)).toBe(SECOND_SERVE);
    expect(serveStatusLabel(st)).toBe("SECOND SERVE");
  });

  test("scoreStateForMatchStart forces SECOND SERVE on an unplayed match", () => {
    const started = scoreStateForMatchStart({
      score_state: { scoreA: 0, scoreB: 0, server: FIRST_SERVE, lastSeq: 0, servingTeam: "B" },
    }, { winTo: 11, isDoubles: true });
    expect(started.server).toBe(SECOND_SERVE);
    expect(started.servingTeam).toBe("B");
  });

  test("scoreStateForMatchStart does not rewrite serve after points", () => {
    const started = scoreStateForMatchStart({
      score_state: { scoreA: 3, scoreB: 1, server: FIRST_SERVE, lastSeq: 4, servingTeam: "A" },
    });
    expect(started.server).toBe(FIRST_SERVE);
    expect(started.scoreA).toBe(3);
  });
});

describe("applyScoreEvent — side-out singles", () => {
  test("only the serving side scores; side-out otherwise", () => {
    let st = createInitialScoreState(settings);
    let r = applyPoint(st, "a", 1);
    expect(r.applied).toBe(true);
    st = r.state;
    expect(st.scoreA).toBe(1);
    r = applyPoint(st, "b", 2);
    st = r.state;
    expect(st.scoreA).toBe(1);
    expect(st.scoreB).toBe(0);
    expect(st.servingTeam).toBe("B");
  });

  test("single-game match completes at 11-9", () => {
    let st = createInitialScoreState(settings);
    st = pressUntil(st, "a", s => s.status === "completed");
    expect(st.winner).toBe("A");
    expect(st.scoreA).toBe(11);
  });
});

describe("applyScoreEvent — best-of-3", () => {
  const bo3 = { ...settings, bestOf: 3 };

  test("game 1 win does not complete a best-of-3 match", () => {
    let st = createInitialScoreState(bo3);
    st = pressUntil(st, "a", s => (s.games || []).length >= 1);
    expect(st.status).toBe("in_progress");
    expect(st.winner).toBe(null);
    expect(st.gamesWonA).toBe(1);
    expect(st.gamesWonB).toBe(0);
    expect(st.scoreA).toBe(0);
    expect(st.gameNumber).toBe(2);
    expect(st.server).toBe(SECOND_SERVE);
    expect(serveStatusLabel(st)).toBe("SECOND SERVE");
  });

  test("two games to A completes best-of-3", () => {
    let st = createInitialScoreState(bo3);
    st = pressUntil(st, "a", s => s.status === "completed");
    expect(st.winner).toBe("A");
    expect(st.gamesWonA).toBe(2);
  });
});

describe("applyScoreEvent — undo", () => {
  test("undo event steps back a scored point", () => {
    let st = createInitialScoreState(settings);
    st = applyPoint(st, "a", 1).state;
    const r = applyScoreEvent(st, ev("u1", "undo", 2));
    expect(r.applied).toBe(true);
    expect(r.state.scoreA).toBe(0);
    expect(r.state.status).toBe("in_progress");
  });
});

describe("applyScoreEvent — timeout", () => {
  test("records timeout against the calling team without changing score", () => {
    let st = createInitialScoreState(settings);
    const r = applyScoreEvent(st, ev("t1", "timeout", 1, { team: "a", calledAt: "ts1" }));
    expect(r.applied).toBe(true);
    expect(r.state.timeoutsA).toBe(1);
    expect(r.state.timeoutsB).toBe(0);
    expect(r.state.timeoutTeam).toBe("A");
    expect(r.state.timeoutCalledAt).toBe("ts1");
    expect(r.state.scoreA).toBe(0);
  });
});

describe("applyScoreEvent — coin toss", () => {
  test("stores result and does not pick a server unless servingTeam is set", () => {
    let st = createInitialScoreState(settings);
    const r = applyScoreEvent(st, ev("c1", "coin_toss", 1, { result: "heads" }));
    expect(r.applied).toBe(true);
    expect(r.state.coinToss).toBe("heads");
    expect(r.state.tossWinner).toBe("A");
    expect(r.state.servingTeam).toBe("A");
    expect(r.state.server).toBe(SECOND_SERVE);
  });

  test("sets servingTeam only when payload includes it", () => {
    let st = createInitialScoreState(settings);
    const r = applyScoreEvent(st, ev("c2", "coin_toss", 1, { result: "tails", servingTeam: "b" }));
    expect(r.state.coinToss).toBe("tails");
    expect(r.state.tossWinner).toBe("B");
    expect(r.state.servingTeam).toBe("B");
  });

  test("does not overwrite a committed toss", () => {
    let st = createInitialScoreState(settings);
    st = applyScoreEvent(st, ev("c1", "coin_toss", 1, { result: "heads", servingTeam: "A" })).state;
    const second = applyScoreEvent(st, ev("c2", "coin_toss", 2, { result: "tails", servingTeam: "B" }));
    expect(second.applied).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.state.coinToss).toBe("heads");
    expect(second.state.servingTeam).toBe("A");
  });

  test("legacy A/B result maps to HEADS/TAILS without changing serve number", () => {
    const toss = normalizeCoinTossPayload({ result: "A", serving_team: "A" });
    expect(toss).toEqual({ result: "heads", winner: "A", servingTeam: "A" });
    expect(coinFaceFromByte(0)).toBe("heads");
    expect(coinFaceFromByte(1)).toBe("tails");
    expect(readCoinToss({ coin_toss: { result: "tails", winner: "B", servingTeam: "B" } }).result).toBe("tails");
  });
});

describe("applyScoreEvent — idempotent duplicate ids", () => {
  test("duplicate event id returns the same state and does not double-apply", () => {
    let st = createInitialScoreState(settings);
    const event = ev("same", "point", 1, { team: "a" });
    const first = applyScoreEvent(st, event);
    expect(first.applied).toBe(true);
    expect(first.state.scoreA).toBe(1);
    const second = applyScoreEvent(first.state, event);
    expect(second.applied).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.state).toBe(first.state);
    expect(second.state.scoreA).toBe(1);
  });
});

describe("applyScoreEvent — seq order", () => {
  test("throws when an event is applied out of seq order", () => {
    let st = createInitialScoreState(settings);
    st = applyPoint(st, "a", 1).state;
    expect(() => applyPoint(st, "a", 1, "p1b")).toThrowError(/seq order/);
    expect(() => applyPoint(st, "a", 0, "p0")).toThrowError(/seq order/);
  });
});

describe("reduceScoreEvents — reconstruct full state", () => {
  test("replays shuffled events in seq order to the same score", () => {
    const events = [
      ev("e3", "point", 3, { team: "a" }),
      ev("e1", "point", 1, { team: "a" }),
      ev("e2", "point", 2, { team: "b" }),
    ];
    const st = reduceScoreEvents(settings, events);
    expect(st.scoreA).toBe(1);
    expect(st.servingTeam).toBe("A");
    expect(st.appliedEventIds).toEqual(["e1", "e2", "e3"]);
    expect(st.lastSeq).toBe(3);
  });

  test("duplicate id in the list is skipped on the second sighting", () => {
    const events = [
      ev("dup", "point", 1, { team: "a" }),
      ev("dup", "point", 1, { team: "a" }),
      ev("e2", "point", 2, { team: "a" }),
    ];
    const st = reduceScoreEvents(settings, events);
    expect(st.scoreA).toBe(2);
    expect(st.appliedEventIds).toEqual(["dup", "e2"]);
  });

  test("reconstructing a completed best-of-3 from events matches stepwise apply", () => {
    const bo3 = { ...settings, bestOf: 3 };
    let stepwise = createInitialScoreState(bo3);
    const events = [];
    let seq = 1;
    while (stepwise.status !== "completed") {
      const event = ev(`p${seq}`, "point", seq, { team: "a" });
      events.push(event);
      stepwise = applyScoreEvent(stepwise, event).state;
      seq++;
    }
    const reduced = reduceScoreEvents(bo3, events);
    expect(reduced.winner).toBe("A");
    expect(reduced.gamesWonA).toBe(2);
    expect(reduced.status).toBe("completed");
    expect(reduced.scoreA).toBe(stepwise.scoreA);
    expect(reduced.games.length).toBe(stepwise.games.length);
  });
});

describe("applyScoreEvent — doubles serve number", () => {
  const doubles = { winTo: 11, winBy: "two", bestOf: 1, isDoubles: true, servingTeam: "A" };

  test("side-out from second server switches team to first server", () => {
    let st = createInitialScoreState(doubles);
    expect(st.server).toBe(SECOND_SERVE);
    st = applyPoint(st, "b", 1).state;
    expect(st.scoreA).toBe(0);
    expect(st.servingTeam).toBe("B");
    expect(st.server).toBe(FIRST_SERVE);
    expect(serveStatusLabel(st)).toBe("FIRST SERVE");
  });

  test("fault on first server stays with the same team on second server", () => {
    let st = createInitialScoreState(doubles);
    st = applyPoint(st, "b", 1).state;
    st = applyPoint(st, "a", 2).state;
    expect(st.servingTeam).toBe("B");
    expect(st.server).toBe(SECOND_SERVE);
    expect(serveStatusLabel(st)).toBe("SECOND SERVE");
  });
});
