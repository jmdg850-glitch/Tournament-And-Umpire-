// Publishes the built Windows desktop update (installer + .blockmap + latest.yml)
// to a GitHub Release in the dedicated releases-only repo. This repo hosts no
// application source code — see apps/operator/electron/updatePolicy.cjs for
// the owner/repo the running app itself checks.
//
// Auth: uses the `gh` CLI's own credential store (gh auth login), or the
// GH_TOKEN / GITHUB_TOKEN environment variable if set — gh picks either up
// automatically. This script never reads, prints, or stores a token itself.
//
// Safety: the release is created as a DRAFT, assets are uploaded one at a
// time (installer, blockmap, then latest.yml last), and the release is only
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
const releaseDir = resolve(operatorDir, "release");
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
const pkgPath = resolve(operatorDir, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = pkg.version;
const publishCfg = pkg.build?.publish;

if (!publishCfg || publishCfg.provider !== "github" || !publishCfg.owner || !publishCfg.repo) {
  console.error(`apps/operator/package.json build.publish is missing or is not a valid GitHub provider config.`);
  console.error(`Expected: { "provider": "github", "owner": "...", "repo": "..." }`);
  process.exit(1);
}
const { owner, repo } = publishCfg;
const ghRepo = `${owner}/${repo}`;

// Cross-check against the runtime updater config so the packaged app and the
// publisher can never silently drift apart.
const updatePolicy = await import(pathToFileURL(resolve(operatorDir, "electron/updatePolicy.cjs")));
const runtimeCfg = updatePolicy.githubPublishConfig();
if (runtimeCfg.owner !== owner || runtimeCfg.repo !== repo) {
  console.error("Inconsistent GitHub target between build config and runtime updater:");
  console.error(`  apps/operator/package.json build.publish -> ${owner}/${repo}`);
  console.error(`  apps/operator/electron/updatePolicy.cjs   -> ${runtimeCfg.owner}/${runtimeCfg.repo}`);
  console.error("Fix one of these before publishing — a packaged app must check the same repo this script publishes to.");
  process.exit(1);
}

if (!version) {
  console.error("apps/operator/package.json has no version.");
  process.exit(1);
}
const tag = `v${version}`;

// --- Verify local release artifacts exist and are internally consistent ---
const latestPath = resolve(releaseDir, "latest.yml");
if (!existsSync(latestPath)) {
  console.error(`Missing ${latestPath}. Run npm run build:desktop -w @tournament/operator first.`);
  process.exit(1);
}
const latestRaw = readFileSync(latestPath, "utf8");
const latestVersion = (latestRaw.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
const setupName = (latestRaw.match(/^path:\s*(.+)$/m) || [])[1]?.trim();
const declaredSha512 = (latestRaw.match(/^sha512:\s*(.+)$/m) || [])[1]?.trim();

if (!latestVersion || !setupName || !declaredSha512) {
  console.error("Could not parse version/path/sha512 from latest.yml.");
  process.exit(1);
}
if (latestVersion !== version) {
  console.error(`Version mismatch: apps/operator/package.json is ${version}, but latest.yml says ${latestVersion}.`);
  console.error("Rebuild with npm run build:desktop -w @tournament/operator before publishing.");
  process.exit(1);
}

const installerPath = resolve(releaseDir, setupName);
const blockmapPath = resolve(releaseDir, `${setupName}.blockmap`);
const expectedName = `Tournament-Operator-Setup-${version}.exe`;
if (setupName !== expectedName) {
  console.error(`latest.yml points at "${setupName}", expected "${expectedName}" for version ${version}.`);
  process.exit(1);
}

const files = [installerPath, blockmapPath, latestPath];
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`Missing release artifact: ${file}`);
    process.exit(1);
  }
}

// Recompute the installer's sha512 locally and cross-check against latest.yml
// rather than trusting the file electron-builder wrote.
const installerBytes = readFileSync(installerPath);
const actualSha512 = createHash("sha512").update(installerBytes).digest("base64");
if (actualSha512 !== declaredSha512) {
  console.error("latest.yml sha512 does not match the actual installer bytes on disk.");
  console.error(`  latest.yml:      ${declaredSha512}`);
  console.error(`  computed (.exe): ${actualSha512}`);
  console.error("Rebuild with npm run build:desktop -w @tournament/operator before publishing.");
  process.exit(1);
}
const declaredSize = Number((latestRaw.match(/^\s*size:\s*(\d+)$/m) || [])[1]);
const actualSize = statSync(installerPath).size;
if (declaredSize && declaredSize !== actualSize) {
  console.error(`latest.yml declares size ${declaredSize} but the installer on disk is ${actualSize} bytes.`);
  process.exit(1);
}

console.log(`Version:    ${version}`);
console.log(`Tag:        ${tag}`);
console.log(`Repository: ${ghRepo}`);
console.log(`Installer:  ${basename(installerPath)} (${actualSize} bytes)`);
console.log(`sha512 verified against latest.yml.`);

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
  "--notes", `Tournament Operator ${version} — Windows desktop update.`,
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
console.log("Installed Operator apps will see this version on the next update check.");
