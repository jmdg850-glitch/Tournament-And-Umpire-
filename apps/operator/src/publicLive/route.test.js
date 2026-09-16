import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePublicLiveRoute, publicLivePath } from "./route.js";

test("parsePublicLiveRoute: parses a slug", () => {
  assert.deepEqual(parsePublicLiveRoute("/live/summer-open-2026"), { slugOrId: "summer-open-2026" });
});

test("parsePublicLiveRoute: parses a raw uuid", () => {
  const id = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
  assert.deepEqual(parsePublicLiveRoute(`/live/${id}`), { slugOrId: id });
});

test("parsePublicLiveRoute: tolerates a trailing slash", () => {
  assert.deepEqual(parsePublicLiveRoute("/live/summer-open/"), { slugOrId: "summer-open" });
});

test("parsePublicLiveRoute: returns null for unrelated paths", () => {
  assert.equal(parsePublicLiveRoute("/"), null);
  assert.equal(parsePublicLiveRoute("/dashboard"), null);
  assert.equal(parsePublicLiveRoute(""), null);
  assert.equal(parsePublicLiveRoute(null), null);
});

test("parsePublicLiveRoute: returns null for an empty slug segment", () => {
  assert.equal(parsePublicLiveRoute("/live/"), null);
  assert.equal(parsePublicLiveRoute("/live"), null);
});

test("parsePublicLiveRoute: returns null for an extra path segment (never silently matches a nested path)", () => {
  assert.equal(parsePublicLiveRoute("/live/summer-open/bracket"), null);
});

test("parsePublicLiveRoute: rejects invalid characters, including path traversal attempts", () => {
  assert.equal(parsePublicLiveRoute("/live/../etc/passwd"), null);
  assert.equal(parsePublicLiveRoute("/live/foo%20bar"), null);
  assert.equal(parsePublicLiveRoute("/live/foo bar"), null);
  assert.equal(parsePublicLiveRoute("/live/foo_bar"), null);
});

test("parsePublicLiveRoute: rejects an overlong segment", () => {
  assert.equal(parsePublicLiveRoute(`/live/${"a".repeat(81)}`), null);
});

test("publicLivePath: builds the expected path", () => {
  assert.equal(publicLivePath("summer-open-2026"), "/live/summer-open-2026");
});
