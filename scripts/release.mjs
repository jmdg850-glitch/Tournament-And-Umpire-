// One-command production release pipeline for Tournament Operator (Windows)
// and Tournament Umpire (Android). Invoke via `npm run release` (patch bump)
// or `npm run release -- minor` / `npm run release -- major`.
//
// Any working-tree change under a recognized Tournament source root (apps/,
// packages/, scripts/, docs/, supabase/ minus its legacy subpaths) or one of
// the named root files (package.json, package-lock.json, CLAUDE.md) is
// auto-included — see isReleasableSourcePath() below. No --allow= is needed
// for ordinary Tournament development. --allow= remains available for
// genuine exceptions (a path outside those roots that really belongs in this
// release).
//
//   npm run release -- --preflight-only        run every preflight check, change nothing
//   npm run release -- --allow=<path-or-dir/>  explicitly allow one more dirty path
//                                              (or directory prefix ending in "/") to be
//                                              committed with this release; repeatable
//
// Order: PREFLIGHT (nothing is modified until every check passes) -> version
// bump -> Windows build -> Android build -> verify both -> commit (explicit
// allowlist only) -> push -> publish GitHub release -> verify the release.
// Any failing step stops the pipeline and reports which stage failed and what
// state the repo is in — see fail() below. The Android APK is built and
// verified locally only; nothing here uploads it anywhere.
//
// Nothing here bypasses the existing build, test, or publish tooling; it
// orchestrates the same npm scripts a human would run by hand (see
// apps/operator/package.json, apps/umpire/package.json,
// scripts/publish-desktop-update.mjs). It never force-pushes and never
// overwrites an existing tag or release.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  run,
  runCapture,
  tryCapture,
  findJavaHome,
  findAndroidSdk,
  findLatestBuildTools,
  verifyWindowsInstaller,
  verifyAndroidApk,
} from "./lib/buildVerify.mjs";
import { assertRepoRoot } from "./lib/repoGuard.mjs";
import { checkDependencies } from "./check-dependencies.mjs";

let root;
try {
  root = assertRepoRoot();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const operatorDir = resolve(root, "apps/operator");
const umpireDir = resolve(root, "apps/umpire");
const androidDir = resolve(umpireDir, "android");
// Kept inside node_modules (gitignored, always present once `npm install` has
// run) rather than at the repo root, so the lock file itself never shows up
// as an untracked path in `git status` while a release is running.
const lockPath = resolve(root, "node_modules/.release.lock");
const commitMsgPath = resolve(root, "node_modules/.release-commit-msg.txt");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const BUMP_TYPES = ["patch", "minor", "major"];
const positional = [];
const flags = { preflightOnly: false, allow: [] };
for (const arg of process.argv.slice(2)) {
  if (arg === "--preflight-only") flags.preflightOnly = true;
  else if (arg.startsWith("--allow=")) flags.allow.push(arg.slice("--allow=".length));
  else if (arg.startsWith("--")) {
    console.error(`Unknown option "${arg}". Supported: --preflight-only, --allow=<path>.`);
    process.exit(1);
  } else positional.push(arg);
}
if (positional.length > 1) {
  console.error(`Expected at most one bump type, got: ${positional.join(" ")}`);
  process.exit(1);
}
const bumpType = (positional[0] || "patch").toLowerCase();
if (!BUMP_TYPES.includes(bumpType)) {
  console.error(`Unknown bump type "${bumpType}". Use one of: ${BUMP_TYPES.join(", ")}.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// What a release is allowed to touch
// ---------------------------------------------------------------------------
// Files this script rewrites itself (the version bump). They must be clean
// before the release starts so the bump can never be mixed with unrelated edits.
const VERSION_FILES = [
  "apps/operator/package.json",
  "apps/umpire/package.json",
  "apps/umpire/android/app/build.gradle",
];
// Release-tooling files that may be dirty when a release starts and are then
// committed with it: the release script itself and the files it imports/invokes.
// Anything else that is dirty (build-all, clean-build, reset-dependencies,
// docs, root package.json, app source ...) makes the release refuse to run
// unless it is committed separately first or passed explicitly via --allow=.
const RELEASE_TOOLING_FILES = [
  "scripts/release.mjs",
  "scripts/publish-desktop-update.mjs",
  "scripts/check-dependencies.mjs",
  "scripts/lib/buildVerify.mjs",
  "scripts/lib/repoGuard.mjs",
];
const SUSPICIOUS_PATTERNS = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(pem|p12|pfx|p8|cer|jks|keystore)$/i,
  /(^|[\\/])keystore\.properties$/i,
  /(^|[\\/])local\.properties$/i,
  /credentials?/i,
  /secret/i,
  /\.git-credentials$/i,
  /id_rsa/i,
];
const isSuspicious = (path) => !/\.env\.example$/i.test(path) && SUSPICIOUS_PATTERNS.some((re) => re.test(path));

// ---------------------------------------------------------------------------
// Auto-detected source changes — so ordinary Tournament development never
// needs --allow=. This is additive to RELEASE_TOOLING_FILES/--allow= above,
// not a replacement: those still work for genuine one-off exceptions.
//
// Design: allow-by-recognized-active-source-root, then deny specific known
// legacy/generated/machine-specific paths within it. Prefix-based (not a
// per-file list), so a brand-new file under an allowed root is automatically
// covered without editing this script again.
//
// Most junk categories (node_modules, dist, release, .gradle, Android build/,
// local.properties, keystores, *.apk/*.aab, *.log, IDE/OS files) are already
// invisible to `git status` via .gitignore (root and
// apps/umpire/android/.gitignore, an Android-template gitignore) — this list
// is defense in depth, making that guarantee explicit here too rather than
// relying solely on .gitignore staying correct.
// ---------------------------------------------------------------------------
const ALLOWED_SOURCE_ROOTS = ["apps/", "packages/", "scripts/", "docs/", "supabase/"];
// Named exceptions only — never a wildcard for "any root file". Each entry
// here is a specific, tracked, non-sensitive project file; everything else at
// the repo root still needs --allow= or a separate commit. Still subject to
// isSuspicious() like any other path (see the sensitive-path check above).
const ALLOWED_ROOT_FILES = ["package.json", "package-lock.json", "CLAUDE.md"];

// CLAUDE.md §7 — legacy PickleLive material that must never be swept into a
// release automatically, even though it's real tracked source.
const LEGACY_PROTECTED_PATHS = [
  "src/", "index.html", "vite.config.js", "legacy/",
  "supabase/migrations-applied/",
  "supabase/functions/submit-match/", "supabase/functions/dupr-webhook-receiver/",
  "supabase/functions/link-dupr-account/", "supabase/functions/_shared/",
];

const GENERATED_OUTPUT_PATHS = [
  "dist/", "dist-slim/", "dist-ssr/", "release/", "node_modules/", "node_modules.broken/",
  "apps/operator/dist/", "apps/operator/release/", "apps/umpire/dist/",
  "apps/umpire/android/.gradle/", "apps/umpire/android/build/", "apps/umpire/android/app/build/",
  "apps/umpire/android/capacitor-cordova-android-plugins/",
  "apps/umpire/android/app/src/main/assets/public/",
  ".gradle/", ".turbo/", ".cache/", "coverage/",
];
const GENERATED_FILE_PATTERN = /\.(apk|aab|aar|ap_|dex|class|exe|msi|dll|blockmap|hprof|log)$/i;
const MACHINE_OR_IDE_JUNK = [".vscode/", ".idea/", "local.properties", ".DS_Store", "Thumbs.db", "desktop.ini"];

function startsWithAny(p, prefixes) {
  return prefixes.some((d) => p === d.replace(/\/$/, "") || p.startsWith(d));
}

function isReleasableSourcePath(p) {
  const underRoot = ALLOWED_ROOT_FILES.includes(p) || ALLOWED_SOURCE_ROOTS.some((r) => p.startsWith(r));
  if (!underRoot) return false;
  if (startsWithAny(p, LEGACY_PROTECTED_PATHS)) return false;
  if (startsWithAny(p, GENERATED_OUTPUT_PATHS)) return false;
  if (GENERATED_FILE_PATTERN.test(p)) return false;
  if (startsWithAny(p, MACHINE_OR_IDE_JUNK)) return false;
  return true;
}

const allowedFiles = new Set(RELEASE_TOOLING_FILES);
const allowedDirs = [];
for (const raw of flags.allow) {
  const p = String(raw).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!/^[A-Za-z0-9._\-/]+$/.test(p) || p.startsWith("/") || p.split("/").includes("..") || p === "." || p === "") {
    console.error(`Invalid --allow value "${raw}": use a repo-relative file path, or a directory path ending in "/" (letters, digits, . _ - / only).`);
    process.exit(1);
  }
  if (VERSION_FILES.includes(p)) {
    console.error(`--allow=${p}: version files are rewritten by the release itself and must be clean beforehand; they cannot be allowed as pre-existing changes.`);
    process.exit(1);
  }
  if (isSuspicious(p)) {
    console.error(`--allow=${p}: refusing — this path looks sensitive (env/key/credential material).`);
    process.exit(1);
  }
  if (p.endsWith("/")) allowedDirs.push(p);
  else allowedFiles.add(p);
}
const isAllowedPath = (p) => allowedFiles.has(p) || allowedDirs.some((d) => p.startsWith(d)) || isReleasableSourcePath(p);
// A rename is only in-bounds when BOTH sides of it are — moving a file INTO
// or OUT OF a protected/legacy/generated path is still unexpected even if
// the other side looks fine.
const isAllowedEntry = (e) => isAllowedPath(e.path) && (!e.renamedFrom || isAllowedPath(e.renamedFrom));

// ---------------------------------------------------------------------------
// State tracking + failure handling
// ---------------------------------------------------------------------------
const startedAt = Date.now();
let stage = "preflight";
const state = {
  baseSha: null,
  versionsBumped: false,
  releaseDirCleanupStarted: false,
  buildsStarted: false,
  committed: false,
  commitHash: null,
  pushed: false,
  ghReleaseStarted: false,
  tag: null,
  releaseSlug: null,
};
// Files the bump wrote, kept so a failure BEFORE the commit can put them back.
const bumpedFiles = [];
let lockOwned = false;
let failing = false;

function logStep(name) {
  console.log(`\n--- ${name} ---`);
}

function releaseUnlock() {
  if (!lockOwned) return; // never remove a lock that another running release holds
  try { unlinkSync(lockPath); } catch { /* already gone */ }
  lockOwned = false;
}

function acquireLock() {
  if (existsSync(lockPath)) {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; }
    }
    if (alive) {
      console.error("Release already in progress.");
      console.error(`Lock held by running pid ${pid} (${lockPath}).`);
      console.error("If that process is not actually a release (recycled pid), delete the lock file and retry.");
      process.exit(1);
    }
    console.log(`Removing stale release lock (pid ${Number.isInteger(pid) ? pid : "unknown"} is not running).`);
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, String(process.pid), { flag: "wx" });
  lockOwned = true;
}

// Put the three version files back exactly as they were, but only if they still
// contain exactly what the bump wrote (never clobber anything else). Only ever
// used while nothing has been committed. Returns human-readable result lines.
function restoreVersionFiles() {
  const lines = [];
  for (const f of bumpedFiles) {
    try {
      const current = readFileSync(f.path, "utf8");
      if (current === f.original) lines.push(`  ${f.rel}: unchanged`);
      else if (current === f.written) {
        writeFileSync(f.path, f.original);
        lines.push(`  ${f.rel}: restored to its pre-release contents`);
      } else lines.push(`  ${f.rel}: LEFT AS-IS (contents differ from what the bump wrote — restore it manually)`);
    } catch (err) {
      lines.push(`  ${f.rel}: could not be restored (${err.message})`);
    }
  }
  return lines;
}

function describeState() {
  const lines = [];
  if (!state.versionsBumped) {
    lines.push("Version files: NOT modified.");
  } else if (!state.committed) {
    lines.push("Version files were bumped and NOT committed. Automatic restore:");
    lines.push(...restoreVersionFiles());
  } else {
    lines.push(`Version files were bumped and committed (${state.commitHash}).`);
  }
  if (state.releaseDirCleanupStarted) {
    lines.push("apps/operator/release/ WAS cleaned by the Windows build step; its contents may be missing or from a failed build.");
  } else {
    lines.push("apps/operator/release/: untouched.");
  }
  lines.push(state.committed ? `Commit: ${state.commitHash} exists locally.` : "Commit: none created.");
  lines.push(state.pushed ? "Push: origin/main was updated." : "Push: nothing pushed.");
  if (state.ghReleaseStarted) {
    lines.push(`GitHub release ${state.tag} on ${state.releaseSlug}: state UNCONFIRMED — a draft or published release may exist. Check: gh release view ${state.tag} --repo ${state.releaseSlug}`);
  } else {
    lines.push("GitHub release: none created.");
  }
  if (state.committed && !state.pushed) {
    lines.push("Recovery: inspect the commit (git show --stat HEAD), then either `git push origin main` (never force-push) or undo it with `git reset --soft HEAD~1`.");
  } else if (state.pushed) {
    lines.push(`Recovery: the source commit is already on origin/main. Do NOT re-run \`npm run release\` (it would bump again). Fix the cause, then publish only the Windows update with: npm run publish:desktop -w @tournament/operator`);
  } else if (state.versionsBumped || state.releaseDirCleanupStarted) {
    lines.push("Recovery: fix the cause and re-run the release; run `npm run release -- --preflight-only` first to re-check.");
  } else {
    lines.push("Recovery: fix the reported problem and re-run.");
  }
  return lines;
}

function fail(step, reason) {
  if (failing) process.exit(1);
  failing = true;
  const details = describeState();
  releaseUnlock();
  console.log(`
========================================
RELEASE FAILED
==============

Stage:
${stage}

Step:
${step}

Reason:
${reason}

State:
${details.map((l) => (l.startsWith("  ") ? l : `- ${l}`)).join("\n")}

${state.ghReleaseStarted ? "GitHub release NOT confirmed — verify manually before assuming anything was published." : "NO release published."}
========================================`);
  process.exit(1);
}

process.on("exit", releaseUnlock);
process.on("SIGINT", () => fail("Interrupted", "Received SIGINT (Ctrl+C)."));
process.on("SIGTERM", () => fail("Interrupted", "Received SIGTERM."));
process.on("uncaughtException", (err) => fail("Unexpected error", err?.stack || String(err)));
process.on("unhandledRejection", (err) => fail("Unexpected error", err?.stack || String(err)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const git = (args, opts = {}) => runCapture("git", args, { cwd: root, ...opts });
const errText = (res) => String(res.error?.stderr || res.error?.stdout || res.error?.message || "").trim();

function bumpVersion(version, type) {
  const parts = String(version).split(".").map((n) => Number.parseInt(n, 10));
  const [major, minor, patch] = [parts[0] || 0, parts[1] || 0, parts[2] || 0];
  if (type === "major") return `${major + 1}.0.0`;
  if (type === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
function readPackageVersion(pkgPath) {
  const raw = readFileSync(pkgPath, "utf8");
  const match = raw.match(/"version":\s*"([^"]+)"/);
  if (!match) throw new Error(`Could not find a "version" field in ${pkgPath}`);
  return match[1];
}

// The specific field(s) inside a VERSION_FILES entry that the release itself
// owns — as opposed to the rest of the file (scripts, deps, other JSON keys),
// which is ordinary source content and may legitimately be dirty going into a
// release (e.g. a new test script). Returns a stable string so two extracts
// can be compared with ===.
function protectedVersionFieldsOf(rel, raw) {
  if (rel === "apps/umpire/android/app/build.gradle") {
    const code = raw.match(/versionCode\s+(\d+)/);
    const name = raw.match(/versionName\s+"([^"]+)"/);
    return `versionCode=${code ? code[1] : "<missing>"} versionName=${name ? name[1] : "<missing>"}`;
  }
  const match = raw.match(/"version":\s*"([^"]+)"/);
  return `version=${match ? match[1] : "<missing>"}`;
}

// True if a dirty VERSION_FILES entry's protected field(s) differ from what's
// committed at HEAD — i.e. someone hand-edited the version instead of letting
// the release bump it. Unrelated edits to the same file (scripts, deps, ...)
// do not trip this.
function protectedVersionFieldChanged(rel) {
  const headRaw = git(["show", `HEAD:${rel}`]);
  const workingRaw = readFileSync(resolve(root, rel), "utf8");
  return protectedVersionFieldsOf(rel, headRaw) !== protectedVersionFieldsOf(rel, workingRaw);
}

// `git status --porcelain=v1 -z`: NUL-separated, never quoted, untracked
// directories expanded to individual files. A rename/copy entry is followed by
// an extra NUL field holding the original path.
function readWorkingTree() {
  const raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = raw.split("\0").filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const path = parts[i].slice(3);
    let renamedFrom = null;
    if (/[RC]/.test(code)) renamedFrom = parts[++i] ?? null;
    entries.push({ code, path, renamedFrom });
  }
  return entries;
}

function parseGitHubRemote(url) {
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Verify only — this script no longer switches the machine's active gh account.
function ghActiveLogin() {
  const res = tryCapture("gh", ["api", "user", "--jq", ".login"]);
  if (!res.ok) throw new Error(`gh is not authenticated (${errText(res) || "gh api user failed"}). Run: gh auth login`);
  return res.output.trim();
}
function assertGhAccountMatches(owner) {
  const login = ghActiveLogin();
  if (login.toLowerCase() !== String(owner).toLowerCase()) {
    throw new Error(`Active gh account is "${login}" but the repository owner is "${owner}". Run: gh auth switch --user ${owner} --hostname github.com (this script does not switch accounts for you).`);
  }
  return login;
}

// Throws if the tag/release exists anywhere we can see, OR if existence could
// not be determined (a network failure must never read as "does not exist").
function assertReleaseTargetFree(tag, originSlug, releaseSlug) {
  const local = git(["tag", "--list", tag]).trim();
  if (local) throw new Error(`Local git tag ${tag} already exists.`);

  const originTags = tryCapture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], { cwd: root });
  if (!originTags.ok) throw new Error(`Could not query origin tags: ${errText(originTags)}`);
  if (originTags.output.trim()) throw new Error(`Tag ${tag} already exists on origin.`);

  const refs = tryCapture("gh", ["api", `repos/${releaseSlug}/git/matching-refs/tags/${tag}`, "--jq", `[.[] | select(.ref == "refs/tags/${tag}")] | length`]);
  if (!refs.ok) throw new Error(`Could not query tags on ${releaseSlug}: ${errText(refs)}`);
  if (refs.output.trim() !== "0") throw new Error(`Tag ${tag} already exists on ${releaseSlug}.`);

  // stderr is captured (not inherited): "release not found" is the expected answer here.
  const view = tryCapture("gh", ["release", "view", tag, "--repo", releaseSlug, "--json", "tagName,isDraft"], { stdio: ["ignore", "pipe", "pipe"] });
  if (view.ok) throw new Error(`A GitHub release for ${tag} already exists on ${releaseSlug} (${view.output.trim()}).`);
  if (!/release not found/i.test(errText(view))) {
    throw new Error(`Could not determine whether release ${tag} exists on ${releaseSlug}: ${errText(view)}`);
  }
  return `${tag} not found locally, on origin, or as a release on ${releaseSlug}`;
}

function parseProperties(text) {
  const props = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    const i = t.indexOf("=");
    if (i > 0) props[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return props;
}

const sha256OfFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---------------------------------------------------------------------------
// 0. Lock
// ---------------------------------------------------------------------------
acquireLock();

// ---------------------------------------------------------------------------
// 1. PREFLIGHT — read-only. Nothing below this block modifies a version file,
//    deletes apps/operator/release/, builds, commits, pushes, or publishes
//    until every check has passed.
// ---------------------------------------------------------------------------
const ctx = {};
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    fail(`Preflight: ${name}`, err.message);
  }
}

logStep("Preflight (read-only)");

// Working-tree gate first: cheapest check, and the one most likely to fail.
const initialEntries = readWorkingTree();
if (initialEntries.length === 0) {
  releaseUnlock();
  console.log("No changes in the working tree — release skipped. (Commit the source changes to ship first if they are not committed yet, or pass them via --allow=.)");
  process.exit(0);
}

check("Git branch is main", () => {
  const branch = git(["branch", "--show-current"]).trim();
  if (branch !== "main") throw new Error(`On branch "${branch || "(detached HEAD)"}", but this release pushes to origin main. Switch to main first.`);
  state.baseSha = git(["rev-parse", "HEAD"]).trim();
  return `HEAD ${state.baseSha.slice(0, 7)}`;
});

check("No merge/rebase/cherry-pick in progress", () => {
  const gitDir = resolve(root, ".git");
  const busy = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"].filter((n) => existsSync(resolve(gitDir, n)));
  if (busy.length) throw new Error(`Git operation in progress (${busy.join(", ")}). Finish or abort it first.`);
});

check("Nothing is pre-staged", () => {
  const staged = git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  if (staged.length) throw new Error(`Index already contains staged changes:\n${staged.map((p) => `  ${p}`).join("\n")}\nUnstage them (git restore --staged <path>) so the release commit contains only what it stages itself.`);
});

check("Working tree contains only changes allowed for this release", () => {
  console.log(`         ${initialEntries.length} changed path(s):`);
  for (const e of initialEntries) console.log(`           ${e.code} ${e.path}${e.renamedFrom ? ` (from ${e.renamedFrom})` : ""}`);
  const sensitive = initialEntries.filter((e) => isSuspicious(e.path));
  if (sensitive.length) throw new Error(`Sensitive-looking path(s) — refusing to commit:\n${sensitive.map((e) => `  ${e.path}`).join("\n")}`);
  // VERSION_FILES may be dirty going in for reasons unrelated to the version
  // itself (new scripts, deps, licensing changes, ...) — the release rewrites
  // only the version field(s), so only a manual edit to those specific fields
  // is rejected here. Everything else in the file is ordinary source content,
  // checked like any other path below.
  const versionDirty = initialEntries.filter((e) => VERSION_FILES.includes(e.path));
  const versionFieldEdited = versionDirty.filter((e) => {
    if (e.code === "??" || /^A/.test(e.code)) throw new Error(`${e.path} is untracked/newly added — this is one of the release's own version files and must already be tracked with committed history.`);
    if (e.renamedFrom) throw new Error(`${e.path} was renamed (from ${e.renamedFrom}) — this is one of the release's own version files and must not be renamed.`);
    try {
      return protectedVersionFieldChanged(e.path);
    } catch (err) {
      throw new Error(`Could not read the committed version field of ${e.path} to compare against the working tree: ${err.message}`);
    }
  });
  if (versionFieldEdited.length) {
    throw new Error(
      `Version field manually changed in protected file(s):\n${versionFieldEdited.map((e) => `  ${e.path}`).join("\n")}\n` +
        "The release bumps these itself; revert the version (and, for the Android file, versionCode/versionName) field(s) before running it. Other edits in the same file (scripts, dependencies, etc.) are fine and do not need to be reverted."
    );
  }
  const unexpected = initialEntries.filter((e) => !isAllowedEntry(e));
  if (unexpected.length) {
    throw new Error(
      `Unexpected change(s) that this release is not allowed to commit:\n${unexpected.map((e) => `  ${e.code} ${e.path}${e.renamedFrom ? ` (from ${e.renamedFrom})` : ""}`).join("\n")}\n` +
        `This path is outside the recognized Tournament source tree (${ALLOWED_SOURCE_ROOTS.join(", ")}${ALLOWED_ROOT_FILES.length ? `, or one of: ${ALLOWED_ROOT_FILES.join(", ")}` : ""}), or matches a protected/legacy/generated pattern this release never auto-includes.\n` +
        "Commit or stash it separately first, or — if it really belongs in this release — pass it explicitly with --allow=<path> (or --allow=<dir/>)."
    );
  }
  return "all changes are auto-included source, or on the explicit allowlist";
});

check("Version files are consistent", () => {
  const operatorPkgPath = resolve(operatorDir, "package.json");
  const umpirePkgPath = resolve(umpireDir, "package.json");
  const gradlePath = resolve(androidDir, "app/build.gradle");
  ctx.currentOperator = readPackageVersion(operatorPkgPath);
  ctx.currentUmpire = readPackageVersion(umpirePkgPath);
  const gradleRaw = readFileSync(gradlePath, "utf8");
  const code = gradleRaw.match(/versionCode\s+(\d+)/);
  const name = gradleRaw.match(/versionName\s+"([^"]+)"/);
  if (!code) throw new Error(`Could not find versionCode in ${gradlePath}`);
  if (!name) throw new Error(`Could not find versionName in ${gradlePath}`);
  if (name[1] !== ctx.currentUmpire) throw new Error(`Android versionName (${name[1]}) != Umpire package.json (${ctx.currentUmpire}) — fix before releasing.`);
  ctx.currentVersionCode = Number.parseInt(code[1], 10);
  ctx.nextOperator = bumpVersion(ctx.currentOperator, bumpType);
  ctx.nextUmpire = bumpVersion(ctx.currentUmpire, bumpType);
  ctx.nextVersionCode = ctx.currentVersionCode + 1;
  state.tag = `v${ctx.nextOperator}`;
  return `Operator ${ctx.currentOperator} -> ${ctx.nextOperator}, Umpire ${ctx.currentUmpire} -> ${ctx.nextUmpire}, versionCode ${ctx.currentVersionCode} -> ${ctx.nextVersionCode}`;
});

check("Dependency health", () => {
  const health = checkDependencies();
  if (!health.ok) throw new Error(`node_modules is not healthy:\n${health.problems.map((p) => `  - ${p}`).join("\n")}\nThis release never installs or resets dependencies. See docs/BUILD_WORKFLOW.md.`);
  return "node_modules healthy";
});

check("Node, npm, git and gh are available", () => {
  const need = Number.parseInt(String(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).engines?.node || "").match(/(\d+)/)?.[1] || "0", 10);
  const have = Number.parseInt(process.versions.node, 10);
  if (have < need) throw new Error(`Node ${process.versions.node} is older than the required >=${need}.`);
  const npm = process.platform === "win32" ? tryCapture("cmd.exe", ["/d", "/c", "npm --version"]) : tryCapture("npm", ["--version"]);
  if (!npm.ok) throw new Error("npm is not available on PATH.");
  if (!tryCapture("git", ["--version"]).ok) throw new Error("git is not available on PATH.");
  if (!tryCapture("gh", ["--version"]).ok) throw new Error("GitHub CLI (gh) is not installed or not on PATH.");
  return `node ${process.versions.node}, npm ${npm.output.trim()}`;
});

check("Local build tooling is installed", () => {
  const pkgs = ["electron-builder", "electron", "cross-env", "vite", "vitest", "@capacitor/cli", "@capacitor/android"];
  const missing = pkgs.filter((p) => !existsSync(resolve(root, "node_modules", p, "package.json")));
  if (missing.length) throw new Error(`Missing from node_modules: ${missing.join(", ")}`);
  const gradleFiles = ["gradlew.bat", "gradle/wrapper/gradle-wrapper.jar"].filter((f) => !existsSync(resolve(androidDir, f)));
  if (gradleFiles.length) throw new Error(`Gradle wrapper files missing under apps/umpire/android: ${gradleFiles.join(", ")}`);
  return `${pkgs.length} packages + Gradle wrapper present`;
});

check("JDK is available", () => {
  ctx.javaHome = findJavaHome();
  if (!ctx.javaHome) throw new Error("Could not find a JDK. Set JAVA_HOME, or install Android Studio (its bundled JBR is auto-detected).");
  const java = tryCapture(resolve(ctx.javaHome, "bin/java.exe"), ["-version"], { stdio: ["ignore", "pipe", "pipe"] });
  if (!java.ok) throw new Error(`java.exe under ${ctx.javaHome} did not run.`);
  return ctx.javaHome;
});

check("Android SDK and build-tools are available", () => {
  ctx.androidSdk = findAndroidSdk(androidDir);
  if (!ctx.androidSdk) throw new Error("Could not find the Android SDK. Set ANDROID_HOME/ANDROID_SDK_ROOT, or fix apps/umpire/android/local.properties.");
  const tools = findLatestBuildTools(ctx.androidSdk);
  if (!tools) throw new Error(`No build-tools with aapt.exe under ${ctx.androidSdk}\\build-tools`);
  if (!existsSync(resolve(tools, "apksigner.bat"))) throw new Error(`apksigner.bat missing from ${tools}`);
  return `${ctx.androidSdk} (build-tools ${tools.split(/[\\/]/).pop()})`;
});

check("Android release signing configuration is present", () => {
  const ksPath = resolve(androidDir, "keystore.properties");
  if (!existsSync(ksPath)) throw new Error("apps/umpire/android/keystore.properties is missing — Gradle would produce an UNSIGNED release APK.");
  const props = parseProperties(readFileSync(ksPath, "utf8"));
  const missing = ["storeFile", "storePassword", "keyAlias", "keyPassword"].filter((k) => !props[k]);
  if (missing.length) throw new Error(`keystore.properties is missing or has empty value(s) for: ${missing.join(", ")} (values are never printed).`);
  const storePath = resolve(androidDir, props.storeFile.replace(/\\\\/g, "\\"));
  if (!existsSync(storePath)) throw new Error(`The keystore file that keystore.properties points to does not exist (${props.storeFile}).`);
  const gradle = readFileSync(resolve(androidDir, "app/build.gradle"), "utf8");
  if (!/signingConfig\s+signingConfigs\.release/.test(gradle)) throw new Error("app/build.gradle does not apply signingConfigs.release to the release build type.");
  return "keystore.properties has all 4 keys, keystore file exists (values not printed)";
});

check("GitHub CLI is authenticated", () => {
  if (!tryCapture("gh", ["auth", "status"]).ok) throw new Error("gh is not authenticated. Run: gh auth login");
  ctx.ghLogin = ghActiveLogin();
  return `active account ${ctx.ghLogin}`;
});

check("Repository ownership matches the authenticated account", () => {
  const originUrl = git(["remote", "get-url", "origin"]).trim();
  const origin = parseGitHubRemote(originUrl);
  if (!origin) throw new Error(`origin (${originUrl}) is not a github.com remote.`);
  const publish = JSON.parse(readFileSync(resolve(operatorDir, "package.json"), "utf8")).build?.publish;
  if (!publish || publish.provider !== "github" || !publish.owner || !publish.repo) throw new Error("apps/operator/package.json build.publish is not a valid GitHub provider config.");
  ctx.originSlug = `${origin.owner}/${origin.repo}`;
  ctx.releaseSlug = `${publish.owner}/${publish.repo}`;
  state.releaseSlug = ctx.releaseSlug;
  ctx.originOwner = origin.owner;
  ctx.releaseOwner = publish.owner;
  assertGhAccountMatches(origin.owner);
  assertGhAccountMatches(publish.owner);
  for (const slug of new Set([ctx.originSlug, ctx.releaseSlug])) {
    const perm = tryCapture("gh", ["repo", "view", slug, "--json", "viewerPermission", "--jq", ".viewerPermission"]);
    if (!perm.ok) throw new Error(`Could not read ${slug} with gh: ${errText(perm)}`);
    if (!["ADMIN", "MAINTAIN", "WRITE"].includes(perm.output.trim())) throw new Error(`Account ${ctx.ghLogin} has "${perm.output.trim()}" permission on ${slug}; write access is required.`);
  }
  return ctx.originSlug === ctx.releaseSlug ? `${ctx.originSlug} (source repo and release repo are the same)` : `source ${ctx.originSlug}, releases ${ctx.releaseSlug}`;
});

check("origin/main has nothing this checkout lacks", () => {
  const remote = tryCapture("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: root });
  if (!remote.ok) throw new Error(`Could not query origin: ${errText(remote)}`);
  const remoteSha = remote.output.trim().split(/\s+/)[0];
  if (!remoteSha) throw new Error("origin has no main branch.");
  if (remoteSha === state.baseSha) return "origin/main == HEAD";
  const anc = tryCapture("git", ["merge-base", "--is-ancestor", remoteSha, "HEAD"], { cwd: root });
  if (!anc.ok) throw new Error(`origin/main (${remoteSha.slice(0, 7)}) is not an ancestor of local HEAD (${state.baseSha.slice(0, 7)}) — fetch and reconcile before releasing.`);
  return `origin/main ${remoteSha.slice(0, 7)} is an ancestor of HEAD`;
});

check("Release tag and GitHub release do not already exist", () => assertReleaseTargetFree(state.tag, ctx.originSlug, ctx.releaseSlug));

logStep("Preflight: root test suite (engine, contracts, api, client, ui)");
if (run("npm", ["test"], { cwd: root }) !== 0) fail("Preflight: root test suite", "`npm test` failed — see output above. Nothing was modified.");
console.log("  PASS  root test suite");

logStep("Preflight: Operator test suite");
if (run("npm", ["test", "-w", "@tournament/operator"], { cwd: root }) !== 0) fail("Preflight: Operator test suite", "`npm test -w @tournament/operator` failed — see output above. Nothing was modified.");
console.log("  PASS  Operator test suite");

console.log(`
Preflight PASSED. Plan:
  Operator ${ctx.currentOperator} -> ${ctx.nextOperator}   Umpire ${ctx.currentUmpire} -> ${ctx.nextUmpire} (versionCode ${ctx.currentVersionCode} -> ${ctx.nextVersionCode})
  Tag / release: ${state.tag} on ${ctx.releaseSlug}
  Will stage exactly: ${[...VERSION_FILES, ...initialEntries.map((e) => e.path)].join(", ")}`);

if (flags.preflightOnly) {
  releaseUnlock();
  console.log("\n--preflight-only: stopping here. No version file, build output, commit, tag, push, or release was touched.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Version bump (first modification)
// ---------------------------------------------------------------------------
stage = "version-bump";
logStep("Apply version bump");
state.versionsBumped = true; // set first so a partial write is still covered by the restore
const gradlePath = resolve(androidDir, "app/build.gradle");
const bumpPlan = [
  { rel: "apps/operator/package.json", path: resolve(operatorDir, "package.json"), edit: (raw) => raw.replace(/"version":\s*"[^"]+"/, `"version": "${ctx.nextOperator}"`) },
  { rel: "apps/umpire/package.json", path: resolve(umpireDir, "package.json"), edit: (raw) => raw.replace(/"version":\s*"[^"]+"/, `"version": "${ctx.nextUmpire}"`) },
  {
    rel: "apps/umpire/android/app/build.gradle",
    path: gradlePath,
    edit: (raw) => raw.replace(/versionCode\s+\d+/, `versionCode ${ctx.nextVersionCode}`).replace(/versionName\s+"[^"]+"/, `versionName "${ctx.nextUmpire}"`),
  },
];
for (const f of bumpPlan) {
  const original = readFileSync(f.path, "utf8");
  const written = f.edit(original);
  bumpedFiles.push({ rel: f.rel, path: f.path, original, written });
}
for (const f of bumpedFiles) writeFileSync(f.path, f.written);
console.log(`Operator: ${ctx.currentOperator} -> ${ctx.nextOperator}`);
console.log(`Umpire:   ${ctx.currentUmpire} -> ${ctx.nextUmpire} (versionCode ${ctx.currentVersionCode} -> ${ctx.nextVersionCode})`);

// ---------------------------------------------------------------------------
// 3. Builds — strictly sequential: Windows Operator, then Android Umpire.
// ---------------------------------------------------------------------------
const buildStartMs = Date.now() - 5000; // artifacts older than this run are stale, not new

stage = "windows-build";
state.buildsStarted = true;
logStep("Build Windows (electron-builder, includes clean:desktop)");
state.releaseDirCleanupStarted = true; // build:desktop deletes apps/operator/release/ first
if (run("npm", ["run", "build:desktop", "-w", "@tournament/operator"], { cwd: root }) !== 0) {
  fail("Windows build", "`npm run build:desktop -w @tournament/operator` failed — see output above.");
}

stage = "android-build";
logStep("Build Android (vite + cap sync)");
if (run("npm", ["run", "build:android", "-w", "@tournament/umpire"], { cwd: root }) !== 0) {
  fail("Android build (web bundle)", "`npm run build:android -w @tournament/umpire` failed — see output above.");
}
console.log(`Using JAVA_HOME=${ctx.javaHome}`);
console.log(`Using Android SDK=${ctx.androidSdk}`);

logStep("Build Android (gradlew assembleRelease)");
const gradleStatus = run(resolve(androidDir, "gradlew.bat"), ["assembleRelease", "--no-daemon"], {
  cwd: androidDir,
  env: { ...process.env, JAVA_HOME: ctx.javaHome, ANDROID_HOME: ctx.androidSdk, ANDROID_SDK_ROOT: ctx.androidSdk },
});
if (gradleStatus !== 0) fail("Android build (Gradle)", "`gradlew.bat assembleRelease` failed — see output above. The signing config was not touched.");

// ---------------------------------------------------------------------------
// 4. Verify both artifacts directly (an exit code alone is not enough)
// ---------------------------------------------------------------------------
stage = "verify";
logStep("Verify Windows build");
const winResult = verifyWindowsInstaller({ root, operatorDir, version: ctx.nextOperator, notOlderThanMs: buildStartMs });
if (!winResult.ok) fail("Verify Windows build", winResult.error);
console.log(`Installer:            ${winResult.path} (${winResult.size} bytes, ${winResult.mtime.toISOString()})`);
console.log(`NSIS installer:       yes (MZ header + Nullsoft/NSIS stub)`);
console.log(`ProductVersion:       ${winResult.productVersion ?? "(not readable)"}`);
console.log(`Windows Authenticode: ${winResult.authenticode.label}`);
if (winResult.authenticode.signed !== true) console.log("  (not blocking: no Windows signing certificate is configured for this project)");

logStep("Verify Android build");
const apkResult = verifyAndroidApk({
  androidDir,
  androidSdk: ctx.androidSdk,
  javaHome: ctx.javaHome,
  expectedAppId: "app.tournament.umpire",
  expectedVersionCode: ctx.nextVersionCode,
  expectedVersionName: ctx.nextUmpire,
  notOlderThanMs: buildStartMs,
});
if (!apkResult.ok) fail("Verify Android build", apkResult.error);
console.log(`APK:     ${apkResult.path} (${apkResult.size} bytes, ${apkResult.mtime.toISOString()})`);
console.log(`Package: ${apkResult.appId} versionName ${apkResult.versionName} versionCode ${apkResult.versionCode} (release variant, not debuggable)`);
console.log(`Signer:  ${apkResult.signerDn} SHA-256 ${apkResult.signerSha256 ?? "(n/a)"}`);
console.log("Android APK stays LOCAL — it is not uploaded anywhere by this script.");

// ---------------------------------------------------------------------------
// 5. Commit — explicit allowlist only, never "everything git status shows"
// ---------------------------------------------------------------------------
stage = "commit";
logStep("Commit (explicit allowlist)");
if (git(["rev-parse", "HEAD"]).trim() !== state.baseSha) fail("Commit", "HEAD moved since preflight — refusing to commit on top of an unexpected state.");
const postBuildEntries = readWorkingTree();
const allowedPost = (p) => VERSION_FILES.includes(p) || isAllowedPath(p);
const isAllowedPostEntry = (e) => allowedPost(e.path) && (!e.renamedFrom || allowedPost(e.renamedFrom));
const strays = postBuildEntries.filter((e) => !isAllowedPostEntry(e));
if (strays.length) {
  fail("Commit", `Unexpected working-tree change(s) appeared after preflight — nothing was staged:\n${strays.map((e) => `  ${e.code} ${e.path}`).join("\n")}`);
}
const missingBump = VERSION_FILES.filter((p) => !postBuildEntries.some((e) => e.path === p));
if (missingBump.length) fail("Commit", `Expected version file(s) not modified: ${missingBump.join(", ")}`);
const pathsToStage = postBuildEntries.map((e) => e.path);
if (git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean).length) fail("Commit", "The index gained staged changes during the release — refusing to commit.");
console.log(`Staging exactly ${pathsToStage.length} path(s):`);
for (const p of pathsToStage) console.log(`  ${p}`);
try {
  git(["add", "--", ...pathsToStage], { stdio: "inherit" });
} catch (err) {
  try { git(["restore", "--staged", "--", ...pathsToStage]); } catch { /* best effort */ }
  fail("Commit", `git add failed: ${err.message}`);
}
const stagedNow = git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean).sort();
const expectedStaged = [...pathsToStage].sort();
if (stagedNow.length !== expectedStaged.length || stagedNow.some((p, i) => p !== expectedStaged[i])) {
  try { git(["restore", "--staged", "--", ...pathsToStage]); } catch { /* best effort */ }
  fail("Commit", `Staged set does not match the allowlist exactly.\n  expected: ${expectedStaged.join(", ")}\n  staged:   ${stagedNow.join(", ")}\nThe paths this script staged were unstaged again; nothing was committed.`);
}
const commitMsg = `Release v${ctx.nextOperator} (Umpire ${ctx.nextUmpire})\n\n- Windows Operator: ${ctx.currentOperator} -> ${ctx.nextOperator}\n- Android Umpire: ${ctx.currentUmpire} -> ${ctx.nextUmpire} (versionCode ${ctx.nextVersionCode})\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n`;
writeFileSync(commitMsgPath, commitMsg);
try {
  git(["commit", "-F", commitMsgPath], { stdio: "inherit" });
} catch (err) {
  try { unlinkSync(commitMsgPath); } catch { /* ignore */ }
  try { git(["restore", "--staged", "--", ...pathsToStage]); } catch { /* best effort */ }
  fail("Commit", `git commit failed: ${err.message}`);
}
try { unlinkSync(commitMsgPath); } catch { /* ignore */ }
state.committed = true;
state.commitHash = git(["rev-parse", "--short", "HEAD"]).trim();
const commitSha = git(["rev-parse", "HEAD"]).trim();
console.log(`Committed ${state.commitHash}`);

// ---------------------------------------------------------------------------
// 6. Push — plain push, never forced
// ---------------------------------------------------------------------------
stage = "push";
logStep("Push to GitHub (source repo)");
try {
  assertGhAccountMatches(ctx.originOwner);
} catch (err) {
  fail("Push to GitHub", err.message);
}
try {
  git(["push", "origin", "main"], { stdio: "inherit" });
} catch (err) {
  fail("Push to GitHub", `\`git push origin main\` failed (${err.message}). Fix the cause and push manually — never force-push.`);
}
{
  const remote = tryCapture("git", ["ls-remote", "origin", "refs/heads/main"], { cwd: root });
  const remoteSha = remote.ok ? remote.output.trim().split(/\s+/)[0] : "";
  if (remoteSha !== commitSha) fail("Push to GitHub", `git push reported success, but origin/main is ${remoteSha ? remoteSha.slice(0, 7) : "unreadable"}, not ${commitSha.slice(0, 7)}.`);
  state.pushed = true;
  console.log(`origin/main == ${commitSha.slice(0, 7)} (verified)`);
}

// ---------------------------------------------------------------------------
// 7. Publish the Windows GitHub release, then verify it independently
// ---------------------------------------------------------------------------
stage = "github-release";
logStep("Publish Windows GitHub Release");
try {
  assertGhAccountMatches(ctx.releaseOwner);
  assertReleaseTargetFree(state.tag, ctx.originSlug, ctx.releaseSlug); // must not have appeared since preflight
} catch (err) {
  fail("Publish GitHub Release", `${err.message}\nSource push succeeded (commit ${state.commitHash}); no release was created.`);
}
state.ghReleaseStarted = true;
if (run("node", [resolve(root, "scripts/publish-desktop-update.mjs")], { cwd: root }) !== 0) {
  fail("Publish GitHub Release", `scripts/publish-desktop-update.mjs failed. Source push already succeeded (commit ${state.commitHash}).`);
}

logStep("Verify published release");
const releaseFiles = [
  resolve(operatorDir, `release/Tournament-Operator-Setup-${ctx.nextOperator}.exe`),
  resolve(operatorDir, `release/Tournament-Operator-Setup-${ctx.nextOperator}.exe.blockmap`),
  resolve(operatorDir, "release/latest.yml"),
];
const view = tryCapture("gh", ["release", "view", state.tag, "--repo", ctx.releaseSlug, "--json", "tagName,isDraft,url,assets"]);
if (!view.ok) fail("Verify published release", `gh could not read release ${state.tag}: ${errText(view)}`);
const published = JSON.parse(view.output);
if (published.tagName !== state.tag) fail("Verify published release", `Release tag is ${published.tagName}, expected ${state.tag}.`);
if (published.isDraft) fail("Verify published release", `Release ${state.tag} is still a DRAFT — it was not published.`);
for (const file of releaseFiles) {
  const name = file.split(/[\\/]/).pop();
  const asset = (published.assets || []).find((a) => a.name === name);
  if (!asset) fail("Verify published release", `Published release is missing asset ${name}.`);
  const localSize = readFileSync(file).length;
  if (asset.size !== localSize) fail("Verify published release", `Asset ${name}: remote ${asset.size} bytes, local ${localSize} bytes.`);
  if (typeof asset.digest === "string" && asset.digest.startsWith("sha256:")) {
    const local = sha256OfFile(file);
    if (asset.digest.slice(7).toLowerCase() !== local) fail("Verify published release", `Asset ${name}: remote sha256 ${asset.digest.slice(7)} != local ${local}.`);
    console.log(`  ${name}: ${asset.size} bytes, sha256 matches`);
  } else {
    console.log(`  ${name}: ${asset.size} bytes (size matches; GitHub returned no digest for this asset)`);
  }
}
console.log(`Release ${state.tag} verified: ${published.url}`);

// ---------------------------------------------------------------------------
// 8. Final report — only reached when every step above verified
// ---------------------------------------------------------------------------
const treeAfter = readWorkingTree();
releaseUnlock();
const durationSec = Math.round((Date.now() - startedAt) / 1000);
console.log(`
========================================
RELEASE COMPLETE
================

Operator version: ${ctx.nextOperator}
Umpire version:   ${ctx.nextUmpire} (versionCode ${ctx.nextVersionCode})
Duration: ${durationSec}s

Windows:
PASS
${winResult.path}
${winResult.size} bytes, NSIS installer, ProductVersion ${winResult.productVersion ?? "n/a"}
Windows Authenticode: ${winResult.authenticode.label}

Android:
PASS (LOCAL ONLY — not uploaded or published)
${apkResult.path}
${apkResult.size} bytes - ${apkResult.appId} ${apkResult.versionName} (${apkResult.versionCode}), release, signed
Signer SHA-256: ${apkResult.signerSha256 ?? "n/a"}

Tests (preflight):
Root suite (engine, contracts, api, client, ui): PASS
Operator: PASS
Android: NOT AVAILABLE (no test suite configured)

Git:
Commit: ${state.commitHash}
Push: PASS (origin/main verified)
Working tree: ${treeAfter.length === 0 ? "CLEAN" : `${treeAfter.length} path(s) still changed:\n${treeAfter.map((e) => `  ${e.code} ${e.path}`).join("\n")}`}

GitHub Release:
${state.tag}
Published: YES, verified (${ctx.releaseSlug}) ${published.url}

MANUAL TEST REQUIRED:
- Windows old-version -> new-version auto-update (install/detect/download/restart)
- Android physical-device installation
- Android live scoring on-device
========================================`);
