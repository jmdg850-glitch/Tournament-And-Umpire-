import { describe, expect, it } from "vitest";
import {
  adjustTimer,
  configureTimer,
  formatClock,
  isValidGameTimeSec,
  isValidTimerAdjustSec,
  normalizeTimer,
  pauseTimer,
  resetTimer,
  startTimer,
  timerFromDivisionConfig,
  timerRemainingMs,
  timerView,
  mergeMatchFromResult,
} from "./index.js";

const T0 = "2026-09-28T10:00:00.000Z";
const at = (sec) => Date.parse(T0) + sec * 1000;
const iso = (sec) => new Date(at(sec)).toISOString();

function tenMinutes() {
  return configureTimer(600, { now: T0, by: "org" });
}

describe("game timer — configuration", () => {
  it("accepts only whole seconds within range", () => {
    expect(isValidGameTimeSec(600)).toBe(true);
    for (const bad of [0, -60, 59, 10801, 60.5, NaN, "600", null, undefined]) {
      expect(isValidGameTimeSec(bad)).toBe(false);
      expect(configureTimer(bad)).toBeNull();
    }
  });

  it("validates adjustments", () => {
    expect(isValidTimerAdjustSec(60)).toBe(true);
    expect(isValidTimerAdjustSec(-60)).toBe(true);
    for (const bad of [0, 3601, -3601, 1.5, "60"]) expect(isValidTimerAdjustSec(bad)).toBe(false);
  });

  it("configuring does not start the countdown", () => {
    const timer = tenMinutes();
    expect(timer).toMatchObject({ v: 1, durationSec: 600, remainingMs: 600000, runningSince: null, updatedBy: "org" });
    const view = timerView({ status: "assigned", timer }, at(3600));
    expect(view).toEqual({ state: "configured", remainingMs: 600000, durationSec: 600 });
  });

  it("changing the duration before start just replaces it", () => {
    const timer = configureTimer(900, { now: iso(30) });
    expect(timerView({ status: "ready", timer }, at(500)).remainingMs).toBe(900000);
  });

  it("uses a division default only when valid", () => {
    expect(timerFromDivisionConfig({ gameTimeSeconds: 600 }, { now: T0 })?.durationSec).toBe(600);
    expect(timerFromDivisionConfig({ gameTimeSeconds: 0 })).toBeNull();
    expect(timerFromDivisionConfig({})).toBeNull();
    expect(timerFromDivisionConfig(undefined)).toBeNull();
  });
});

describe("game timer — no or malformed timer", () => {
  it("is 'none' for old matches and malformed data, never throws", () => {
    for (const timer of [undefined, null, {}, [], "10:00", { v: 2, durationSec: 600, remainingMs: 1 },
      { v: 1, durationSec: 600, remainingMs: -5 }, { v: 1, durationSec: 0, remainingMs: 0 },
      { v: 1, durationSec: 600, remainingMs: 1000, runningSince: "not a date" }]) {
      expect(normalizeTimer(timer)).toBeNull();
      expect(timerView({ status: "in_progress", timer }, at(1)).state).toBe("none");
    }
    expect(timerView(null, at(1)).state).toBe("none");
    expect(startTimer(null, T0)).toBeNull();
    expect(adjustTimer(null, 60, { now: T0 })).toBeNull();
  });
});

describe("game timer — running", () => {
  const started = () => startTimer(tenMinutes(), T0);

  it("counts down from the start anchor", () => {
    const timer = started();
    expect(timer.runningSince).toBe(T0);
    const m = { status: "in_progress", timer };
    expect(timerView(m, at(18)).remainingMs).toBe(582000);
    expect(formatClock(timerView(m, at(18)).remainingMs)).toBe("09:42");
    expect(timerView(m, at(18)).state).toBe("running");
  });

  it("starting again never restarts it", () => {
    const timer = started();
    expect(startTimer(timer, iso(120))).toEqual(timer);
  });

  it("is a pure function of time — rerenders/re-merges never drift or restart", () => {
    const m = { status: "in_progress", timer: started() };
    const a = timerView(m, at(125.3));
    const b = timerView(JSON.parse(JSON.stringify(m)), at(125.3));
    expect(a).toEqual(b);
    // A realtime row / command result merged in again carries the same anchor.
    const merged = mergeMatchFromResult({ id: "m", status: "in_progress" }, { match: { id: "m", ...m } });
    expect(timerView(merged, at(125.3))).toEqual(a);
  });

  it("reaches exactly 00:00, never negative, and does not touch the match", () => {
    const m = { status: "in_progress", timer: started(), score_state: { scoreA: 3, scoreB: 4 } };
    expect(formatClock(timerView(m, at(599.001)).remainingMs)).toBe("00:01");
    expect(timerView(m, at(600))).toMatchObject({ state: "expired", remainingMs: 0 });
    expect(timerView(m, at(9999))).toMatchObject({ state: "expired", remainingMs: 0 });
    expect(formatClock(timerView(m, at(9999)).remainingMs)).toBe("00:00");
    expect(m.status).toBe("in_progress");
    expect(m.score_state).toEqual({ scoreA: 3, scoreB: 4 });
  });

  it("a device clock behind the anchor never adds time", () => {
    expect(timerRemainingMs(started(), at(-30))).toBe(600000);
  });
});

describe("game timer — hold, adjust, reset", () => {
  it("pause banks remaining time; resume continues from it", () => {
    let timer = startTimer(tenMinutes(), T0);
    timer = pauseTimer(timer, at(100));
    expect(timer).toMatchObject({ remainingMs: 500000, runningSince: null });
    expect(timerView({ status: "postponed", timer }, at(5000))).toMatchObject({ state: "paused", remainingMs: 500000 });
    expect(timerView({ status: "ready", timer }, at(5000)).state).toBe("paused");
    timer = startTimer(timer, iso(5000));
    expect(timerView({ status: "in_progress", timer }, at(5010)).remainingMs).toBe(490000);
  });

  it("adds and removes time while running, re-anchored at now", () => {
    let timer = startTimer(tenMinutes(), T0);
    timer = adjustTimer(timer, 60, { now: iso(100), by: "org2" });
    expect(timer).toMatchObject({ remainingMs: 560000, runningSince: iso(100), updatedBy: "org2" });
    timer = adjustTimer(timer, -60, { now: iso(110) });
    expect(timerView({ status: "in_progress", timer }, at(110)).remainingMs).toBe(490000);
  });

  it("removing time near expiry clamps at zero", () => {
    let timer = startTimer(tenMinutes(), T0);
    timer = adjustTimer(timer, -60, { now: iso(570) });
    expect(timer.remainingMs).toBe(0);
    expect(timerView({ status: "in_progress", timer }, at(571))).toMatchObject({ state: "expired", remainingMs: 0 });
    // adding time back after expiry resumes the countdown
    timer = adjustTimer(timer, 60, { now: iso(580) });
    expect(timerView({ status: "in_progress", timer }, at(590))).toMatchObject({ state: "running", remainingMs: 50000 });
  });

  it("adjusts a paused timer without starting it", () => {
    const timer = adjustTimer(pauseTimer(startTimer(tenMinutes(), T0), at(60)), 60, { now: iso(70) });
    expect(timer).toMatchObject({ remainingMs: 600000, runningSince: null });
  });

  it("reset restores the full duration, keeping the running state", () => {
    const running = resetTimer(startTimer(tenMinutes(), T0), { now: iso(300) });
    expect(running).toMatchObject({ remainingMs: 600000, runningSince: iso(300) });
    const paused = resetTimer(pauseTimer(startTimer(tenMinutes(), T0), at(300)), { now: iso(400) });
    expect(paused).toMatchObject({ remainingMs: 600000, runningSince: null });
  });
});

describe("game timer — completion", () => {
  it("a completed match is frozen at completed_at and never counts again", () => {
    const timer = startTimer(tenMinutes(), T0);
    const done = { status: "completed", completed_at: iso(420), timer };
    expect(timerView(done, at(430))).toMatchObject({ state: "finished", remainingMs: 180000 });
    expect(timerView(done, at(99999))).toMatchObject({ state: "finished", remainingMs: 180000 });
    expect(startTimer(timer, iso(500))).toEqual(timer);
  });

  it("finished with no completed_at falls back safely", () => {
    const timer = pauseTimer(startTimer(tenMinutes(), T0), at(100));
    expect(timerView({ status: "abandoned", timer }, at(9999))).toMatchObject({ state: "finished", remainingMs: 500000 });
  });
});

describe("formatClock", () => {
  it("formats minutes and seconds", () => {
    expect(formatClock(600000)).toBe("10:00");
    expect(formatClock(59001)).toBe("01:00");
    expect(formatClock(1)).toBe("00:01");
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(-5000)).toBe("00:00");
    expect(formatClock(NaN)).toBe("00:00");
  });
});
