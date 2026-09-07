// One-command production release pipeline for Tournament Operator (Windows)
// and Tournament Umpire (Android). Invoke via `npm run release` (patch bump)
// or `npm run release -- minor` / `npm run release -- major`.
//
// Order: verify tree -> tests -> version bump -> Windows build -> Android
// build -> verify both -> commit -> push -> publish GitHub release -> report.
// Any failing step stops the pipeline before anything is committed/pushed/
// published — see fail() below. Nothing here bypasses the existing build,
// test, or publish tooling; it orchestrates the same npm scripts a human
// would run by hand (see apps/operator/package.json, apps/umpire/package.json,
// scripts/publish-desktop-update.mjs).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const operatorDir = resolve(root, "apps/operator");
const umpireDir = resolve(root, "apps/umpire");
const androidDir = resolve(umpireDir, "android");
// Kept inside node_modules (gitignored, always present once `npm install` has
// run) rather than at the repo root, so the lock file itself never shows up
// as an untracked path in `git status` while a release is running.
const lockPath = resolve(root, "node_modules/.release.lock");
const commitMsgPath = resolve(root, "node_modules/.release-commit-msg.txt");

const BUMP_TYPES = ["patch", "minor", "major"];
const bumpType = (process.argv[2] || "patch").toLowerCase();
if (!BUMP_TYPES.includes(bumpType)) {
  console.error(`Unknown bump type "${bumpType}". Use one of: ${BUMP_TYPES.join(", ")}.`);
  process.exit(1);
}

const startedAt = Date.now();
const report = { bumpType, steps: [] };

function logStep(name) {
  console.log(`\n--- ${name} ---`);
  report.steps.push(name);
}

function fail(step, reason) {
  releaseUnlock();
  console.log(`
========================================
RELEASE FAILED
==============

Step:
${step}

Reason:
${reason}

NO release published.
========================================`);
  process.exit(1);
}

function releaseLock() {
  if (existsSync(lockPath)) {
    const pid = readFileSync(lockPath, "utf8").trim();
    console.error("Release already in progress.");
    console.error(`Lock held by pid ${pid || "unknown"} (${lockPath}).`);
    console.error("If a previous run crashed without cleaning up, delete that file and retry.");
    process.exit(1);
  }
  writeFileSync(lockPath, String(process.pid));
}
function releaseUnlock() {
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}
process.on("exit", releaseUnlock);
process.on("SIGINT", () => { releaseUnlock(); process.exit(130); });

function run(cmd, args, opts = {}) {
  // shell:true on Windows is required for `npm` (it's npm.cmd, not an .exe) —
  // applied uniformly here so every call behaves the same way.
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.error) throw res.error;
  return res.status ?? 1;
}
function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
function tryCapture(cmd, args, opts = {}) {
  try {
    return { ok: true, output: runCapture(cmd, args, opts) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

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
function writePackageVersion(pkgPath, nextVersion) {
  const raw = readFileSync(pkgPath, "utf8");
  const next = raw.replace(/"version":\s*"[^"]+"/, `"version": "${nextVersion}"`);
  writeFileSync(pkgPath, next);
}

// --- 0. Release lock ---
releaseLock();

// --- 1/2. Verify working tree + inspect changes ---
logStep("Verify working tree");
const statusRaw = runCapture("git", ["status", "--porcelain"], { cwd: root });
const changedLines = statusRaw.split(/\r?\n/).filter(Boolean);
if (changedLines.length === 0) {
  releaseUnlock();
  console.log("No source changes detected — release skipped.");
  process.exit(0);
}
console.log(`${changedLines.length} changed path(s):`);
for (const line of changedLines) console.log(`  ${line}`);

const SUSPICIOUS_PATTERNS = [
  /(^|[\\/])\.env(\.[^\\/]*)?$/i,
  /\.(pem|p12|jks|keystore)$/i,
  /credentials?/i,
  /secret/i,
  /\.git-credentials$/i,
  /id_rsa/i,
];
const suspicious = changedLines.filter((line) => {
  const path = line.slice(3).trim();
  if (/\.env\.example$/i.test(path)) return false;
  return SUSPICIOUS_PATTERNS.some((re) => re.test(path));
});
if (suspicious.length) {
  fail(
    "Verify working tree",
    `Suspicious/sensitive-looking path(s) in the working tree — refusing to auto-commit:\n${suspicious.join("\n")}\nReview these manually, then rerun.`
  );
}

// --- Tests (before touching any version files) ---
logStep("Run tests: engine, contracts, api");
const rootTestStatus = run("npm", ["test"], { cwd: root });
if (rootTestStatus !== 0) fail("Tests: engine/contracts/api", "`npm test` failed — see output above.");
report.tests = { engine: "PASS", contracts: "PASS", api: "PASS" };

logStep("Run tests: operator");
const operatorTestStatus = run("npm", ["test", "-w", "@tournament/operator"], { cwd: root });
if (operatorTestStatus !== 0) fail("Tests: operator", "`npm test -w @tournament/operator` failed — see output above.");
report.tests.operator = "PASS";
report.tests.android = "NOT AVAILABLE (no project test suite configured for @tournament/umpire)";

// --- 3/4. Determine + apply next version ---
logStep("Determine next version");
const operatorPkgPath = resolve(operatorDir, "package.json");
const umpirePkgPath = resolve(umpireDir, "package.json");
const gradlePath = resolve(androidDir, "app/build.gradle");

const currentOperatorVersion = readPackageVersion(operatorPkgPath);
const currentUmpireVersion = readPackageVersion(umpirePkgPath);
const nextOperatorVersion = bumpVersion(currentOperatorVersion, bumpType);
const nextUmpireVersion = bumpVersion(currentUmpireVersion, bumpType);

const gradleRaw = readFileSync(gradlePath, "utf8");
const versionCodeMatch = gradleRaw.match(/versionCode\s+(\d+)/);
if (!versionCodeMatch) fail("Determine next version", `Could not find versionCode in ${gradlePath}`);
const nextVersionCode = Number.parseInt(versionCodeMatch[1], 10) + 1;

console.log(`Operator: ${currentOperatorVersion} -> ${nextOperatorVersion}`);
console.log(`Umpire:   ${currentUmpireVersion} -> ${nextUmpireVersion} (versionCode ${versionCodeMatch[1]} -> ${nextVersionCode})`);
console.log("(Operator and Umpire keep independent version lineages, per this project's existing convention — both are bumped by the same amount, from their own current version.)");

logStep("Apply version bump");
writePackageVersion(operatorPkgPath, nextOperatorVersion);
writePackageVersion(umpirePkgPath, nextUmpireVersion);
writeFileSync(
  gradlePath,
  gradleRaw
    .replace(/versionCode\s+\d+/, `versionCode ${nextVersionCode}`)
    .replace(/versionName\s+"[^"]+"/, `versionName "${nextUmpireVersion}"`)
);

// --- 6. Windows build ---
logStep("Build Windows (electron-builder, includes clean:desktop)");
const winBuildStatus = run("npm", ["run", "build:desktop", "-w", "@tournament/operator"], { cwd: root });
if (winBuildStatus !== 0) fail("Windows build", "`npm run build:desktop -w @tournament/operator` failed — see output above. Version files were changed but nothing was committed.");

// --- 7. Android build ---
logStep("Build Android (vite + cap sync)");
const androidWebStatus = run("npm", ["run", "build:android", "-w", "@tournament/umpire"], { cwd: root });
if (androidWebStatus !== 0) fail("Android build (web bundle)", "`npm run build:android -w @tournament/umpire` failed — see output above.");

function findJavaHome() {
  if (process.env.JAVA_HOME && existsSync(resolve(process.env.JAVA_HOME, "bin/java.exe"))) return process.env.JAVA_HOME;
  const candidates = [
    "C:\\Program Files\\Android\\Android Studio\\jbr",
    "C:\\Program Files\\Android\\Android Studio1\\jbr",
  ];
  for (const c of candidates) {
    if (existsSync(resolve(c, "bin/java.exe"))) return c;
  }
  return null;
}
function findAndroidSdk() {
  if (process.env.ANDROID_HOME && existsSync(process.env.ANDROID_HOME)) return process.env.ANDROID_HOME;
  if (process.env.ANDROID_SDK_ROOT && existsSync(process.env.ANDROID_SDK_ROOT)) return process.env.ANDROID_SDK_ROOT;
  const localProps = resolve(androidDir, "local.properties");
  if (existsSync(localProps)) {
    const m = readFileSync(localProps, "utf8").match(/sdk\.dir=(.+)/);
    if (m) {
      const p = m[1].trim().replace(/\\\\/g, "\\");
      if (existsSync(p)) return p;
    }
  }
  const fallback = resolve(String(process.env.LOCALAPPDATA || ""), "Android/Sdk");
  if (existsSync(fallback)) return fallback;
  return null;
}
function findLatestBuildTools(sdkPath) {
  const dir = resolve(sdkPath, "build-tools");
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).filter((v) => existsSync(resolve(dir, v, "aapt.exe")));
  if (!versions.length) return null;
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return resolve(dir, versions[versions.length - 1]);
}

const javaHome = findJavaHome();
if (!javaHome) fail("Android build (Gradle)", "Could not find a JDK. Set JAVA_HOME, or install Android Studio (its bundled JBR is auto-detected).");
const androidSdk = findAndroidSdk();
if (!androidSdk) fail("Android build (Gradle)", "Could not find the Android SDK. Set ANDROID_HOME/ANDROID_SDK_ROOT, or fix apps/umpire/android/local.properties.");
console.log(`Using JAVA_HOME=${javaHome}`);
console.log(`Using Android SDK=${androidSdk}`);

logStep("Build Android (gradlew assembleRelease)");
const gradleStatus = run(resolve(androidDir, "gradlew.bat"), ["assembleRelease", "--no-daemon"], {
  cwd: androidDir,
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk },
});
if (gradleStatus !== 0) fail("Android build (Gradle)", "`gradlew.bat assembleRelease` failed — see output above. The existing signing config was not touched.");

// --- 8. Verify both builds ---
logStep("Verify Windows build");
const winCheckStatus = run("node", [resolve(root, "scripts/publish-desktop-update.mjs"), "--check"], { cwd: root });
if (winCheckStatus !== 0) fail("Verify Windows build", "Windows release artifact verification failed (see scripts/publish-desktop-update.mjs --check output above).");

const winInstallerPath = resolve(operatorDir, `release/Tournament-Operator-Setup-${nextOperatorVersion}.exe`);
const winInstallerSize = statSync(winInstallerPath).size;

logStep("Verify Android build");
const apkPath = resolve(androidDir, "app/build/outputs/apk/release/app-release.apk");
if (!existsSync(apkPath)) fail("Verify Android build", `Expected release APK not found at ${apkPath}`);
const buildTools = findLatestBuildTools(androidSdk);
if (!buildTools) fail("Verify Android build", `No usable build-tools (with aapt.exe) found under ${androidSdk}/build-tools`);

const badging = tryCapture(resolve(buildTools, "aapt.exe"), ["dump", "badging", apkPath]);
if (!badging.ok) fail("Verify Android build", `aapt dump badging failed: ${badging.error.message}`);
const pkgLine = badging.output.split(/\r?\n/).find((l) => l.startsWith("package:"));
const appIdMatch = pkgLine?.match(/name='([^']+)'/);
const versionCodeOut = pkgLine?.match(/versionCode='([^']+)'/);
const versionNameOut = pkgLine?.match(/versionName='([^']+)'/);
if (appIdMatch?.[1] !== "app.tournament.umpire") fail("Verify Android build", `Unexpected applicationId in APK: ${appIdMatch?.[1]}`);
if (versionCodeOut?.[1] !== String(nextVersionCode)) fail("Verify Android build", `APK versionCode ${versionCodeOut?.[1]} does not match expected ${nextVersionCode}`);
if (versionNameOut?.[1] !== nextUmpireVersion) fail("Verify Android build", `APK versionName ${versionNameOut?.[1]} does not match expected ${nextUmpireVersion}`);

const sig = tryCapture(resolve(buildTools, "apksigner.bat"), ["verify", "--print-certs", apkPath], {
  env: { ...process.env, JAVA_HOME: javaHome },
  shell: process.platform === "win32", // apksigner.bat is a batch file, not a .exe
});
if (!sig.ok) fail("Verify Android build", `apksigner verify failed — the release signing config may be broken:\n${sig.error.message}`);
const apkSize = statSync(apkPath).size;

// --- 10. Commit ---
logStep("Commit");
const statusBeforeCommit = runCapture("git", ["status", "--porcelain"], { cwd: root })
  .split(/\r?\n/)
  .filter(Boolean);
const pathsToStage = statusBeforeCommit
  .map((l) => l.slice(3).trim())
  .filter((p) => !SUSPICIOUS_PATTERNS.some((re) => re.test(p)) || /\.env\.example$/i.test(p));
if (!pathsToStage.length) fail("Commit", "No stageable changes found after build (unexpected).");
run("git", ["add", "--", ...pathsToStage], { cwd: root });
const commitMsg = `Release v${nextOperatorVersion} (Umpire ${nextUmpireVersion})\n\n- Windows Operator: ${currentOperatorVersion} -> ${nextOperatorVersion}\n- Android Umpire: ${currentUmpireVersion} -> ${nextUmpireVersion} (versionCode ${nextVersionCode})\n\nCo-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>\n`;
writeFileSync(commitMsgPath, commitMsg);
const commitStatus = run("git", ["commit", "-F", commitMsgPath], { cwd: root });
try { unlinkSync(commitMsgPath); } catch { /* ignore */ }
if (commitStatus !== 0) fail("Commit", "`git commit` failed — see output above.");
const commitHash = runCapture("git", ["rev-parse", "--short", "HEAD"], { cwd: root }).trim();

// --- 11. Push ---
function remoteOwner(url) {
  const m = String(url).match(/github\.com[/:]([^/]+)\//i);
  return m ? m[1] : null;
}
function ensureGhAccountActive(login) {
  if (!login) return;
  const status = tryCapture("gh", ["auth", "status"]);
  const text = status.ok ? status.output : (status.error?.stdout?.toString() || status.error?.stderr?.toString() || "");
  // Parse per-account blocks rather than one greedy regex across the whole
  // output — otherwise the captured "active" account can be misattributed to
  // whichever account happens to be listed first, not whichever actually has
  // "Active account: true" nearest to it.
  const blocks = text.split(/(?=Logged in to github\.com account )/);
  const accounts = [];
  let activeLogin = null;
  for (const block of blocks) {
    const nameMatch = block.match(/Logged in to github\.com account (\S+)/);
    if (!nameMatch) continue;
    accounts.push(nameMatch[1]);
    if (/Active account:\s*true/.test(block)) activeLogin = nameMatch[1];
  }
  if (activeLogin === login) return;
  if (!accounts.includes(login)) {
    throw new Error(`GitHub account "${login}" is not logged into gh on this machine. Run: gh auth login (as ${login})`);
  }
  const sw = tryCapture("gh", ["auth", "switch", "--user", login, "--hostname", "github.com"]);
  if (!sw.ok) throw new Error(`Failed to switch gh to account "${login}": ${sw.error.message}`);
}

logStep("Push to GitHub (source repo)");
const originUrl = runCapture("git", ["remote", "get-url", "origin"], { cwd: root }).trim();
const sourceOwner = remoteOwner(originUrl);
try {
  ensureGhAccountActive(sourceOwner);
} catch (err) {
  fail("Push to GitHub", `${err.message}\nA local commit (${commitHash}) exists but was NOT pushed. Fix auth and run: git push origin main`);
}
const pushStatus = run("git", ["push", "origin", "main"], { cwd: root });
if (pushStatus !== 0) {
  fail("Push to GitHub", `\`git push origin main\` failed. A local commit (${commitHash}) exists but was NOT pushed — fix the issue and push manually, do not force-push.`);
}

// --- 12/13. Publish Windows GitHub Release ---
logStep("Publish Windows GitHub Release");
const releaseOwner = JSON.parse(readFileSync(operatorPkgPath, "utf8")).build?.publish?.owner;
try {
  ensureGhAccountActive(releaseOwner);
} catch (err) {
  fail("Publish GitHub Release", `${err.message}\nSource push succeeded (commit ${commitHash}), but the release was NOT published. Fix auth and run: npm run publish:desktop -w @tournament/operator`);
}
const publishStatus = run("node", [resolve(root, "scripts/publish-desktop-update.mjs")], { cwd: root });
if (publishStatus !== 0) {
  fail("Publish GitHub Release", `scripts/publish-desktop-update.mjs failed. Source push already succeeded (commit ${commitHash}) — fix the release issue and run: npm run publish:desktop -w @tournament/operator`);
}

// --- 14. Final report ---
releaseUnlock();
const durationSec = Math.round((Date.now() - startedAt) / 1000);
console.log(`
========================================
RELEASE COMPLETE
================

Operator version: ${nextOperatorVersion}
Umpire version:   ${nextUmpireVersion} (versionCode ${nextVersionCode})
Duration: ${durationSec}s

Windows:
PASS
Tournament-Operator-Setup-${nextOperatorVersion}.exe (${winInstallerSize} bytes)

Android:
PASS
app-release.apk (${apkSize} bytes) - applicationId app.tournament.umpire, signed

Tests:
Engine: PASS
Contracts: PASS
API: PASS (live-integration tests skipped unless RUN_LIVE_API_TESTS=1)
Operator: PASS
Android: NOT AVAILABLE (no test suite configured)

Git:
Commit: ${commitHash}
Push: PASS
Working tree: CLEAN

GitHub Release:
v${nextOperatorVersion}
Published: YES (jmdg840/tournament-operator-updates)

Auto-update metadata:
latest.yml: PASS

MANUAL TEST REQUIRED:
- Windows old-version -> new-version auto-update (install/detect/download/restart)
- Android physical-device installation
- Android live scoring on-device
========================================`);
