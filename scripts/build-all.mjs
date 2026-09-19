// Full build pipeline: every currently-supported artifact, from the existing
// dependency install. Never runs npm ci, never deletes node_modules, never
// bumps versions, never touches git. Reuses the exact same per-workspace
// scripts a human would run by hand, and the same artifact verification
// release.mjs uses (via scripts/lib/buildVerify.mjs), so "built by build:all"
// and "built by release" are checked the same way.
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot } from "./lib/repoGuard.mjs";
import { checkDependencies } from "./check-dependencies.mjs";
import { run, findJavaHome, findAndroidSdk, verifyWindowsInstaller, verifyAndroidApk } from "./lib/buildVerify.mjs";

const root = repoRoot();
const operatorDir = resolve(root, "apps/operator");
const umpireDir = resolve(root, "apps/umpire");
const androidDir = resolve(umpireDir, "android");

const startedAt = Date.now();

function header(title) {
  console.log(`\n--- ${title} ---`);
}
function fail(step, reason) {
  console.log(`
========================================
BUILD FAILED
============

FAILED STAGE:
${step}

ERROR:
${reason}
========================================`);
  process.exit(1);
}

function readJsonVersion(pkgPath) {
  return JSON.parse(readFileSync(pkgPath, "utf8")).version;
}

// --- 1. Dependency sanity check (no install, ever) ---
header("Dependency sanity check");
const health = checkDependencies();
if (!health.ok) {
  fail(
    "Dependency sanity check",
    `node_modules is not healthy:\n${health.problems.map((p) => `  - ${p}`).join("\n")}\n\nThis is a dependency problem, not a source problem. Run: npm run reset:dependencies`
  );
}
console.log("Dependencies OK.");

const operatorVersion = readJsonVersion(resolve(operatorDir, "package.json"));
const umpireVersion = readJsonVersion(resolve(umpireDir, "package.json"));

// --- 2/3. Operator + Umpire web builds ---
header("Build Operator (web)");
if (run("npm", ["run", "build", "-w", "@tournament/operator"], { cwd: root }) !== 0) {
  fail("Operator web build", "`npm run build -w @tournament/operator` failed — see output above.");
}

header("Build Umpire (web)");
if (run("npm", ["run", "build", "-w", "@tournament/umpire"], { cwd: root }) !== 0) {
  fail("Umpire web build", "`npm run build -w @tournament/umpire` failed — see output above.");
}

// --- 4. Android web bundle + Capacitor sync ---
header("Build Android (vite + cap sync)");
if (run("npm", ["run", "build:android", "-w", "@tournament/umpire"], { cwd: root }) !== 0) {
  fail("Android build (web bundle)", "`npm run build:android -w @tournament/umpire` failed — see output above.");
}

const javaHome = findJavaHome();
if (!javaHome) fail("Android build (Gradle)", "Could not find a JDK. Set JAVA_HOME, or install Android Studio (its bundled JBR is auto-detected).");
const androidSdk = findAndroidSdk(androidDir);
if (!androidSdk) fail("Android build (Gradle)", "Could not find the Android SDK. Set ANDROID_HOME/ANDROID_SDK_ROOT, or fix apps/umpire/android/local.properties.");
console.log(`Using JAVA_HOME=${javaHome}`);
console.log(`Using Android SDK=${androidSdk}`);

header("Build Android (gradlew assembleRelease)");
const gradleStatus = run(resolve(androidDir, "gradlew.bat"), ["assembleRelease", "--no-daemon"], {
  cwd: androidDir,
  env: { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidSdk, ANDROID_SDK_ROOT: androidSdk },
});
if (gradleStatus !== 0) fail("Android build (Gradle)", "`gradlew.bat assembleRelease` failed — see output above. The existing signing config was not touched.");

// --- 5. Windows installer ---
header("Build Windows (electron-builder, includes clean:desktop)");
if (run("npm", ["run", "build:desktop", "-w", "@tournament/operator"], { cwd: root }) !== 0) {
  fail("Windows build", "`npm run build:desktop -w @tournament/operator` failed — see output above.");
}

// --- 6/7. Verify artifacts ---
header("Verify Windows build");
const winResult = verifyWindowsInstaller({ root, operatorDir, version: operatorVersion });
if (!winResult.ok) fail("Verify Windows build", winResult.error);

header("Verify Android build");
const gradleRawForVerify = readFileSync(resolve(androidDir, "app/build.gradle"), "utf8");
const expectedVersionCode = gradleRawForVerify.match(/versionCode\s+(\d+)/)?.[1];
const apkResult = verifyAndroidApk({
  androidDir,
  androidSdk,
  javaHome,
  expectedAppId: "app.tournament.umpire",
  expectedVersionName: umpireVersion,
  expectedVersionCode,
});
if (!apkResult.ok) fail("Verify Android build", apkResult.error);

header("Verify Operator/Umpire web output");
const operatorDist = resolve(operatorDir, "dist");
const umpireDist = resolve(umpireDir, "dist");
if (!existsSync(operatorDist) || statSync(operatorDist).isDirectory() === false) fail("Verify Operator web build", `${operatorDist} not found.`);
if (!existsSync(umpireDist) || statSync(umpireDist).isDirectory() === false) fail("Verify Umpire web build", `${umpireDist} not found.`);

// --- 8. Version consistency ---
header("Version consistency");
const versionCodeMatch = expectedVersionCode;
const versionNameMatch = gradleRawForVerify.match(/versionName\s+"([^"]+)"/)?.[1];
const installerVersionInName = winResult.path.match(/Tournament-Operator-Setup-([^.]+(?:\.[^.]+){2})\.exe$/)?.[1];

const versionRows = [
  ["Operator package.json", operatorVersion],
  ["Windows installer filename", installerVersionInName || "(unparsed)"],
  ["Umpire package.json", umpireVersion],
  ["Android versionName", versionNameMatch || "(missing)"],
  ["Android versionCode", versionCodeMatch || "(missing)"],
  ["APK versionName (from aapt)", apkResult.versionName || "(missing)"],
  ["APK versionCode (from aapt)", apkResult.versionCode || "(missing)"],
];
for (const [label, value] of versionRows) console.log(`  ${label}: ${value}`);

const mismatches = [];
if (installerVersionInName && installerVersionInName !== operatorVersion) mismatches.push(`Windows installer filename (${installerVersionInName}) != Operator package.json (${operatorVersion})`);
if (versionNameMatch && versionNameMatch !== umpireVersion) mismatches.push(`Android versionName (${versionNameMatch}) != Umpire package.json (${umpireVersion})`);
if (apkResult.versionCode && versionCodeMatch && apkResult.versionCode !== versionCodeMatch) mismatches.push(`Built APK versionCode (${apkResult.versionCode}) != build.gradle versionCode (${versionCodeMatch})`);
if (mismatches.length) {
  console.log("\nWARNING — version mismatch detected (build still succeeded, but investigate before shipping):");
  for (const m of mismatches) console.log(`  - ${m}`);
} else {
  console.log("  All versions consistent.");
}

// --- Report ---
const durationSec = Math.round((Date.now() - startedAt) / 1000);
console.log(`
========================================
BUILD COMPLETE
===============

Duration: ${durationSec}s

Operator web:
PASS — ${operatorDist}

Umpire web:
PASS — ${umpireDist}

Windows installer:
PASS — ${winResult.path} (${winResult.size} bytes)

Android APK:
PASS — ${apkResult.path} (${apkResult.size} bytes) — applicationId ${apkResult.appId}, signed
${mismatches.length ? `\nVersion warnings: ${mismatches.length} (see above)` : "\nVersions: consistent"}
========================================`);
