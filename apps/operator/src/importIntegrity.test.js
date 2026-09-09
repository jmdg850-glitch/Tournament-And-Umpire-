// A cheap static guard against a real production incident: a JSX component
// used without being imported/declared compiles and bundles fine (nothing in
// this toolchain statically checks identifier existence for JSX), but throws
// "Element type is invalid: ...got: undefined" at render time. That's exactly
// what happened in App.jsx — <Card> was used in the dashboard's "Recent
// activity" panel without ever being imported from @tournament/ui. It only
// executed once the post-login dashboard data finished loading, so the app
// built successfully and the crash only appeared as a white screen right
// after a real login — see the incident this test was added for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));

function declaredIdentifiers(source) {
  const names = new Set();
  // import { A, B as C } from "..."  (covers `import Default, { A, B }` too)
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from/g)) {
    for (const part of m[1].split(",")) {
      const name = part.split(" as ").pop().trim();
      if (name) names.add(name);
    }
  }
  // import Default from "..."  /  import Default, { ... } from "..."
  for (const m of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) {
    names.add(m[1]);
  }
  // top-level function/class/const declarations (with or without export/default)
  for (const m of source.matchAll(/^(?:export\s+)?(?:default\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of source.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/gm)) {
    names.add(m[1]);
  }
  return names;
}

function jsxTagsUsed(source) {
  const tags = new Set();
  for (const m of source.matchAll(/<([A-Z][\w.]*)/g)) {
    tags.add(m[1].split(".")[0]);
  }
  return tags;
}

function assertNoUndeclaredJsxTags(filePath) {
  const source = readFileSync(filePath, "utf8");
  const declared = declaredIdentifiers(source);
  const used = jsxTagsUsed(source);
  const missing = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(
    missing,
    [],
    `Undeclared JSX component(s) in ${filePath}: ${missing.join(", ")} — this builds fine but crashes at render time (missing import)`
  );
}

test("App.jsx never renders a JSX component that isn't imported/declared", () => {
  assertNoUndeclaredJsxTags(resolve(dir, "App.jsx"));
});

test("TournamentDesk.jsx never renders a JSX component that isn't imported/declared", () => {
  assertNoUndeclaredJsxTags(resolve(dir, "TournamentDesk.jsx"));
});

test("brackets.jsx never renders a JSX component that isn't imported/declared", () => {
  assertNoUndeclaredJsxTags(resolve(dir, "brackets.jsx"));
});

test("BracketImportModal.jsx never renders a JSX component that isn't imported/declared", () => {
  assertNoUndeclaredJsxTags(resolve(dir, "BracketImportModal.jsx"));
});
