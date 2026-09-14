import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeskHash, parseDeskHash } from "./deskHash.js";

const ID = "a1b2c3d4-e5f6-4890-ab12-cd34ef567890";

test("parseDeskHash: parses a tournament id and tab", () => {
  assert.deepEqual(parseDeskHash(`#/t/${ID}/matches`), { tournamentId: ID, tab: "matches" });
});

test("parseDeskHash: tab is optional", () => {
  assert.deepEqual(parseDeskHash(`#/t/${ID}`), { tournamentId: ID, tab: null });
});

test("parseDeskHash: returns null for unrelated or malformed hashes", () => {
  assert.equal(parseDeskHash(""), null);
  assert.equal(parseDeskHash("#/somewhere-else"), null);
  assert.equal(parseDeskHash(`#/t/not-a-uuid/matches`), null);
});

test("parseDeskHash: never matches the live-popout hash scheme (no collision with parseLiveHash)", () => {
  assert.equal(parseDeskHash(`#/live/${ID}/${ID}`), null);
});

test("buildDeskHash round-trips through parseDeskHash", () => {
  const hash = buildDeskHash(ID, "courts");
  assert.deepEqual(parseDeskHash(hash), { tournamentId: ID, tab: "courts" });
});
