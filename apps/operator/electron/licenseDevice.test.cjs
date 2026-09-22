"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { getLicenseDevice, readMachineGuid, readOrCreateInstallId, FILE } = require("./licenseDevice.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "op-license-"));
const GUID = "1b2c3d4e-1111-2222-3333-444455556666";
const noGuid = async () => null;

test("machine GUID is parsed from reg output (Windows only)", async () => {
  const exec = (_c, _a, _o, cb) => cb(null, `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    ${GUID}\r\n`);
  assert.equal(await readMachineGuid({ exec, platform: "win32" }), GUID);
  assert.equal(await readMachineGuid({ exec, platform: "linux" }), null);
  assert.equal(await readMachineGuid({ exec: (_c, _a, _o, cb) => cb(new Error("denied"), ""), platform: "win32" }), null);
  assert.equal(await readMachineGuid({ exec: (_c, _a, _o, cb) => cb(null, "garbage"), platform: "win32" }), null);
});

test("the same PC always gets the same id, even after a reinstall wipes userData", async () => {
  const a = await getLicenseDevice({ userDataDir: tmp(), hostname: "BOB-PC", readGuid: async () => GUID });
  const reinstall = await getLicenseDevice({ userDataDir: tmp(), hostname: "RENAMED-PC", readGuid: async () => GUID });
  assert.equal(a.deviceId, reinstall.deviceId);
  assert.match(a.deviceId, /^win-[0-9a-f]{32}$/);
  assert.match(a.deviceId, /^[A-Za-z0-9._:-]{8,128}$/);
  assert.ok(!a.deviceId.includes(GUID.replaceAll("-", "")), "raw machine GUID is never exposed");
});

test("two different PCs get different ids, even with the same computer name", async () => {
  const one = await getLicenseDevice({ userDataDir: tmp(), hostname: "SAME-NAME", readGuid: async () => GUID });
  const two = await getLicenseDevice({ userDataDir: tmp(), hostname: "SAME-NAME", readGuid: async () => "aaaaaaaa-0000-0000-0000-bbbbbbbbbbbb" });
  assert.notEqual(one.deviceId, two.deviceId);
});

test("the hostname is only a label and is truncated", async () => {
  const d = await getLicenseDevice({ userDataDir: tmp(), hostname: "x".repeat(300), readGuid: async () => GUID });
  assert.equal(d.label.length, 80);
  assert.doesNotMatch(d.deviceId, /x{5}/);
});

test("without a machine GUID it falls back to a persisted install id", async () => {
  const dir = tmp();
  const a = await getLicenseDevice({ userDataDir: dir, readGuid: noGuid });
  const b = await getLicenseDevice({ userDataDir: dir, readGuid: noGuid });
  assert.equal(a.deviceId, b.deviceId);
  assert.match(a.deviceId, /^win-[0-9a-f-]{36}$/);
  assert.equal(fs.readFileSync(path.join(dir, FILE), "utf8"), a.deviceId.slice(4));
});

test("a corrupted install-id file is replaced; an unwritable folder still yields an id", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, FILE), "not-a-uuid");
  assert.match(readOrCreateInstallId(dir), /^[0-9a-f-]{36}$/);
  const failing = { readFileSync() { throw new Error("x"); }, mkdirSync() { throw new Error("ro"); }, writeFileSync() { throw new Error("ro"); } };
  assert.match(readOrCreateInstallId("/nowhere", { fsImpl: failing }), /^[0-9a-f-]{36}$/);
});
