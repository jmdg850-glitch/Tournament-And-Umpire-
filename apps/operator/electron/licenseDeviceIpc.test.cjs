"use strict";
// Exercises the REAL Electron main -> preload -> renderer IPC path for
// license device identity (window.tournamentDesktop.getLicenseDevice()),
// not just the licenseDevice.cjs helper directly (see licenseDevice.test.cjs
// for that). A Node-only test of the helper cannot prove the IPC wiring
// itself is correct, sandboxed, or free of raw-identifier leakage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readMachineGuid } = require("./licenseDevice.cjs");

const electronBin = require("electron");
const MAIN_CJS = path.join(__dirname, "main.cjs");
const HARNESS = path.join(__dirname, "licenseDeviceIpcHarness.cjs");
const HANDLE_RE = /ipcMain\.handle\("license:get-device",[^\n]*\);/;

function readIpcRegistrationLine(file) {
  const src = fs.readFileSync(file, "utf8");
  const m = HANDLE_RE.exec(src);
  assert.ok(m, `expected to find the license:get-device ipcMain.handle registration in ${file}`);
  return m[0];
}

test("the IPC test harness registers the exact same license:get-device handler as production main.cjs", () => {
  assert.equal(readIpcRegistrationLine(HARNESS), readIpcRegistrationLine(MAIN_CJS));
});

test(
  "real Electron main -> preload -> renderer IPC path returns a stable, hashed device id and never the raw MachineGuid",
  { timeout: 60_000 },
  async () => {
    const guid = await readMachineGuid();
    if (!guid) {
      // Not Windows, or the registry key is unreadable in this environment:
      // there is no real MachineGuid-backed IPC path to verify here.
      // licenseDevice.test.cjs already covers the fallback branch directly.
      return;
    }

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "op-license-ipc-"));
    // ELECTRON_RUN_AS_NODE (set by some shells/CI to stop a stray Electron
    // launch from opening a GUI) makes the Electron binary boot as a plain
    // Node interpreter instead of the real Electron app process, so
    // require("electron") inside the harness resolves to the binary path
    // string instead of {app, BrowserWindow, ipcMain} — leaving app
    // undefined. Strip it so the harness always gets the real Electron API,
    // regardless of what the parent process happens to have set.
    const spawnEnv = { ...process.env };
    delete spawnEnv.ELECTRON_RUN_AS_NODE;
    const proc = spawnSync(
      electronBin,
      [HARNESS, `--user-data-dir=${userDataDir}`, "--disable-gpu", "--no-sandbox"],
      { encoding: "utf8", timeout: 45_000, env: spawnEnv },
    );

    const combinedOutput = `${proc.stdout || ""}\n${proc.stderr || ""}`;
    const guidNoDashes = guid.replaceAll("-", "");
    assert.ok(
      !new RegExp(guid, "i").test(combinedOutput),
      "raw machine GUID must never appear in the Electron process's output",
    );
    assert.ok(
      !new RegExp(guidNoDashes, "i").test(combinedOutput),
      "raw machine GUID (dashes stripped) must never appear in the Electron process's output",
    );

    const errMatch = /IPC_TEST_ERROR:(.+)/.exec(proc.stdout || "");
    assert.ok(!errMatch, `Electron IPC harness reported an error: ${errMatch && errMatch[1]}\nstderr:\n${proc.stderr}`);

    const resultMatch = /IPC_TEST_RESULT:(.+)/.exec(proc.stdout || "");
    assert.ok(
      resultMatch,
      `Electron harness produced no result (exit ${proc.status}).\nstdout:\n${proc.stdout}\nstderr:\n${proc.stderr}`,
    );
    const { first, second, hasBridge } = JSON.parse(resultMatch[1]);

    assert.equal(hasBridge, true, "contextBridge must expose tournamentDesktop without leaking Node globals to the page");
    assert.match(first.deviceId, /^win-[0-9a-f]{32}$/);
    assert.equal(first.deviceId, second.deviceId, "the same PC must get the same id across repeated real IPC calls");
    assert.equal(typeof first.label, "string");
    assert.ok(
      !first.deviceId.toLowerCase().includes(guidNoDashes.toLowerCase()),
      "the raw machine GUID must never be embedded in the exposed device id",
    );
  },
);
