import { describe, expect, test, vi } from "vitest";
import {
  requireOrganizer,
  canScoreMatch,
  canScoreAsStation,
  assertStationMayIssue,
  assertAllowedScoreEventType,
  requireLicense,
  requireOrganizerLicensed,
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

// Fresh, never-reused email per test — requireLicense caches *positive*
// results in a module-level singleton, so sharing an email across tests
// would leak cache state between them.
let licenseEmailCounter = 0;
function freshEmail() {
  licenseEmailCounter += 1;
  return `license-test-${licenseEmailCounter}@example.com`;
}

function mockLicensesAdmin(rows) {
  const state = { calls: 0, eqArgs: [] };
  const admin = {
    from(table) {
      if (table !== "licenses") throw new Error(`unexpected table ${table}`);
      return {
        select: () => ({
          eq: (col, val) => {
            state.eqArgs.push([col, val]);
            return {
              order: async () => {
                state.calls += 1;
                return { data: rows, error: null };
              },
            };
          },
        }),
      };
    },
  };
  return { admin, state };
}

const throwingAdmin = {
  from() {
    throw new Error("licenses table should not have been queried");
  },
};

describe("requireLicense", () => {
  test("station actors are never license-gated and never query the DB", async () => {
    await expect(requireLicense(throwingAdmin, { kind: "station", deviceId: "d1" })).resolves.toBeUndefined();
  });

  test("no license row for the email -> LICENSE_REQUIRED", async () => {
    const { admin } = mockLicensesAdmin([]);
    await expect(requireLicense(admin, { kind: "user", email: freshEmail() }))
      .rejects.toMatchObject({ status: 403, code: "LICENSE_REQUIRED" });
  });

  test("status unused -> LICENSE_REQUIRED", async () => {
    const { admin } = mockLicensesAdmin([{ status: "unused", expires_at: null }]);
    await expect(requireLicense(admin, { kind: "user", email: freshEmail() }))
      .rejects.toMatchObject({ status: 403, code: "LICENSE_REQUIRED" });
  });

  test("status revoked -> LICENSE_INVALID", async () => {
    const { admin } = mockLicensesAdmin([{ status: "revoked", expires_at: null }]);
    await expect(requireLicense(admin, { kind: "user", email: freshEmail() }))
      .rejects.toMatchObject({ status: 403, code: "LICENSE_INVALID" });
  });

  test("status active but expired -> LICENSE_INVALID", async () => {
    const { admin } = mockLicensesAdmin([{ status: "active", expires_at: "2000-01-01T00:00:00.000Z" }]);
    await expect(requireLicense(admin, { kind: "user", email: freshEmail() }))
      .rejects.toMatchObject({ status: 403, code: "LICENSE_INVALID" });
  });

  test("status active with no expiry or a future expiry passes", async () => {
    const { admin: noExpiry } = mockLicensesAdmin([{ status: "active", expires_at: null }]);
    await expect(requireLicense(noExpiry, { kind: "user", email: freshEmail() })).resolves.toBeUndefined();

    const { admin: futureExpiry } = mockLicensesAdmin([{ status: "active", expires_at: "2999-01-01T00:00:00.000Z" }]);
    await expect(requireLicense(futureExpiry, { kind: "user", email: freshEmail() })).resolves.toBeUndefined();
  });

  test("picks the current row the same way the license edge function does: first non-revoked, else latest revoked", async () => {
    const { admin } = mockLicensesAdmin([
      { status: "revoked", expires_at: null },
      { status: "active", expires_at: null },
    ]);
    await expect(requireLicense(admin, { kind: "user", email: freshEmail() })).resolves.toBeUndefined();
  });

  test("normalizes the actor's email (trim + lowercase) before querying", async () => {
    const { admin, state } = mockLicensesAdmin([{ status: "active", expires_at: null }]);
    await requireLicense(admin, { kind: "user", email: "  Mixed.Case@Example.com  " });
    expect(state.eqArgs).toEqual([["email", "mixed.case@example.com"]]);
  });

  test("caches only positive results, per email, for the TTL window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const email = freshEmail();
      const { admin, state } = mockLicensesAdmin([{ status: "active", expires_at: null }]);
      await requireLicense(admin, { kind: "user", email });
      await requireLicense(admin, { kind: "user", email });
      expect(state.calls).toBe(1); // second call served from cache, no DB round trip

      vi.setSystemTime(61_000); // past the 60s TTL
      await requireLicense(admin, { kind: "user", email });
      expect(state.calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("never caches a denied result — every call re-checks the DB", async () => {
    const email = freshEmail();
    const { admin, state } = mockLicensesAdmin([]);
    await expect(requireLicense(admin, { kind: "user", email })).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
    await expect(requireLicense(admin, { kind: "user", email })).rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
    expect(state.calls).toBe(2);
  });

  test("a DB error surfaces as a generic INTERNAL error, never the raw DB error", async () => {
    const admin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            order: async () => ({ data: null, error: new Error("connection refused") }),
          }),
        }),
      }),
    };
    await expect(requireLicense(admin, { kind: "user", email: freshEmail() }))
      .rejects.toMatchObject({ status: 500, code: "INTERNAL" });
  });
});

describe("requireOrganizerLicensed", () => {
  test("rejects a non-organizer before ever touching the licenses table", async () => {
    await expect(requireOrganizerLicensed(throwingAdmin, { kind: "user", email: freshEmail() }, { role: "umpire" }))
      .rejects.toThrow(/Organizer/);
  });

  test("rejects a licensed-but-non-organizer member with the organizer error, not a license error", async () => {
    await expect(requireOrganizerLicensed(throwingAdmin, { kind: "user", email: freshEmail() }, null))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("passes an organizer with an active license", async () => {
    const { admin } = mockLicensesAdmin([{ status: "active", expires_at: null }]);
    await expect(requireOrganizerLicensed(admin, { kind: "user", email: freshEmail() }, { role: "organizer" }))
      .resolves.toBeUndefined();
  });

  test("blocks an organizer with no license", async () => {
    const { admin } = mockLicensesAdmin([]);
    await expect(requireOrganizerLicensed(admin, { kind: "user", email: freshEmail() }, { role: "admin" }))
      .rejects.toMatchObject({ code: "LICENSE_REQUIRED" });
  });
});
