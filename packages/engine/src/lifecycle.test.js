import { describe, test, expect } from "vitest";
import {
  canTransitionTournament, assertTransitionTournament,
  canTransitionMatch, assertTransitionMatch,
} from "./lifecycle.js";

describe("canTransitionTournament", () => {
  test("legal forward path", () => {
    expect(canTransitionTournament("draft", "registration")).toBe(true);
    expect(canTransitionTournament("registration", "registration_closed")).toBe(true);
    expect(canTransitionTournament("registration_closed", "ready")).toBe(true);
    expect(canTransitionTournament("ready", "in_progress")).toBe(true);
    expect(canTransitionTournament("in_progress", "completed")).toBe(true);
    expect(canTransitionTournament("completed", "archived")).toBe(true);
  });

  test("cancel is legal from every live status except completed/archived", () => {
    for (const from of ["draft", "registration", "registration_closed", "ready", "in_progress"]) {
      expect(canTransitionTournament(from, "cancelled")).toBe(true);
    }
    expect(canTransitionTournament("cancelled", "archived")).toBe(true);
  });

  test("archived is terminal; skips and reverse moves are illegal", () => {
    expect(canTransitionTournament("archived", "draft")).toBe(false);
    expect(canTransitionTournament("draft", "in_progress")).toBe(false);
    expect(canTransitionTournament("completed", "in_progress")).toBe(false);
    expect(canTransitionTournament("cancelled", "registration")).toBe(false);
    expect(canTransitionTournament("in_progress", "ready")).toBe(false);
  });
});

describe("assertTransitionTournament", () => {
  test("returns true for a legal transition", () => {
    expect(assertTransitionTournament("draft", "registration")).toBe(true);
  });

  test("throws Error with code ILLEGAL_TRANSITION", () => {
    expect(() => assertTransitionTournament("completed", "draft")).toThrowError(/Illegal tournament transition/);
    try {
      assertTransitionTournament("archived", "ready");
      throw new Error("expected throw");
    } catch (err) {
      expect(err.code).toBe("ILLEGAL_TRANSITION");
    }
  });
});

describe("canTransitionMatch", () => {
  test("legal happy path scheduled -> ready -> assigned -> in_progress -> completed", () => {
    expect(canTransitionMatch("scheduled", "ready")).toBe(true);
    expect(canTransitionMatch("scheduled", "assigned")).toBe(true);
    expect(canTransitionMatch("ready", "assigned")).toBe(true);
    expect(canTransitionMatch("assigned", "in_progress")).toBe(true);
    expect(canTransitionMatch("in_progress", "completed")).toBe(true);
  });

  test("ready can start in_progress for court stations", () => {
    expect(canTransitionMatch("ready", "in_progress")).toBe(true);
  });

  test("assigned can release back to ready", () => {
    expect(canTransitionMatch("assigned", "ready")).toBe(true);
  });

  test("postponed can return to scheduled or ready, or cancel", () => {
    expect(canTransitionMatch("postponed", "scheduled")).toBe(true);
    expect(canTransitionMatch("postponed", "ready")).toBe(true);
    expect(canTransitionMatch("postponed", "cancelled")).toBe(true);
  });

  test("completed, cancelled, abandoned, and bye are terminal", () => {
    for (const from of ["completed", "cancelled", "abandoned", "bye"]) {
      expect(canTransitionMatch(from, "scheduled")).toBe(false);
      expect(canTransitionMatch(from, "in_progress")).toBe(false);
      expect(canTransitionMatch(from, "ready")).toBe(false);
    }
  });

  test("in_progress cannot jump to cancelled (must abandon or postpone)", () => {
    expect(canTransitionMatch("in_progress", "cancelled")).toBe(false);
    expect(canTransitionMatch("in_progress", "abandoned")).toBe(true);
    expect(canTransitionMatch("in_progress", "postponed")).toBe(true);
  });
});

describe("assertTransitionMatch", () => {
  test("throws Error with code ILLEGAL_TRANSITION", () => {
    try {
      assertTransitionMatch("completed", "ready");
      throw new Error("expected throw");
    } catch (err) {
      expect(err.code).toBe("ILLEGAL_TRANSITION");
      expect(err.message).toMatch(/Illegal match transition/);
    }
  });
});
