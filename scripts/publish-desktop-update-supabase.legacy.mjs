// DISABLED / NOT WIRED TO ANY NPM SCRIPT. Kept only as a rollback reference.
// Desktop update distribution moved to GitHub Releases — see
// scripts/publish-desktop-update.mjs for the active publisher. This file is
// the pre-migration Supabase Storage publisher; the Supabase project itself
// is unchanged and still used for auth/database/API — only this publish path
// was retired (the "desktop-updates" bucket / 0009 migration are untouched).
//
// Publishes the built Windows desktop update (latest.yml + installer + blockmap)
// to Supabase Storage. Never put real credentials in this file or in any
// committed file — see .env.example for the variable names this script reads.
//
// Upload order matters: the installer and blockmap are uploaded FIRST, and
// latest.yml — the file electron-updater actually trusts to decide whether an
// update exists — is uploaded LAST. That way, if a large-file upload fails
// partway (e.g. a storage size-limit rejection), the previously-published
// latest.yml is left untouched and never ends up pointing at a version whose
// installer isn't actually there.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const releaseDir = resolve(root, "apps/operator/release");
const bucket = "desktop-updates";
const prefix = "operator/win";
const checkOnly = process.argv.includes("--check");

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

// Local dev convenience only — .env / .env.local files are gitignored and must
// never contain the real service-role/secret key. On a CI/build machine these
// files won't exist and the variables are expected to already be in the
// environment (e.g. a CI secret store).
loadEnvFile(resolve(root, ".env"));
loadEnvFile(resolve(root, ".env.local"));
loadEnvFile(resolve(root, "apps/operator/.env.local"));

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;

// Accept either the classic service-role key or Supabase's newer secret-key
// naming (sb_secret_...) — whichever the project currently issues. Never log
// the value of either, only which variable name was (or wasn't) found.
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const secretKey = process.env.SUPABASE_SECRET_KEY;
const privilegedKey = serviceRoleKey || secretKey;
const privilegedKeyVarName = serviceRoleKey ? "SUPABASE_SERVICE_ROLE_KEY" : secretKey ? "SUPABASE_SECRET_KEY" : null;

const missing = [];
if (!url) missing.push("SUPABASE_URL (or VITE_SUPABASE_URL)");
if (!privilegedKey) missing.push("SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SECRET_KEY)");

if (missing.length) {
  console.error("Cannot publish — missing required environment variable(s):");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("");
  console.error("Set these in your OWN shell before running this command. Never commit them.");
  console.error("See .env.example at the repo root for the exact variable names.");
  console.error("Example (PowerShell, current session only):");
  console.error('  $env:SUPABASE_SERVICE_ROLE_KEY = "paste-the-key-here"');
  process.exit(1);
}

console.log(`Using ${privilegedKeyVarName} for the privileged Supabase credential.`);

if (checkOnly) {
  console.log("Environment check passed: URL and privileged key are both present.");
  console.log("(--check does not build, upload, or touch Supabase Storage.)");
  process.exit(0);
}

const latestPath = resolve(releaseDir, "latest.yml");
if (!existsSync(latestPath)) {
  console.error(`Missing ${latestPath}. Run npm run build:desktop first.`);
  process.exit(1);
}

const latest = readFileSync(latestPath, "utf8");
const version = (latest.match(/^version:\s*(.+)$/m) || [])[1]?.trim();
const setupName = (latest.match(/path:\s*(.+)$/m) || latest.match(/url:\s*(Tournament-Operator-Setup-.+\.exe)$/m) || [])[1]?.trim();
if (!version || !setupName) {
  console.error("Could not parse version/path from latest.yml");
  process.exit(1);
}

// Large files first, latest.yml last — see the ordering note at the top of this file.
const installerPath = resolve(releaseDir, setupName);
const blockmapPath = resolve(releaseDir, `${setupName}.blockmap`);
const files = [installerPath, blockmapPath, latestPath];
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`Missing release artifact: ${file}`);
    process.exit(1);
  }
}

const supabase = createClient(url, privilegedKey, { auth: { persistSession: false, autoRefreshToken: false } });

// Preflight: validate against the bucket's own configured limit before touching
// anything. Note this can only check the BUCKET-level file_size_limit — Supabase
// also enforces a separate, project-wide global Storage upload limit that isn't
// readable via this client SDK, so a file can still be rejected even if it
// passes this check. If that happens, raise it in the Supabase Dashboard under
// Project Settings → Storage → "Global file size limit".
try {
  const { data: bucketInfo, error: bucketError } = await supabase.storage.getBucket(bucket);
  if (bucketError) throw bucketError;
  const bucketLimit = bucketInfo?.file_size_limit;
  if (bucketLimit) {
    for (const file of files) {
      const size = statSync(file).size;
      if (size > bucketLimit) {
        console.error(
          `${basename(file)} is ${size} bytes, which exceeds the "${bucket}" bucket's configured limit of ${bucketLimit} bytes.`
        );
        console.error(`Raise the bucket's file size limit in the Supabase Dashboard (Storage → ${bucket} → Settings) before retrying.`);
        process.exit(1);
      }
    }
  }
} catch (err) {
  console.warn(`Could not verify the bucket's file size limit ahead of time (${err.message || err}) — continuing, upload will fail loudly if a file is too large.`);
}

async function upload(filePath) {
  const name = basename(filePath);
  const objectPath = `${prefix}/${name}`;
  const body = readFileSync(filePath);
  const { error } = await supabase.storage.from(bucket).upload(objectPath, body, {
    upsert: true,
    contentType: name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream",
  });
  if (error) {
    console.error(`Upload FAILED for ${objectPath}: ${error.message || error}`);
    if (files.indexOf(filePath) < files.length - 1) {
      console.error("latest.yml was not touched, so the previously published release (if any) is still consistent.");
    }
    process.exit(1);
  }
  console.log(`uploaded ${objectPath} (${body.length} bytes)`);
}

const publicBase = `${url.replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/${prefix}`;
console.log(`Publishing Operator ${version}`);
console.log(`Feed: ${publicBase}`);

for (const file of files) {
  await upload(file);
}

console.log("Verifying public availability of all published artifacts…");
for (const file of files) {
  const name = basename(file);
  const expectedSize = statSync(file).size;
  const res = await fetch(`${publicBase}/${name}`, { method: "HEAD" });
  if (!res.ok) {
    console.error(`Public ${name} is not readable (${res.status}). Check that bucket ${bucket} is public.`);
    process.exit(1);
  }
  const remoteSize = Number(res.headers.get("content-length") || 0);
  if (remoteSize !== expectedSize) {
    console.error(`Public ${name} size mismatch: expected ${expectedSize} bytes, server reports ${remoteSize} bytes.`);
    process.exit(1);
  }
  console.log(`  ${name}: reachable, ${remoteSize} bytes (matches local file)`);
}
console.log("All release artifacts are published and verified.");
console.log("Installed Operator apps will see this version on the next update check.");
