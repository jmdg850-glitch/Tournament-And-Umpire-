// The ONLY sanctioned way to delete node_modules and reinstall in this repo.
// Never called automatically by build:apps, build:all, release, or tests —
// invoke it by hand only when check-dependencies.mjs reports a genuinely
// corrupted install. See docs/BUILD_WORKFLOW.md.
import { existsSync, openSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { assertRepoRoot } from "./lib/repoGuard.mjs";
import { checkDependencies } from "./check-dependencies.mjs";

function header(title) {
  console.log(`\n--- ${title} ---`);
}

let root;
try {
  root = assertRepoRoot();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Explicit allowlist — nothing outside these two paths is ever touched.
const REMOVABLE = [
  resolve(root, "node_modules"),
  resolve(root, "node_modules.broken"),
];

// Paths that must exist before AND after this script runs. If any of these
// would be affected by the allowlist above (they can't be, by construction,
// but this is the explicit safety net the workflow calls for), abort instead
// of deleting anything.
const PROTECTED = [
  resolve(root, "apps/operator/src"),
  resolve(root, "apps/umpire/src"),
  resolve(root, "packages"),
  resolve(root, "supabase/migrations"),
  resolve(root, "package.json"),
  resolve(root, "package-lock.json"),
  resolve(root, "apps/umpire/android"),
  resolve(root, "apps/umpire/android/keystore.properties"),
  resolve(root, "apps/umpire/android/keystores"),
];

header("Repository root");
console.log(root);

header("Paths that will be removed (if present)");
const toRemove = REMOVABLE.filter((p) => existsSync(p));
if (toRemove.length === 0) {
  console.log("(none exist — nothing to remove)");
} else {
  for (const p of toRemove) console.log(`  ${p}`);
}

header("Protected paths (must remain untouched)");
const missingProtected = [];
for (const p of PROTECTED) {
  const exists = existsSync(p);
  console.log(`  [${exists ? "OK" : "MISSING"}] ${p}`);
  if (!exists) missingProtected.push(p);
}
if (missingProtected.length) {
  console.error("\nRefusing to proceed: protected path(s) missing BEFORE any deletion — this is not a dependency problem, stopping without touching anything:");
  for (const p of missingProtected) console.error(`  ${p}`);
  process.exit(1);
}
for (const removable of REMOVABLE) {
  for (const protectedPath of PROTECTED) {
    if (protectedPath === removable || protectedPath.startsWith(removable + sep)) {
      console.error(`\nRefusing to proceed: protected path ${protectedPath} is inside removable path ${removable}. Aborting.`);
      process.exit(1);
    }
  }
}

header("Deleting");
for (const p of toRemove) {
  console.log(`Removing ${p} ...`);
  try {
    rmSync(p, { recursive: true, force: true });
    console.log("  done.");
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    console.error("This looks like the Windows filesystem/AV lock. Do not retry this in a loop — close any process holding a handle in node_modules (editors, terminals, antivirus scan) and rerun.");
    process.exit(1);
  }
}

header("Protected paths after deletion (re-verified)");
for (const p of PROTECTED) {
  const exists = existsSync(p);
  console.log(`  [${exists ? "OK" : "MISSING"}] ${p}`);
  if (!exists) {
    console.error(`\nFATAL: protected path ${p} is missing after deletion. Stop and investigate — do not run npm ci.`);
    process.exit(1);
  }
}

header("npm ci (single run, output captured to npm-ci-install.log)");
const logPath = resolve(root, "npm-ci-install.log");
const fd = openSync(logPath, "w");
console.log(`Log: ${logPath}`);
console.log("Running now — this can take a while on first install; monitor npm-ci-install.log separately if needed.");
const startedAt = Date.now();
const result = spawnSync("npm", ["ci"], {
  cwd: root,
  stdio: ["ignore", fd, fd],
  // npm on Windows is npm.cmd, not a directly-executable binary — spawnSync
  // requires shell:true for that (shell:false fails with EINVAL), same as
  // every other npm invocation in this repo's scripts (see lib/buildVerify.mjs's run()).
  shell: process.platform === "win32",
});
const durationSec = Math.round((Date.now() - startedAt) / 1000);

if (result.error) {
  console.error(`npm ci could not be started: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`npm ci exited with code ${result.status} after ${durationSec}s. See ${logPath} for details.`);
  process.exit(result.status ?? 1);
}
console.log(`npm ci finished in ${durationSec}s.`);

header("Post-install health check");
const health = checkDependencies();
if (!health.ok) {
  console.error("npm ci exited 0 but the dependency tree still looks unhealthy:");
  for (const p of health.problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log("Dependencies OK.");
console.log("\nDependency recovery complete. Resume normal development with: npm run build:all");
