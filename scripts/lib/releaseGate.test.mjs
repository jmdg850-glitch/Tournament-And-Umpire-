// node --test scripts/lib/releaseGate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideReleaseStart } from "./releaseGate.mjs";

const SHA = "7afd7ef7c1cf0000000000000000000000000000";

test("a dirty working tree proceeds exactly as before", () => {
  assert.deepEqual(decideReleaseStart({ dirtyCount: 3, remoteSha: "", unpushed: null }), { proceed: true, message: "" });
});

test("clean tree + commits ahead of origin/main proceeds and lists them", () => {
  const r = decideReleaseStart({ dirtyCount: 0, remoteSha: SHA, unpushed: ["6786014 Umpire timer", "1e6e836 Operator timer"] });
  assert.equal(r.proceed, true);
  assert.match(r.message, /releasing 2 committed change\(s\) not yet on origin\/main/);
  assert.match(r.message, /6786014 Umpire timer/);
  assert.match(r.message, /1e6e836 Operator timer/);
});

test("clean tree + nothing ahead is still skipped", () => {
  const r = decideReleaseStart({ dirtyCount: 0, remoteSha: SHA, unpushed: [] });
  assert.equal(r.proceed, false);
  assert.match(r.message, /No changes in the working tree — release skipped/);
});

test("clean tree + origin/main unreadable is skipped (nothing to prove there is work)", () => {
  const r = decideReleaseStart({ dirtyCount: 0, remoteSha: "", unpushed: null });
  assert.equal(r.proceed, false);
  assert.match(r.message, /could not be read/);
});

test("clean tree + origin has commits this checkout lacks proceeds so the preflight reports it", () => {
  const r = decideReleaseStart({ dirtyCount: 0, remoteSha: SHA, unpushed: null });
  assert.equal(r.proceed, true);
  assert.match(r.message, /origin\/main has commits this checkout lacks/);
});
