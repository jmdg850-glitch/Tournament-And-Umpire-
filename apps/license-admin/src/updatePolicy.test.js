// @vitest-environment node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const policy = require("../electron/updatePolicy.cjs");
const operatorPolicy = require("../../operator/electron/updatePolicy.cjs");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const operatorPkg = JSON.parse(readFileSync(new URL("../../operator/package.json", import.meta.url), "utf8"));

describe("License Admin update policy", () => {
  it("reads the license-admin channel from the shared GitHub repo, never Operator's latest channel", () => {
    expect(policy.githubPublishConfig()).toEqual({
      provider: "github",
      owner: "jmdg850-glitch",
      repo: "Tournament-And-Umpire-",
      channel: "license-admin",
    });
    expect(operatorPolicy.githubPublishConfig().channel).toBeUndefined();
    expect(policy.githubPublishConfig().channel).not.toBe("latest");
  });

  it("matches the electron-builder publish config so the packaged app-update.yml agrees", () => {
    expect(pkg.build.publish).toEqual({ ...policy.githubPublishConfig(), releaseType: "release" });
    expect(pkg.build.publish.owner).toBe(operatorPkg.build.publish.owner);
    expect(pkg.build.publish.repo).toBe(operatorPkg.build.publish.repo);
    expect(operatorPkg.build.publish.channel).toBeUndefined();
    expect(pkg.build.win.artifactName).toMatch(/^Tournament-License-Admin-Setup-/);
    expect(pkg.dependencies["electron-updater"]).toBe(operatorPkg.dependencies["electron-updater"]);
  });

  it("never checks in unpackaged/dev builds or when disabled", () => {
    expect(policy.shouldCheckForUpdates({ packaged: false, disableUpdates: false })).toBe(false);
    expect(policy.shouldCheckForUpdates({ packaged: true, disableUpdates: true })).toBe(false);
    expect(policy.shouldCheckForUpdates({ packaged: true, disableUpdates: false })).toBe(true);
  });

  it("rejects in-flight duplicates and throttles repeated checks", () => {
    expect(policy.nextCheckAllowed({ inProgress: true, lastCheckAt: null, now: 100, minIntervalMs: 50 })).toBe(false);
    expect(policy.nextCheckAllowed({ inProgress: false, lastCheckAt: 80, now: 100, minIntervalMs: 50 })).toBe(false);
    expect(policy.nextCheckAllowed({ inProgress: false, lastCheckAt: 10, now: 100, minIntervalMs: 50 })).toBe(true);
    expect(policy.nextCheckAllowed({ inProgress: false, lastCheckAt: null, now: 100, minIntervalMs: 50 })).toBe(true);
    expect(policy.MIN_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(30 * 60 * 1000);
  });

  it("installs only on explicit confirmation and starts idle with the installed version", () => {
    expect(policy.shouldInstallNow({ userConfirmed: false })).toBe(false);
    expect(policy.shouldInstallNow({ userConfirmed: true })).toBe(true);
    expect(policy.initialUpdaterState("1.0.2")).toMatchObject({ status: "idle", currentVersion: "1.0.2", availableVersion: null });
  });
});
