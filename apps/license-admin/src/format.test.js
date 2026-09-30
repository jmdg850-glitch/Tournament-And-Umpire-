import { describe, expect, it } from "vitest";
import { endOfDayIso, parseDeviceLimit, statusOf } from "./format.js";

describe("statusOf", () => {
  it("status labels follow revoked > expired > activated > not activated", () => {
    expect(statusOf({ status: "unused" }).label).toBe("Not activated");
    expect(statusOf({ status: "active" }).label).toBe("Activated");
    expect(statusOf({ status: "revoked" }).label).toBe("Revoked");
    expect(statusOf({ status: "active", expired: true }).label).toBe("Expired");
    expect(statusOf({ status: "revoked", expired: true }).label).toBe("Revoked");
  });
});

describe("endOfDayIso", () => {
  it("end-of-day expiry is a future-safe ISO instant, blank means no expiry", () => {
    expect(endOfDayIso("")).toBeUndefined();
    const d = new Date(endOfDayIso("2030-06-15"));
    expect(d.getFullYear()).toBe(2030);
    expect(d.getHours()).toBe(23);
  });
});

describe("parseDeviceLimit", () => {
  it("accepts whole numbers 1..100 and rejects everything else", () => {
    for (const [input, n] of [["1", 1], ["3", 3], [" 10 ", 10], ["100", 100], [5, 5]]) expect(parseDeviceLimit(input)).toBe(n);
    for (const bad of ["0", "101", "2.5", "-1", "", "abc", "1e2", null, undefined]) expect(parseDeviceLimit(bad)).toBeNull();
  });
});
