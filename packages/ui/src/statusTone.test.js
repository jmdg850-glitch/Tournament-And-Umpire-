import { test } from "node:test";
import assert from "node:assert/strict";
import { matchStatusTone, tournamentStatusTone } from "./statusTone.js";

test("matchStatusTone: covers every known match status", () => {
  assert.equal(matchStatusTone("in_progress"), "live");
  assert.equal(matchStatusTone("completed"), "ok");
  assert.equal(matchStatusTone("bye"), "ok");
  assert.equal(matchStatusTone("cancelled"), "danger");
  assert.equal(matchStatusTone("abandoned"), "danger");
  assert.equal(matchStatusTone("postponed"), "warn");
  assert.equal(matchStatusTone("ready"), "info");
  assert.equal(matchStatusTone("assigned"), "info");
  assert.equal(matchStatusTone("scheduled"), "muted");
});

test("matchStatusTone: unknown status falls back to muted, not a crash", () => {
  assert.equal(matchStatusTone("something_new"), "muted");
  assert.equal(matchStatusTone(undefined), "muted");
});

test("tournamentStatusTone: matches the original StatusBadge output for every tournament status", () => {
  // These are exactly the 8 TOURNAMENT_STATUS_LABEL keys — asserting parity
  // with the pre-refactor combined tone expression, status by status.
  assert.equal(tournamentStatusTone("draft"), "muted");
  assert.equal(tournamentStatusTone("registration"), "muted");
  assert.equal(tournamentStatusTone("registration_closed"), "muted");
  assert.equal(tournamentStatusTone("ready"), "warn");
  assert.equal(tournamentStatusTone("in_progress"), "warn");
  assert.equal(tournamentStatusTone("completed"), "ok");
  assert.equal(tournamentStatusTone("cancelled"), "muted");
  assert.equal(tournamentStatusTone("archived"), "muted");
});
