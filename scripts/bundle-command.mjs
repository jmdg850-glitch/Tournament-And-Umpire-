import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function bundle(args) {
  const result = spawnSync("npx", ["--yes", "esbuild", ...args], {
    cwd: root,
    stdio: "inherit",
    shell: true,
  });
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

bundle([
  "packages/api/src/handleCommand.js",
  "--bundle",
  "--format=esm",
  "--platform=neutral",
  "--outfile=supabase/functions/command/handleCommand.js",
]);

bundle([
  "packages/api/src/stationAuth.js",
  "--bundle",
  "--format=esm",
  "--platform=neutral",
  "--outfile=supabase/functions/pair-station/stationAuth.js",
]);
