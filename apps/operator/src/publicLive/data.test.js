import { test } from "node:test";
import assert from "node:assert/strict";
import { slugLookupColumn } from "./data.js";

test("slugLookupColumn: a raw uuid looks up by id", () => {
  assert.equal(slugLookupColumn("3fa85f64-5717-4562-b3fc-2c963f66afa6"), "id");
});

test("slugLookupColumn: anything else looks up by slug", () => {
  assert.equal(slugLookupColumn("summer-open-2026"), "slug");
  assert.equal(slugLookupColumn("not-quite-a-uuid-1234"), "slug");
  assert.equal(slugLookupColumn(""), "slug");
});
