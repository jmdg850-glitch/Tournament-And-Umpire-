import { describe, expect, it } from "vitest";
import { endOfDayIso, filterByStatus, parseDeviceLimit, planLabel, previewRenewal, statusOf } from "./format.js";

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

describe("filterByStatus / planLabel / previewRenewal", () => {
  it("filters by the same status keys statusOf produces, without mutating the list", () => {
    const items = [{ id: 1, status: "active" }, { id: 2, status: "active", expired: true }, { id: 3, status: "revoked" }, { id: 4, status: "unused" }];
    const before = JSON.stringify(items);
    expect(filterByStatus(items, "all")).toBe(items);
    expect(filterByStatus(items, "active").map((l) => l.id)).toEqual([1]);
    expect(filterByStatus(items, "expired").map((l) => l.id)).toEqual([2]);
    expect(filterByStatus(items, "revoked").map((l) => l.id)).toEqual([3]);
    expect(filterByStatus(items, "unused").map((l) => l.id)).toEqual([4]);
    expect(JSON.stringify(items)).toBe(before);
  });

  it("labels plans, treating unknown/missing as legacy", () => {
    expect([planLabel("monthly"), planLabel("yearly"), planLabel("trial_30")]).toEqual(["Monthly", "Yearly", "30-Day Trial"]);
    expect(planLabel(undefined)).toBe(planLabel("legacy"));
  });

  it("previews renewal like the server: from the current expiry, or from now when expired; none for trial/legacy", () => {
    const now = Date.parse("2026-09-22T12:00:00Z");
    expect(previewRenewal({ plan: "monthly", expires_at: "2027-01-31T10:00:00Z" }, now)).toBe("2027-02-28T10:00:00.000Z");
    expect(previewRenewal({ plan: "yearly", expires_at: "2026-10-01T00:00:00Z" }, now)).toBe("2027-10-01T00:00:00.000Z");
    expect(previewRenewal({ plan: "monthly", expires_at: "2026-01-01T00:00:00Z" }, now)).toBe("2026-10-22T12:00:00.000Z");
    expect(previewRenewal({ plan: "trial_30", expires_at: "2026-10-01T00:00:00Z" }, now)).toBeNull();
    expect(previewRenewal({ plan: "legacy", expires_at: null }, now)).toBeNull();
  });
});
