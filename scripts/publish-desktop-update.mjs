// Publishes the built Windows desktop updates to ONE GitHub Release on the
// owner/repo configured in apps/operator/package.json (build.publish):
//   Operator:      installer + .blockmap + latest.yml         (channel "latest")
//   License Admin: installer + .blockmap + license-admin.yml  (channel "license-admin")
// Both apps are required: every published (= "Latest") release must carry both
// update-info files, since electron-updater reads `${channel}.yml` from the
// latest release. That repository also contains the application source — it is
// not a separate releases-only repo. See apps/operator/electron/updatePolicy.cjs
// and apps/license-admin/electron/updatePolicy.cjs for what each running app checks.
//
// Auth: uses the `gh` CLI's own credential store (gh auth login), or the
// GH_TOKEN / GITHUB_TOKEN environment variable if set — gh picks either up
// automatically. This script never reads, prints, or stores a token itself.
//
// Safety: the release is created as a DRAFT, assets are uploaded one at a
// time (installers and blockmaps, then the .yml files last), and the release is only
// flipped to published after every asset upload succeeds. If an upload fails
// partway, the draft is left in place with whatever partial assets it has —
// electron-updater never sees a draft release, so a partial/failed publish
// can never be picked up by an installed app. Rerun this script (or delete
// the draft with `gh release delete <tag> --repo <owner>/<repo>`) to retry.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const operatorDir = resolve(root, "apps/operator");
const checkOnly = process.argv.includes("--check");

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts });
}

function tryRun(cmd, args, opts = {}) {
  try {
    return { ok: true, output: run(cmd, args, opts) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

// --- Resolve owner/repo from the single source of truth (electron-builder config) ---
// Operator's build.publish is the release target. License Admin must point at
// the SAME owner/repo but a different channel, so both apps' assets live in
// one GitHub Release while each app reads only its own update-info file:
//   Operator      -> latest.yml         (default channel)
//   License Admin -> license-admin.yml  (channel "license-admin")
const DESKTOP_APPS = [
  {
    label: "Operator",
    workspace: "@tournament/operator",
    dir: operatorDir,
    artifactPrefix: "Tournament-Operator-Setup",
    channel: "latest",
  },
  {
    label: "License Admin",
    workspace: "@tournament/license-admin",
    dir: resolve(root, "apps/license-admin"),
    artifactPrefix: "Tournament-License-Admin-Setup",
    channel: "license-admin",
  },
];

for (const desktopApp of DESKTOP_APPS) {
  desktopApp.pkg = JSON.parse(readFileSync(resolve(desktopApp.dir, "package.json"), "utf8"));
  desktopApp.version = desktopApp.pkg.version;
  desktopApp.releaseDir = resolve(desktopApp.dir, "release");
  desktopApp.channelFile = `${desktopApp.channel}.yml`;
}
const [operatorApp, licenseAdminApp] = DESKTOP_APPS;

const pkg = operatorApp.pkg;
const version = operatorApp.version;
const publishCfg = pkg.build?.publish;

if (!publishCfg || publishCfg.provider !== "github" || !publishCfg.owner || !publishCfg.repo) {
  console.error(`apps/operator/package.json build.publish is missing or is not a valid GitHub provider config.`);
  console.error(`Expected: { "provider": "github", "owner": "...", "repo": "..." }`);
  process.exit(1);
}
const { owner, repo } = publishCfg;
const ghRepo = `${owner}/${repo}`;

// Channel safety: Operator must stay on the default channel (latest.yml), and
// License Admin must publish to the same repo under its own channel.
if (publishCfg.channel != null && publishCfg.channel !== "latest") {
  console.error(`apps/operator/package.json build.publish.channel is "${publishCfg.channel}" — Operator must stay on the default "latest" channel (latest.yml).`);
  process.exit(1);
}
const laPublishCfg = licenseAdminApp.pkg.build?.publish;
if (
  !laPublishCfg ||
  laPublishCfg.provider !== "github" ||
  laPublishCfg.owner !== owner ||
  laPublishCfg.repo !== repo ||
  laPublishCfg.channel !== licenseAdminApp.channel
) {
  console.error("apps/license-admin/package.json build.publish must be the same GitHub owner/repo as Operator with its own channel:");
  console.error(`  expected: { provider: "github", owner: "${owner}", repo: "${repo}", channel: "${licenseAdminApp.channel}" }`);
  console.error(`  actual:   ${JSON.stringify(laPublishCfg ?? null)}`);
  process.exit(1);
}
if (operatorApp.channelFile === licenseAdminApp.channelFile || operatorApp.artifactPrefix === licenseAdminApp.artifactPrefix) {
  console.error("Operator and License Admin must use distinct update channels and installer names.");
  process.exit(1);
}

// Cross-check against each app's runtime updater config so a packaged app and
// the publisher can never silently drift apart.
const updatePolicy = await import(pathToFileURL(resolve(operatorDir, "electron/updatePolicy.cjs")));
const runtimeCfg = updatePolicy.githubPublishConfig();
if (runtimeCfg.owner !== owner || runtimeCfg.repo !== repo) {
  console.error("Inconsistent GitHub target between build config and runtime updater:");
  console.error(`  apps/operator/package.json build.publish -> ${owner}/${repo}`);
  console.error(`  apps/operator/electron/updatePolicy.cjs   -> ${runtimeCfg.owner}/${runtimeCfg.repo}`);
  console.error("Fix one of these before publishing — a packaged app must check the same repo this script publishes to.");
  process.exit(1);
}
const laUpdatePolicy = await import(pathToFileURL(resolve(licenseAdminApp.dir, "electron/updatePolicy.cjs")));
const laRuntimeCfg = laUpdatePolicy.githubPublishConfig();
if (laRuntimeCfg.owner !== owner || laRuntimeCfg.repo !== repo || laRuntimeCfg.channel !== licenseAdminApp.channel) {
  console.error("Inconsistent GitHub target between License Admin's build config and its runtime updater:");
  console.error(`  expected -> ${owner}/${repo} channel ${licenseAdminApp.channel}`);
  console.error(`  apps/license-admin/electron/updatePolicy.cjs -> ${laRuntimeCfg.owner}/${laRuntimeCfg.repo} channel ${laRuntimeCfg.channel}`);
  process.exit(1);
}

if (!version) {
  console.error("apps/operator/package.json has no version.");
  process.exit(1);
}
const tag = `v${version}`;

// --- Verify local release artifacts exist and are internally consistent ---
function verifyDesktopArtifacts(desktopApp) {
  const { label, workspace, releaseDir, channelFile, artifactPrefix } = desktopApp;
  const rebuild = `npm run build:desktop -w ${workspace}`;
  if (!desktopApp.version) {
    console.error(`${label} package.json has no version.`);
    process.exit(1);
  }
  // A foreign channel file in this app's release dir means the build config
  // drifted — refuse rather than risk publishing the wrong metadata.
  for (const other of DESKTOP_APPS) {
    if (other !== desktopApp && existsSync(resolve(releaseDir, other.channelFile))) {
      console.error(`${label}'s release folder contains ${other.channelFile}, which belongs to ${other.label}'s update channel. Check ${label}'s build.publish config and rebuild with ${rebuild}.`);
      process.exit(1);
    }
  }
  const latestPath = resolve(releaseDir, channelFile);
  if (!existsSync(latestPath)) {
    console.error(`Missing ${latestPath}. Run ${rebuild} first.`);
    process.exit(1);
  }
  const latestRaw = readFileSync(latestPath, "utf8");
  const latestVersion = (latestRaw.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
  const setupName = (latestRaw.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
  const declaredSha512 = (latestRaw.match(/^sha512:\s*(.+)$/m) || [])[1]?.trim();

  if (!latestVersion || !setupName || !declaredSha512) {
    console.error(`Could not parse version/path/sha512 from ${label} ${channelFile}.`);
    process.exit(1);
  }
  if (latestVersion !== desktopApp.version) {
    console.error(`Version mismatch: ${label} package.json is ${desktopApp.version}, but ${channelFile} says ${latestVersion}.`);
    console.error(`Rebuild with ${rebuild} before publishing.`);
    process.exit(1);
  }

  const installerPath = resolve(releaseDir, setupName);
  const blockmapPath = resolve(releaseDir, `${setupName}.blockmap`);
  const expectedName = `${artifactPrefix}-${desktopApp.version}.exe`;
  if (setupName !== expectedName) {
    console.error(`${channelFile} points at "${setupName}", expected "${expectedName}" for ${label} ${desktopApp.version}.`);
    process.exit(1);
  }

  const files = [installerPath, blockmapPath, latestPath];
  for (const file of files) {
    if (!existsSync(file)) {
      console.error(`Missing release artifact: ${file}`);
      process.exit(1);
    }
  }

  // Recompute the installer's sha512 locally and cross-check against the
  // channel file rather than trusting the file electron-builder wrote.
  const installerBytes = readFileSync(installerPath);
  const actualSha512 = createHash("sha512").update(installerBytes).digest("base64");
  if (actualSha512 !== declaredSha512) {
    console.error(`${label} ${channelFile} sha512 does not match the actual installer bytes on disk.`);
    console.error(`  ${channelFile}: ${declaredSha512}`);
    console.error(`  computed (.exe): ${actualSha512}`);
    console.error(`Rebuild with ${rebuild} before publishing.`);
    process.exit(1);
  }
  const declaredSize = Number((latestRaw.match(/^\s*size:\s*(\d+)$/m) || [])[1]);
  const actualSize = statSync(installerPath).size;
  if (declaredSize && declaredSize !== actualSize) {
    console.error(`${label} ${channelFile} declares size ${declaredSize} but the installer on disk is ${actualSize} bytes.`);
    process.exit(1);
  }

  console.log(`${label}:`);
  console.log(`  Version:    ${desktopApp.version}`);
  console.log(`  Channel:    ${desktopApp.channel} (${channelFile})`);
  console.log(`  Installer:  ${basename(installerPath)} (${actualSize} bytes)`);
  console.log(`  sha512 verified against ${channelFile}.`);
  return files;
}

console.log(`Tag:        ${tag}`);
console.log(`Repository: ${ghRepo}`);
const operatorFiles = verifyDesktopArtifacts(operatorApp);
const licenseAdminFiles = verifyDesktopArtifacts(licenseAdminApp);
// Installers and blockmaps first, update-info files last (Operator's latest.yml
// at the very end). The release stays a draft until every upload succeeds.
const files = [
  ...operatorFiles.slice(0, 2),
  ...licenseAdminFiles.slice(0, 2),
  licenseAdminFiles[2],
  operatorFiles[2],
];
if (new Set(files.map((f) => basename(f))).size !== files.length) {
  console.error("Duplicate asset names across Operator and License Admin — refusing to publish.");
  process.exit(1);
}

// --- Auth check ---
const ghVersion = tryRun("gh", ["--version"]);
if (!ghVersion.ok) {
  console.error("GitHub CLI (`gh`) is not installed or not on PATH. Install it from https://cli.github.com/ or set GH_TOKEN/GITHUB_TOKEN in the environment for a token-based flow.");
  process.exit(1);
}
const authStatus = tryRun("gh", ["auth", "status"]);
if (!authStatus.ok) {
  console.error("Not authenticated to GitHub. Run `gh auth login`, or set GH_TOKEN / GITHUB_TOKEN in your OWN shell before running this command.");
  console.error("Never hardcode or commit a token — this script reads no token itself; `gh` resolves auth on its own.");
  process.exit(1);
}

const repoView = tryRun("gh", ["repo", "view", ghRepo, "--json", "name,visibility"]);
if (!repoView.ok) {
  console.error(`Could not reach GitHub repo ${ghRepo}. Confirm it exists and your account has access.`);
  process.exit(1);
}

if (checkOnly) {
  console.log("Preflight check passed: gh CLI authenticated, repo reachable, local artifacts consistent.");
  console.log("(--check does not build, tag, or publish anything.)");
  process.exit(0);
}

// --- Does a release for this tag already exist? ---
const existing = tryRun("gh", ["release", "view", tag, "--repo", ghRepo, "--json", "isDraft,assets,tagName"]);
if (existing.ok) {
  const info = JSON.parse(existing.output);
  const expectedAssets = files.map((f) => ({ name: basename(f), size: statSync(f).size }));
  const actualAssets = (info.assets || []).map((a) => ({ name: a.name, size: a.size }));
  const matches =
    !info.isDraft &&
    expectedAssets.length === actualAssets.length &&
    expectedAssets.every((exp) =>
      actualAssets.some((act) => act.name === exp.name && act.size === exp.size)
    );

  if (matches) {
    console.log(`Release ${tag} already exists on ${ghRepo} and matches the local build exactly. Nothing to do.`);
    process.exit(0);
  }

  console.error(`Release ${tag} already exists on ${ghRepo} but does not match this local build.`);
  console.error(`  draft: ${info.isDraft}`);
  console.error(`  remote assets: ${actualAssets.map((a) => `${a.name} (${a.size}b)`).join(", ") || "(none)"}`);
  console.error(`  expected:      ${expectedAssets.map((a) => `${a.name} (${a.size}b)`).join(", ")}`);
  console.error("Refusing to overwrite blindly. Inspect the release on GitHub, and either:");
  console.error(`  - delete it if it's a stale/incomplete attempt: gh release delete ${tag} --repo ${ghRepo} --yes`);
  console.error(`  - or bump the version if ${tag} is meant to be a different release.`);
  process.exit(1);
}

// --- Create as draft, upload in order, publish only once all succeed ---
console.log(`Creating draft release ${tag} on ${ghRepo}...`);
const create = tryRun("gh", [
  "release", "create", tag,
  "--repo", ghRepo,
  "--draft",
  "--title", tag,
  "--notes", `Tournament Operator ${version} and Tournament License Admin ${licenseAdminApp.version} — Windows desktop updates.`,
]);
if (!create.ok) {
  console.error(`Failed to create draft release ${tag}: ${create.error.message}`);
  process.exit(1);
}

for (const file of files) {
  const name = basename(file);
  console.log(`Uploading ${name}...`);
  const upload = tryRun("gh", ["release", "upload", tag, file, "--repo", ghRepo]);
  if (!upload.ok) {
    console.error(`Upload FAILED for ${name}: ${upload.error.message}`);
    console.error(`Release ${tag} was left as a DRAFT on ${ghRepo} with only the assets uploaded so far.`);
    console.error("electron-updater never sees draft releases, so no installed app can pick this up.");
    console.error(`Fix the issue and rerun this script, or discard the draft: gh release delete ${tag} --repo ${ghRepo} --yes`);
    process.exit(1);
  }
}

console.log("Publishing release (flipping off draft status)...");
const publish = tryRun("gh", ["release", "edit", tag, "--repo", ghRepo, "--draft=false"]);
if (!publish.ok) {
  console.error(`All assets uploaded, but failed to un-draft the release: ${publish.error.message}`);
  console.error(`Publish it manually: gh release edit ${tag} --repo ${ghRepo} --draft=false`);
  process.exit(1);
}

// --- Verify the published release ---
console.log("Verifying published release...");
const verify = JSON.parse(run("gh", ["release", "view", tag, "--repo", ghRepo, "--json", "isDraft,assets,url"]));
if (verify.isDraft) {
  console.error("Release still reports as draft after publish. Check manually.");
  process.exit(1);
}
for (const file of files) {
  const name = basename(file);
  const expectedSize = statSync(file).size;
  const asset = (verify.assets || []).find((a) => a.name === name);
  if (!asset) {
    console.error(`Published release is missing asset ${name}.`);
    process.exit(1);
  }
  if (asset.size !== expectedSize) {
    console.error(`Asset ${name} size mismatch: local ${expectedSize}b, remote ${asset.size}b.`);
    process.exit(1);
  }
}

console.log("Checking public reachability of each asset...");
// Uses the GitHub API asset-download endpoint (which redirects to the actual
// CDN) rather than the plain github.com/.../releases/download URL — both work
// for a public repo, but the API endpoint is reachable from more restrictive
// networks/proxies. A 1-byte range request avoids pulling the full ~90MB
// installer just to confirm reachability.
for (const file of files) {
  const name = basename(file);
  const expectedSize = statSync(file).size;
  const asset = (verify.assets || []).find((a) => a.name === name);
  let res;
  try {
    res = await fetch(asset.apiUrl, {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "application/octet-stream", Range: "bytes=0-0" },
    });
  } catch (err) {
    console.error(`Could not reach ${name} (${err.message || err}). This may be a transient network issue — retry, or verify manually at ${verify.url}`);
    process.exit(1);
  }
  if (res.status !== 206 && res.status !== 200) {
    console.error(`Public asset ${name} is not reachable (status ${res.status}).`);
    process.exit(1);
  }
  const contentRange = res.headers.get("content-range");
  const remoteSize = contentRange ? Number(contentRange.split("/")[1]) : Number(res.headers.get("content-length") || 0);
  try { await res.body?.cancel(); } catch { /* ignore */ }
  if (remoteSize !== expectedSize) {
    console.error(`Public ${name} size mismatch: expected ${expectedSize} bytes, server reports ${remoteSize} bytes.`);
    process.exit(1);
  }
  console.log(`  ${name}: reachable, ${remoteSize} bytes (matches local file)`);
}

console.log("");
console.log(`Release ${tag} published: ${verify.url}`);
console.log(`Installed Operator apps will see ${version} (latest.yml) and installed License Admin apps will see ${licenseAdminApp.version} (license-admin.yml) on their next update check.`);
