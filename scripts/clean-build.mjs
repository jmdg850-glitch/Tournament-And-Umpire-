// Removes generated build OUTPUT only (dist/release/APK dirs) — never
// node_modules, never source, never the Gradle cache (.gradle is left alone
// deliberately, to keep incremental Android builds fast). Never called
// automatically by build:apps, build:all, release, or tests.
import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { assertRepoRoot } from "./lib/repoGuard.mjs";

let root;
try {
  root = assertRepoRoot();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Explicit allowlist — generated OUTPUT dirs only. Intentionally excludes
// apps/umpire/android/.gradle (build cache, not output) and node_modules
// (that's reset-dependencies.mjs's job, not this script's).
const REMOVABLE = [
  resolve(root, "apps/operator/dist"),
  resolve(root, "apps/operator/release"),
  resolve(root, "apps/umpire/dist"),
  resolve(root, "apps/umpire/android/app/build"),
  resolve(root, "apps/umpire/android/build"),
];

const PROTECTED = [
  resolve(root, "apps/operator/src"),
  resolve(root, "apps/umpire/src"),
  resolve(root, "packages"),
  resolve(root, "supabase/migrations"),
  resolve(root, "package.json"),
  resolve(root, "package-lock.json"),
  resolve(root, "node_modules"),
  resolve(root, "apps/umpire/android/keystore.properties"),
  resolve(root, "apps/umpire/android/keystores"),
  resolve(root, "apps/umpire/android/.gradle"),
];

for (const removable of REMOVABLE) {
  for (const protectedPath of PROTECTED) {
    if (protectedPath === removable || protectedPath.startsWith(removable + sep)) {
      console.error(`Refusing to proceed: protected path ${protectedPath} is inside removable path ${removable}. Aborting.`);
      process.exit(1);
    }
  }
}

console.log("Paths that will be removed (if present):");
const toRemove = REMOVABLE.filter((p) => existsSync(p));
if (toRemove.length === 0) {
  console.log("  (none exist — nothing to remove)");
} else {
  for (const p of toRemove) console.log(`  ${p}`);
}

for (const p of toRemove) {
  console.log(`Removing ${p} ...`);
  rmSync(p, { recursive: true, force: true });
}

console.log("\nGenerated build output cleared. node_modules and Gradle cache were not touched.");
