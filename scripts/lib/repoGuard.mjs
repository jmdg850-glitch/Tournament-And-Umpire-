// Safety guard for destructive scripts (reset-dependencies.mjs, clean-build.mjs).
// Resolves the repo root from THIS file's own location rather than a hardcoded
// drive letter — this repo has already moved drives once (E: -> H:) during
// development, so anchoring to a literal path would itself be fragile. Instead
// this confirms the resolved root actually looks like the Tournament monorepo
// before any destructive script is allowed to touch it.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot() {
  return resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
}

// Throws with a clear message instead of returning false, so every caller's
// failure mode is "refuse to run" by construction, not "forgot to check".
export function assertRepoRoot() {
  const root = repoRoot();
  const pkgPath = resolve(root, "package.json");
  if (!existsSync(pkgPath)) {
    throw new Error(`Refusing to run: no package.json found at resolved repo root ${root}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (err) {
    throw new Error(`Refusing to run: could not parse ${pkgPath}: ${err.message}`);
  }
  if (pkg.name !== "tournament" || !Array.isArray(pkg.workspaces) || !pkg.workspaces.includes("packages/*") || !pkg.workspaces.includes("apps/*")) {
    throw new Error(`Refusing to run: ${pkgPath} does not look like the Tournament monorepo root (name/workspaces mismatch).`);
  }
  if (!existsSync(resolve(root, "docs/CLAUDE_PROJECT_CONTEXT.md"))) {
    throw new Error(`Refusing to run: docs/CLAUDE_PROJECT_CONTEXT.md not found under resolved repo root ${root}.`);
  }
  if (!existsSync(resolve(root, ".git"))) {
    throw new Error(`Refusing to run: ${root} is not a git repository root (no .git).`);
  }
  return root;
}
