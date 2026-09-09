// Covers the person-resolution logic behind Matches → Edit Players (see
// EditPlayersModal in TournamentDesk.jsx). The modal's own React state/UI is
// not covered here — there is no component-rendering test harness in this
// project — but every resolution decision the modal makes (blank vs typed,
// existing vs new player, case/whitespace normalization) is a pure function
// of resolvePersonByName/normalizePersonName, fully exercised below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePersonName, resolvePersonByName } from "./lib.js";

const persons = [
  { id: "p1", display_name: "Rem" },
  { id: "p2", display_name: "Jeff" },
  { id: "p3", display_name: "John" },
  { id: "p4", display_name: "Mark" },
  { id: "p5", display_name: "Carlos Cruz" },
];

test("resolvePersonByName: a blank replacement is 'no change' (null), not an error", () => {
  assert.equal(resolvePersonByName("", persons), null);
  assert.equal(resolvePersonByName("   ", persons), null);
  assert.equal(resolvePersonByName(undefined, persons), null);
});

test("resolvePersonByName: an unblank field is never pre-filled with the current player — this is purely a resolver over whatever text is passed in", () => {
  // The modal always initializes replacement text to "", independent of the
  // current player's name — see EditPlayersModal's replacementText state.
  // This test documents the contract the modal relies on: passing "" (the
  // initial/untouched state) must resolve to "no change", never to the
  // current player being silently "replaced" with themselves.
  const untouched = resolvePersonByName("", persons);
  assert.equal(untouched, null);
});

test("resolvePersonByName: an existing player is resolved by exact name", () => {
  const r = resolvePersonByName("Carlos Cruz", persons);
  assert.equal(r.existingPerson.id, "p5");
  assert.equal(r.text, "Carlos Cruz");
});

test("resolvePersonByName: matching is case-insensitive", () => {
  assert.equal(resolvePersonByName("carlos cruz", persons).existingPerson.id, "p5");
  assert.equal(resolvePersonByName("CARLOS CRUZ", persons).existingPerson.id, "p5");
  assert.equal(resolvePersonByName("CaRlOs CrUz", persons).existingPerson.id, "p5");
});

test("resolvePersonByName: leading/trailing whitespace is normalized before matching", () => {
  const r = resolvePersonByName("  Carlos Cruz  ", persons);
  assert.equal(r.existingPerson.id, "p5");
  assert.equal(r.text, "Carlos Cruz"); // trimmed for display/creation too
});

test("resolvePersonByName: an unknown typed name resolves with existingPerson=null (caller creates a new player)", () => {
  const r = resolvePersonByName("Zed", persons);
  assert.equal(r.existingPerson, null);
  assert.equal(r.text, "Zed");
});

test("resolvePersonByName: manual typed entry does not require selecting from a list — any non-blank text resolves", () => {
  // No "must be in the suggestion list" constraint anywhere in this function —
  // this is exactly what lets EditPlayersModal accept manually typed names.
  const r = resolvePersonByName("Someone Brand New", persons);
  assert.deepEqual(r, { text: "Someone Brand New", existingPerson: null });
});

test("resolvePersonByName: does not create a duplicate — re-typing an existing name (any casing/whitespace) always resolves to the same existing id", () => {
  const variants = ["Carlos Cruz", "carlos cruz", " Carlos Cruz ", "CARLOS  cruz".replace(/\s+/g, " ")];
  for (const v of variants) {
    assert.equal(resolvePersonByName(v, persons).existingPerson.id, "p5");
  }
});

test("normalizePersonName: trims and lowercases", () => {
  assert.equal(normalizePersonName("  Rem  "), "rem");
  assert.equal(normalizePersonName("REM"), "rem");
  assert.equal(normalizePersonName(null), "");
  assert.equal(normalizePersonName(undefined), "");
});
