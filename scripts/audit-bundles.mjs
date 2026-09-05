import fs from "node:fs";
import path from "node:path";

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

audit("operator-web", "E:\\.1\\apps\\operator\\dist\\assets\\index-B47x5xBo.js");
audit("umpire-web", "E:\\.1\\apps\\umpire\\dist\\assets\\index-C8TpiYa4.js");
audit("android-assets", "E:\\.1\\apps\\umpire\\android\\app\\src\\main\\assets\\public\\assets\\index-C8TpiYa4.js");
