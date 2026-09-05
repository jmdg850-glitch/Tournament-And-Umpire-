import { describe, test, expect } from "vitest";
import { isAssignedUmpire, canControlOrUmpire } from "./umpire.js";

// Verification-only coverage — this permission logic (App.jsx's canControlMatchNow,
// RLS is_assigned_umpire_for_* helpers) was found already correct during the
// Team-vs-Team Individual Pair Qualification work, but had zero existing test
// coverage. Toss Coin's Math.random() output isn't meaningfully unit-testable
// (non-deterministic by design, persists only {result} via the audit log) —
// covered by manual QA instead of a forced unit test here.

describe("isAssignedUmpire", () => {
  test("true when the current user is the match's assigned umpire", () => {
    const match = { id:"m1", umpireId:"u1" };
    expect(isAssignedUmpire(match, { id:"u1" })).toBe(true);
  });

  test("false when the current user is a different account", () => {
    const match = { id:"m1", umpireId:"u1" };
    expect(isAssignedUmpire(match, { id:"someone-else" })).toBe(false);
  });

  test("false when the match has no umpire assigned yet", () => {
    const match = { id:"m1", umpireId:null };
    expect(isAssignedUmpire(match, { id:"u1" })).toBe(false);
  });

  test("false when there is no current user (logged out / missing id)", () => {
    const match = { id:"m1", umpireId:"u1" };
    expect(isAssignedUmpire(match, null)).toBe(false);
    expect(isAssignedUmpire(match, {})).toBe(false);
  });

  test("false against an UNASSIGNED match even for a user who umpires a different match", () => {
    // TEST 25: the umpire must only ever control the one match assigned to them.
    const assignedMatch = { id:"m1", umpireId:"u1" };
    const otherMatch = { id:"m2", umpireId:"u2" };
    expect(isAssignedUmpire(assignedMatch, { id:"u1" })).toBe(true);
    expect(isAssignedUmpire(otherMatch, { id:"u1" })).toBe(false);
  });
});

describe("canControlOrUmpire — widens, never narrows, organizer control", () => {
  test("organizer/co-organizer/admin control (baseControl=true) is preserved regardless of umpire status", () => {
    const match = { id:"m1", umpireId:null };
    expect(canControlOrUmpire(true, match, { id:"organizer" })).toBe(true);
  });

  test("the assigned umpire gains control on their own match even without organizer rights", () => {
    const match = { id:"m1", umpireId:"u1" };
    expect(canControlOrUmpire(false, match, { id:"u1" })).toBe(true);
  });

  test("an unassigned user with no organizer rights has no control", () => {
    const match = { id:"m1", umpireId:"u1" };
    expect(canControlOrUmpire(false, match, { id:"random-user" })).toBe(false);
  });

  test("TEST 24/25: assigned umpire can control their own match, but not a different court's match", () => {
    const myMatch = { id:"court1-match", umpireId:"u1" };
    const otherCourtMatch = { id:"court2-match", umpireId:"u2" };
    expect(canControlOrUmpire(false, myMatch, { id:"u1" })).toBe(true);
    expect(canControlOrUmpire(false, otherCourtMatch, { id:"u1" })).toBe(false);
  });
});
