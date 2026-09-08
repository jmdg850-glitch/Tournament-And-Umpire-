import { describe, expect, test } from "vitest";
import {
  requireOrganizer,
  canScoreMatch,
  canScoreAsStation,
  assertStationMayIssue,
  assertAllowedScoreEventType,
  STATION_COMMANDS,
  STATION_FORBIDDEN_COMMANDS,
} from "./authz.js";
import { httpError } from "./writes.js";
import { parseCommandEnvelope } from "@tournament/contracts";

describe("authz", () => {
  test("organizer and admin may manage", () => {
    expect(() => requireOrganizer({ role: "organizer" })).not.toThrow();
    expect(() => requireOrganizer({ role: "admin" })).not.toThrow();
    expect(() => requireOrganizer({ role: "umpire" })).toThrow(/Organizer/);
    expect(() => requireOrganizer(null)).toThrow();
  });

  test("umpire can score only assigned match", () => {
    expect(canScoreMatch({ role: "umpire" }, "u1", "u1")).toBe(true);
    expect(canScoreMatch({ role: "umpire" }, "u1", "u2")).toBe(false);
    expect(canScoreMatch({ role: "organizer" }, "u1", "u2")).toBe(true);
    expect(canScoreMatch(null, "u1", "u1")).toBe(false);
  });

  test("station can score only its court assignment", () => {
    const device = { status: "active", court_id: "c1", tournament_id: "t1" };
    expect(canScoreAsStation(device, { court_id: "c1" }, { tournament_id: "t1" })).toBe(true);
    expect(canScoreAsStation(device, { court_id: "c2" }, { tournament_id: "t1" })).toBe(false);
    expect(canScoreAsStation({ ...device, status: "revoked" }, { court_id: "c1" }, { tournament_id: "t1" })).toBe(false);
  });
});

describe("station command allowlist", () => {
  test("stations may only issue match-execution commands", () => {
    expect(STATION_COMMANDS.has("start_match")).toBe(true);
    expect(STATION_COMMANDS.has("score_event")).toBe(true);
    expect(STATION_COMMANDS.has("complete_match")).toBe(true);
    for (const type of STATION_FORBIDDEN_COMMANDS) {
      expect(STATION_COMMANDS.has(type)).toBe(false);
      expect(() => assertStationMayIssue({ kind: "station" }, type, {})).toThrow(/cannot issue/i);
    }
  });

  test("stations cannot send timeout or administrative score types", () => {
    expect(() => assertStationMayIssue({ kind: "station" }, "score_event", { type: "timeout" })).toThrow(/scoring action/i);
    expect(() => assertAllowedScoreEventType("timeout")).toThrow(/not allowed/i);
    expect(() => assertAllowedScoreEventType("point")).not.toThrow();
    expect(() => assertAllowedScoreEventType("undo")).not.toThrow();
  });

  test("organizer actors are not blocked by the station allowlist", () => {
    expect(() => assertStationMayIssue({ kind: "user" }, "transition_match", {})).not.toThrow();
  });

  test("a score correction is allowed for user actors but forbidden for stations", () => {
    expect(() => assertAllowedScoreEventType("correction", { kind: "user", id: "u1" })).not.toThrow();
    expect(() => assertAllowedScoreEventType("correction")).not.toThrow(); // no actor (defensive default) is treated as a user
    expect(() => assertAllowedScoreEventType("correction", { kind: "station", deviceId: "d1" })).toThrow(/not allowed/i);
    expect(() => assertStationMayIssue({ kind: "station" }, "score_event", { type: "correction" })).toThrow(/scoring action/i);
  });
});

describe("command envelope", () => {
  test("rejects missing uuid", () => {
    expect(() => parseCommandEnvelope({ type: "create_tournament", payload: {} })).toThrow();
  });

  test("rejects unknown type", () => {
    expect(() => parseCommandEnvelope({
      command_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      type: "hack_the_planet",
      payload: {},
    })).toThrow(/Unknown command/);
  });
});

describe("httpError", () => {
  test("carries status and code", () => {
    const err = httpError(409, "ILLEGAL_TRANSITION", "nope");
    expect(err.status).toBe(409);
    expect(err.code).toBe("ILLEGAL_TRANSITION");
  });
});
