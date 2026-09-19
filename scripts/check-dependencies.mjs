// Non-destructive dependency health check. Never installs or deletes anything.
// Used standalone (`npm run check:dependencies`) and by build-all.mjs as the
// first gate: if this fails, build-all aborts and tells you to run
// `npm run reset:dependencies` — it never installs anything on your behalf.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib/repoGuard.mjs";

const root = repoRoot();
const nodeModules = resolve(root, "node_modules");

const REQUIRED_PACKAGES = ["vite", "vitest", "electron"];
const REQUIRED_WORKSPACES = ["client", "api", "engine", "ui"];

export function checkDependencies() {
  const problems = [];

  if (!existsSync(nodeModules)) {
    problems.push("node_modules does not exist.");
    return { ok: false, problems };
  }

  if (!existsSync(resolve(nodeModules, ".package-lock.json"))) {
    problems.push("node_modules/.package-lock.json is missing — npm never finished reconciling the last install (interrupted/incomplete npm ci).");
  }

  for (const pkg of REQUIRED_PACKAGES) {
    if (!existsSync(resolve(nodeModules, pkg, "package.json"))) {
      problems.push(`Required package "${pkg}" is missing from node_modules.`);
    }
  }

  for (const ws of REQUIRED_WORKSPACES) {
    if (!existsSync(resolve(nodeModules, "@tournament", ws))) {
      problems.push(`Workspace link node_modules/@tournament/${ws} is missing.`);
    }
  }

  return { ok: problems.length === 0, problems };
}

// Only run as a CLI report when invoked directly (`npm run check:dependencies`);
// when imported by build-all.mjs, only checkDependencies() is used.
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] || "")) {
  const { ok, problems } = checkDependencies();
  if (ok) {
    console.log("Dependencies OK — node_modules is healthy.");
    process.exit(0);
  }
  console.log("Dependency check FAILED:");
  for (const p of problems) console.log(`  - ${p}`);
  console.log("\nDo not delete node_modules manually. Run: npm run reset:dependencies");
  process.exit(1);
}
