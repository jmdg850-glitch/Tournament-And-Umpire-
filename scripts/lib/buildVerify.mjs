// Shared process-execution and build-artifact verification helpers.
// Extracted from scripts/release.mjs so scripts/build-all.mjs can verify
// Windows/Android artifacts the same way a release does, without duplicating
// the aapt/apksigner logic. release.mjs imports these back in — its own
// behavior is unchanged, only where these functions live moved.
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// On Windows, spawnSync/execFileSync with shell:true hands the whole command
// line to cmd.exe as a raw string — cmd.exe tokenizes on whitespace before
// anything else, and (unlike a shell:false spawn, which goes through
// CreateProcess's own argv escaping) Node does NOT quote `cmd` or any `args`
// element for you. An absolute path containing a space (this repo's own
// directory included) therefore gets split apart and treated as two separate
// words. Quoting is safe to apply unconditionally to anything containing a
// space; things that never contain one (bare command names, flags like -w)
// are returned unchanged.
export function quoteForWindowsShell(value) {
  if (process.platform !== "win32") return value;
  if (!/\s/.test(value)) return value;
  if (/^".*"$/.test(value)) return value;
  return `"${value}"`;
}

export function run(cmd, args, opts = {}) {
  const res = spawnSync(quoteForWindowsShell(cmd), (args || []).map(quoteForWindowsShell), { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (res.error) throw res.error;
  return res.status ?? 1;
}
export function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}
export function tryCapture(cmd, args, opts = {}) {
  try {
    return { ok: true, output: runCapture(cmd, args, opts) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function findJavaHome() {
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
export function findAndroidSdk(androidDir) {
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
export function findLatestBuildTools(sdkPath) {
  const dir = resolve(sdkPath, "build-tools");
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).filter((v) => existsSync(resolve(dir, v, "aapt.exe")));
  if (!versions.length) return null;
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return resolve(dir, versions[versions.length - 1]);
}

function readFileHead(path, bytes) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// Returns { ok: true } or { ok: false, error }. Reads only the first 2 MB: the
// PE header and the NSIS stub (which carries the "Nullsoft" / "NSIS" strings)
// sit at the very start of the installer, so the ~90 MB payload is never loaded.
export function checkNsisInstaller(path) {
  const head = readFileHead(path, 2_000_000);
  if (head.length < 2 || head[0] !== 0x4d || head[1] !== 0x5a) {
    return { ok: false, error: `${path} does not start with an MZ (Windows PE) header.` };
  }
  const text = head.toString("latin1");
  if (!text.includes("Nullsoft") || !text.includes("NSIS")) {
    return { ok: false, error: `${path} has no NSIS (Nullsoft) installer stub — it is not the NSIS installer electron-builder should produce.` };
  }
  return { ok: true };
}

function powershell(command) {
  return tryCapture("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]);
}
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;

// Reporting only — never used to block a build. Returns { label, signed, status }
// where label is "SIGNED", "UNSIGNED", or "UNVERIFIED (...)" when Authenticode
// could not be evaluated or reported something other than Valid/NotSigned.
export function getAuthenticodeStatus(path) {
  const res = powershell(`(Get-AuthenticodeSignature -LiteralPath ${psQuote(path)}).Status`);
  if (!res.ok) return { label: "UNVERIFIED (could not run Get-AuthenticodeSignature)", signed: null, status: null };
  const status = res.output.trim();
  if (status === "Valid") return { label: "SIGNED", signed: true, status };
  if (status === "NotSigned") return { label: "UNSIGNED", signed: false, status };
  return { label: `UNVERIFIED (Authenticode status: ${status || "unknown"})`, signed: null, status };
}

// Returns the installer's embedded ProductVersion, or null if it could not be read.
export function getInstallerProductVersion(path) {
  const res = powershell(`(Get-Item -LiteralPath ${psQuote(path)}).VersionInfo.ProductVersion`);
  return res.ok ? res.output.trim() || null : null;
}

// Returns { ok: true, path, size, mtime, productVersion, authenticode } or { ok: false, error }.
// notOlderThanMs (optional): reject an installer whose mtime predates this build run,
// so a stale artifact left over from an earlier build can never pass as the new one.
export function verifyWindowsInstaller({ root, operatorDir, version, notOlderThanMs }) {
  const checkStatus = run("node", [resolve(root, "scripts/publish-desktop-update.mjs"), "--check"], { cwd: root });
  if (checkStatus !== 0) {
    return { ok: false, error: "Windows release artifact verification failed (see scripts/publish-desktop-update.mjs --check output above)." };
  }
  const installerPath = resolve(operatorDir, `release/Tournament-Operator-Setup-${version}.exe`);
  if (!existsSync(installerPath)) {
    return { ok: false, error: `Expected installer not found at ${installerPath}` };
  }
  const st = statSync(installerPath);
  if (notOlderThanMs != null && st.mtimeMs < notOlderThanMs) {
    return { ok: false, error: `Installer ${installerPath} (modified ${st.mtime.toISOString()}) is older than this build run — refusing to accept a stale artifact.` };
  }
  const nsis = checkNsisInstaller(installerPath);
  if (!nsis.ok) return nsis;
  const productVersion = getInstallerProductVersion(installerPath);
  if (productVersion && productVersion !== version) {
    return { ok: false, error: `Installer ProductVersion is ${productVersion}, expected ${version}.` };
  }
  return { ok: true, path: installerPath, size: st.size, mtime: st.mtime, productVersion, authenticode: getAuthenticodeStatus(installerPath) };
}

// Returns { ok: true, path, size, mtime, appId, versionCode, versionName, signerDn, signerSha256 }
// or { ok: false, error }.
// androidSdk/javaHome are passed in (not re-resolved here) so callers that already
// located them for the Gradle build reuse the same result.
// notOlderThanMs (optional): reject an APK whose mtime predates this build run.
export function verifyAndroidApk({ androidDir, androidSdk, javaHome, expectedAppId, expectedVersionCode, expectedVersionName, notOlderThanMs }) {
  const apkPath = resolve(androidDir, "app/build/outputs/apk/release/app-release.apk");
  if (!existsSync(apkPath)) return { ok: false, error: `Expected release APK not found at ${apkPath}` };
  const apkStat = statSync(apkPath);
  if (notOlderThanMs != null && apkStat.mtimeMs < notOlderThanMs) {
    return { ok: false, error: `APK ${apkPath} (modified ${apkStat.mtime.toISOString()}) is older than this build run — refusing to accept a stale artifact.` };
  }

  // Gradle's own record of which variant this file is. A debug build lands in a
  // different directory, but this confirms it rather than trusting the path.
  const metadataPath = resolve(dirname(apkPath), "output-metadata.json");
  if (!existsSync(metadataPath)) return { ok: false, error: `Missing ${metadataPath} — cannot confirm this is the release variant.` };
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (err) {
    return { ok: false, error: `Could not parse ${metadataPath}: ${err.message}` };
  }
  if (metadata.variantName !== "release") return { ok: false, error: `output-metadata.json variantName is "${metadata.variantName}", expected "release".` };

  const buildTools = findLatestBuildTools(androidSdk);
  if (!buildTools) return { ok: false, error: `No usable build-tools (with aapt.exe) found under ${androidSdk}/build-tools` };

  const badging = tryCapture(resolve(buildTools, "aapt.exe"), ["dump", "badging", apkPath]);
  if (!badging.ok) return { ok: false, error: `aapt dump badging failed: ${badging.error.message}` };
  const pkgLine = badging.output.split(/\r?\n/).find((l) => l.startsWith("package:"));
  const appIdMatch = pkgLine?.match(/name='([^']+)'/);
  const versionCodeOut = pkgLine?.match(/versionCode='([^']+)'/);
  const versionNameOut = pkgLine?.match(/versionName='([^']+)'/);
  if (appIdMatch?.[1] !== expectedAppId) return { ok: false, error: `Unexpected applicationId in APK: ${appIdMatch?.[1]}` };
  if (expectedVersionCode != null && versionCodeOut?.[1] !== String(expectedVersionCode)) {
    return { ok: false, error: `APK versionCode ${versionCodeOut?.[1]} does not match expected ${expectedVersionCode}` };
  }
  if (expectedVersionName != null && versionNameOut?.[1] !== expectedVersionName) {
    return { ok: false, error: `APK versionName ${versionNameOut?.[1]} does not match expected ${expectedVersionName}` };
  }

  const sig = tryCapture(quoteForWindowsShell(resolve(buildTools, "apksigner.bat")), ["verify", "--print-certs", apkPath].map(quoteForWindowsShell), {
    env: { ...process.env, JAVA_HOME: javaHome },
    shell: process.platform === "win32",
  });
  if (!sig.ok) return { ok: false, error: `apksigner verify failed — the release signing config may be broken:\n${sig.error.message}` };

  // A release APK must not be debuggable, and must not be signed with the
  // well-known Android debug certificate.
  if (/^application-debuggable/m.test(badging.output)) return { ok: false, error: "APK is marked debuggable — this is not a release configuration." };
  const signerDn = sig.output.match(/certificate DN:\s*(.+)/)?.[1]?.trim();
  const signerSha256 = sig.output.match(/certificate SHA-256 digest:\s*([0-9a-f]+)/i)?.[1];
  if (!signerDn) return { ok: false, error: "apksigner verify did not report a signer certificate." };
  if (/Android Debug/i.test(signerDn)) return { ok: false, error: `APK is signed with a debug certificate (${signerDn}).` };

  return {
    ok: true,
    path: apkPath,
    size: apkStat.size,
    mtime: apkStat.mtime,
    appId: appIdMatch[1],
    versionCode: versionCodeOut?.[1],
    versionName: versionNameOut?.[1],
    signerDn,
    signerSha256,
  };
}
