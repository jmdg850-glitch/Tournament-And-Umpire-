import test from "node:test";
import assert from "node:assert/strict";
import { endOfDayIso, statusOf } from "./format.js";

test("status labels follow revoked > expired > activated > not activated", () => {
  assert.equal(statusOf({ status: "unused" }).label, "Not activated");
  assert.equal(statusOf({ status: "active" }).label, "Activated");
  assert.equal(statusOf({ status: "revoked" }).label, "Revoked");
  assert.equal(statusOf({ status: "active", expired: true }).label, "Expired");
  assert.equal(statusOf({ status: "revoked", expired: true }).label, "Revoked");
});

test("end-of-day expiry is a future-safe ISO instant, blank means no expiry", () => {
  assert.equal(endOfDayIso(""), undefined);
  const d = new Date(endOfDayIso("2030-06-15"));
  assert.equal(d.getFullYear(), 2030);
  assert.equal(d.getHours(), 23);
});
