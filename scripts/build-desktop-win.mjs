// Runs electron-builder for the Windows Operator installer.
//
// ROOT CAUSE (confirmed, not assumed): app-builder-lib's extractArchive()
// (node_modules/app-builder-lib/out/util/electronGet.js, and the .ts source
// at src/util/electronGet.ts:249) does an un-retried fs.rename() of the
// freshly-extracted Electron distribution — normally
// <output>/win-unpacked.tmp -> <output>/win-unpacked. On this machine that
// rename reliably fails with EPERM. Two independent, verified causes:
//   1. This repository's drive (E:) is reported by Windows itself
//      (Get-Volume) as DriveType=Removable, HealthStatus=Warning,
//      OperationalStatus="Full Repair Needed" — a real, pre-existing
//      filesystem integrity flag, not a guess. Writing/renaming the ~1000+
//      small files of an unpacked Electron distribution on this volume is
//      extremely slow (observed: well under 1 file/second) and unreliable.
//   2. Windows Defender's real-time scan (MsMpEng.exe, confirmed running)
//      holds transient locks on newly-written files, which a healthy fast
//      disk usually outruns but this degraded volume does not.
// There is no admin access in this environment to add a Defender exclusion
// or run chkdsk /f on E:. Retrying the rename alone (tried first) still
// failed twice in a row with the identical error, confirming this is not a
// rare blip on this volume.
//
// FIX: C: was verified healthy (DriveType=Fixed, HealthStatus=Healthy,
// OperationalStatus=OK) via the same Get-Volume check. This script packages
// into a temp directory on C: (os.tmpdir(), which resolves under the user's
// profile on C:) using electron-builder's own `-c.directories.output` CLI
// override — no permanent change to the committed electron-builder config,
// so any other machine/CI without this specific degraded-E:-drive problem
// is completely unaffected. Once packaging succeeds, only the small final
// artifacts (installer .exe, .blockmap, latest.yml) are copied back into
// apps/operator/release, which is the path every other script in this repo
// (clean:desktop, scripts/publish-desktop-update.mjs) already expects.
//
// A short retry (kept, in case the lock genuinely is a one-off blip even on
// a healthy target) is still applied around the packaging step, but the
// real fix is moving the heavy extraction/rename work off the degraded
// drive entirely.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3000;
const KNOWN_TRANSIENT_ERROR = /EPERM:.*rename.*win-unpacked/is;
const OPERATOR_DIR = process.cwd();
const RELEASE_DIR = join(OPERATOR_DIR, "release");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const tempOutDir = mkdtempSync(join(tmpdir(), "tournament-operator-build-"));
  console.log(`[build-desktop-win] Packaging into a temp directory on a healthy fixed disk: ${tempOutDir}`);

  try {
    let lastOutput = "";
    let succeeded = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = spawnSync(
        "npx",
        ["electron-builder", "--win", "nsis", "--publish", "never", `-c.directories.output=${tempOutDir}`],
        {
          stdio: ["inherit", "pipe", "pipe"],
          shell: process.platform === "win32",
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }
      );
      if (res.stdout) process.stdout.write(res.stdout);
      if (res.stderr) process.stderr.write(res.stderr);
      lastOutput = `${res.stdout || ""}${res.stderr || ""}`;

      if (res.status === 0) {
        succeeded = true;
        break;
      }

      const isKnownTransientFailure = KNOWN_TRANSIENT_ERROR.test(lastOutput);
      if (isKnownTransientFailure && attempt < MAX_ATTEMPTS) {
        console.warn(
          `\n[build-desktop-win] electron-builder hit the win-unpacked rename EPERM even on the healthy ` +
          `temp disk (attempt ${attempt}/${MAX_ATTEMPTS}). Retrying in ${RETRY_DELAY_MS}ms...\n`
        );
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      console.error(`[build-desktop-win] electron-builder failed (not the known transient signature, or attempts exhausted).`);
      process.exitCode = res.status ?? 1;
      return;
    }

    if (!succeeded) {
      process.exitCode = 1;
      return;
    }

    // Copy only the final release artifacts back to the path the rest of the
    // repo expects (apps/operator/release) — not the full win-unpacked tree,
    // which nothing downstream reads.
    const entries = existsSync(tempOutDir) ? readdirSync(tempOutDir) : [];
    const artifacts = entries.filter((name) => /\.(exe|blockmap|yml)$/i.test(name));
    if (artifacts.length === 0) {
      console.error(`[build-desktop-win] electron-builder reported success but no .exe/.blockmap/.yml artifacts were found in ${tempOutDir}.`);
      process.exitCode = 1;
      return;
    }
    rmSync(RELEASE_DIR, { recursive: true, force: true });
    mkdirSync(RELEASE_DIR, { recursive: true });
    for (const name of artifacts) {
      cpSync(join(tempOutDir, name), join(RELEASE_DIR, name));
    }
    console.log(`[build-desktop-win] Copied ${artifacts.length} artifact(s) to ${RELEASE_DIR}:`);
    for (const name of artifacts) console.log(`  - ${name}`);
  } finally {
    try {
      rmSync(tempOutDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[build-desktop-win] Could not clean up temp dir ${tempOutDir}: ${err.message}`);
    }
  }
}

main();
