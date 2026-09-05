import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const project = process.argv[2];
if (!project) {
  console.error("usage: node scripts/vercel-sync-client-env.mjs <project-name> [env-file]");
  process.exit(1);
}

function parseEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) continue;
      const i = line.indexOf("=");
      if (i < 1) continue;
      out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  } catch {
    /* missing file */
  }
  return out;
}

const fileEnv = parseEnv(process.argv[3] || `apps/${project.includes("umpire") ? "umpire" : "operator"}/.env.local`);
const vars = {
  VITE_SUPABASE_URL: fileEnv.VITE_SUPABASE_URL || "https://evuvgxruavnadpbiehgb.supabase.co",
  VITE_SUPABASE_PUBLISHABLE_KEY: fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY || fileEnv.VITE_SUPABASE_ANON_KEY || "",
  VITE_SUPABASE_ANON_KEY: fileEnv.VITE_SUPABASE_ANON_KEY || fileEnv.VITE_SUPABASE_PUBLISHABLE_KEY || "",
  VITE_COMMAND_URL: fileEnv.VITE_COMMAND_URL || "https://evuvgxruavnadpbiehgb.supabase.co/functions/v1/command",
};

for (const [name, value] of Object.entries(vars)) {
  if (!value) {
    console.error(`missing ${name}`);
    process.exit(1);
  }
  if (/SERVICE_ROLE|sb_secret_/i.test(name) || /SERVICE_ROLE|sb_secret_/.test(value)) {
    console.error("refusing to set a server secret as a VITE_/client env var");
    process.exit(1);
  }
  console.log(`sync ${name} -> ${project}`);
  const r = spawnSync(
    "npx",
    [
      "vercel",
      "env",
      "add",
      name,
      "production,preview,development",
      "--value",
      value,
      "--yes",
      "--force",
      "--no-sensitive",
      "--project",
      project,
      "--scope",
      "tournament-nextg",
    ],
    { encoding: "utf8", shell: true },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.status !== 0) {
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(r.status || 1);
  }
}
