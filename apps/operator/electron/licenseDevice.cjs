"use strict";
// Stable PC identifier for license binding.
//
// Primary: SHA-256 of the Windows MachineGuid (survives app reinstall and
// userData wipes; the raw GUID never leaves this PC). Fallback: a random UUID
// persisted in the app's userData folder. The computer name is sent only as a
// human-readable label; it is never the identity (names are not unique).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const FILE = "license-install-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GUID_RE = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/;

function readMachineGuid({ exec = execFile, platform = process.platform } = {}) {
  if (platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      exec(
        "reg",
        ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
        { windowsHide: true, timeout: 5000 },
        (err, stdout) => resolve(err ? null : (GUID_RE.exec(String(stdout)) || [])[1] || null),
      );
    } catch {
      resolve(null);
    }
  });
}

function readOrCreateInstallId(dir, { fsImpl = fs, uuid = () => crypto.randomUUID() } = {}) {
  const file = path.join(dir, FILE);
  try {
    const existing = String(fsImpl.readFileSync(file, "utf8")).trim();
    if (UUID_RE.test(existing)) return existing;
  } catch {
    /* first run, or unreadable: create below */
  }
  const id = uuid();
  try {
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(file, id, "utf8");
  } catch {
    /* cannot persist: this launch still works */
  }
  return id;
}

async function getLicenseDevice({ userDataDir, hostname = os.hostname(), fsImpl, uuid, readGuid = readMachineGuid } = {}) {
  const guid = await readGuid();
  const deviceId = guid
    ? `win-${crypto.createHash("sha256").update(`tournament-operator|${guid.toLowerCase()}`).digest("hex").slice(0, 32)}`
    : `win-${readOrCreateInstallId(userDataDir, { fsImpl, uuid })}`;
  return { deviceId, label: String(hostname || "Windows PC").slice(0, 80) };
}

module.exports = { getLicenseDevice, readMachineGuid, readOrCreateInstallId, FILE };
