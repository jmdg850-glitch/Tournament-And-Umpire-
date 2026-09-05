import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const releaseDir = resolve(root, "apps/operator/release");
const bucket = "desktop-updates";
const prefix = "operator/win";

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

loadEnvFile(resolve(root, ".env"));
loadEnvFile(resolve(root, ".env.local"));
loadEnvFile(resolve(root, "apps/operator/.env.local"));

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !service) {
  console.error("Missing SUPABASE_URL / VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
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

const files = [
  latestPath,
  resolve(releaseDir, setupName),
  resolve(releaseDir, `${setupName}.blockmap`),
];
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`Missing release artifact: ${file}`);
    process.exit(1);
  }
}

const supabase = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });

async function upload(filePath) {
  const name = basename(filePath);
  const objectPath = `${prefix}/${name}`;
  const body = readFileSync(filePath);
  const { error } = await supabase.storage.from(bucket).upload(objectPath, body, {
    upsert: true,
    contentType: name.endsWith(".yml") ? "text/yaml; charset=utf-8" : "application/octet-stream",
  });
  if (error) throw error;
  console.log(`uploaded ${objectPath} (${body.length} bytes)`);
}

const publicBase = `${url.replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/${prefix}`;
console.log(`Publishing Operator ${version}`);
console.log(`Feed: ${publicBase}`);

for (const file of files) {
  await upload(file);
}

const check = await fetch(`${publicBase}/latest.yml`);
if (!check.ok) {
  console.error(`Public latest.yml is not readable (${check.status}). Check that bucket desktop-updates is public.`);
  process.exit(1);
}
console.log("Public latest.yml is reachable.");
console.log("Installed Operator apps will see this version on the next update check.");
