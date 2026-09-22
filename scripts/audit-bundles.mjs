import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib/repoGuard.mjs";

function findEntryBundle(distAssetsDir) {
  if (!fs.existsSync(distAssetsDir)) {
    throw new Error(`${distAssetsDir} does not exist — run the relevant build first (see docs/BUILD_WORKFLOW.md).`);
  }
  const match = fs.readdirSync(distAssetsDir).find((f) => /^index-.*\.js$/.test(f));
  if (!match) throw new Error(`No index-*.js bundle found in ${distAssetsDir}.`);
  return path.join(distAssetsDir, match);
}

function audit(label, file) {
  const s = fs.readFileSync(file, "utf8");
  const pub = s.match(/sb_publishable_[A-Za-z0-9_-]+/);
  const sign = s.match(/signOut\([^)]{0,80}\)/g);
  console.log(JSON.stringify({
    label,
    file: path.basename(file),
    url: s.includes("evuvgxruavnadpbiehgb.supabase.co"),
    command: s.includes("/functions/v1/command"),
    publishable: Boolean(pub),
    real_sb_secret: /sb_secret_[A-Za-z0-9_-]{16,}/.test(s),
    service_role_key: s.includes("SUPABASE_SERVICE_ROLE_KEY"),
    picklelive: /picklelive|qfyfomiqxouqftrgganh/i.test(s),
    nextg: /nextg/i.test(s),
    devpass: s.includes("dev-organizer-pass"),
    signOut: sign,
  }, null, 2));
}

const root = repoRoot();
audit("operator-web", findEntryBundle(path.resolve(root, "apps/operator/dist/assets")));
audit("umpire-web", findEntryBundle(path.resolve(root, "apps/umpire/dist/assets")));
audit("android-assets", findEntryBundle(path.resolve(root, "apps/umpire/android/app/src/main/assets/public/assets")));
