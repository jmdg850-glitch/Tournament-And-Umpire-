import { describe, expect, it } from "vitest";
import { endOfDayIso, statusOf } from "./format.js";

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
