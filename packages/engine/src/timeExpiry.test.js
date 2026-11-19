import { describe, expect, it } from "vitest";
import { createInitialScoreState, settleOnTimeExpiry } from "./index.js";

const AT = "2026-09-28T10:10:00.000Z";
const live = (scoreA, scoreB, extra = {}) => ({ ...createInitialScoreState({ winTo: 11, winBy: "none" }), scoreA, scoreB, ...extra });

describe("settleOnTimeExpiry", () => {
  it.each([
    [8, 6, 11, "A"],
    [10, 9, 11, "A"],
    [5, 3, 11, "A"],
    [12, 10, 15, "A"],
    [9, 8, 15, "A"],
    [3, 7, 11, "B"],
  ])("%i–%i (race to %i): the side ahead wins at the actual score", (a, b, winTo, winner) => {
    const out = settleOnTimeExpiry(live(a, b, { winTo }), { at: AT });
    expect(out.ok).toBe(true);
    expect(out.state).toMatchObject({ scoreA: a, scoreB: b, winTo, status: "completed", winner, timeExpired: { at: AT, scoreA: a, scoreB: b } });
  });

  it("a tied score is refused — next point wins", () => {
    for (const [a, b] of [[7, 7], [0, 0], [10, 10]]) {
      expect(settleOnTimeExpiry(live(a, b), { at: AT })).toMatchObject({ ok: false, code: "TIED_ON_TIME" });
    }
  });

  it("a multi-game match is refused", () => {
    expect(settleOnTimeExpiry(live(8, 6, { bestOf: 3 }), { at: AT })).toMatchObject({ ok: false, code: "CORRECTION_UNSUPPORTED" });
  });

  it("never touches the score, history or input state", () => {
    const st = live(8, 6, { history: [{ scoreA: 7, scoreB: 6 }], lastSeq: 22 });
    const copy = structuredClone(st);
    const out = settleOnTimeExpiry(st, { at: AT });
    expect(st).toEqual(copy);
    expect(out.state).toMatchObject({ history: copy.history, lastSeq: 22 });
  });

  it("re-settling a corrected result keeps the original expiry time", () => {
    const first = settleOnTimeExpiry(live(8, 6), { at: AT }).state;
    const again = settleOnTimeExpiry({ ...first, scoreA: 6, scoreB: 8 });
    expect(again.state).toMatchObject({ winner: "B", timeExpired: { at: AT, scoreA: 6, scoreB: 8 } });
  });
});
