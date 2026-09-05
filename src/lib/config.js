// Supabase project configuration + auth redirect URLs.
// Reads VITE_* env vars only — no hardcoded fallback. Vercel's Production
// environment has VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY set (confirmed
// working post-deploy); local dev reads the same two vars from .env.local.
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
export const SUPABASE_URL      = env.VITE_SUPABASE_URL      || "";
export const SUPABASE_ANON_KEY = env.VITE_SUPABASE_ANON_KEY || "";

// Production origin used for ALL auth email redirects (confirmation + password recovery).
// Recovery/confirmation links must always open the deployed app (not a dev origin), so every
// device/browser/network lands on the real site. Change this if you deploy elsewhere.
export const SITE_URL = env.VITE_SITE_URL || "https://picklelive.vercel.app";
// Where the recovery email link points. Query flag (?reset=1) is detected on load to show the
// Reset Password screen; using a query param (not a path) keeps it working on static hosting
// without extra rewrite rules.
export const RESET_REDIRECT   = SITE_URL + "/reset-password";
export const CONFIRM_REDIRECT = SITE_URL + "/";
// Clean URL to use after a recovery flow completes (strips ?code / #tokens / /reset-password).
export function SITE_URL_PATH(){ try{ return (typeof window!=="undefined"&&window.location)? (window.location.origin + "/") : "/"; }catch{ return "/"; } }
// Shared recovery-link classifier, used both for window.location (web) and a Capacitor-delivered
// deep link (native), so both platforms recognize the same reset-password link the same way.
export function isRecoveryLink(urlStr){ const s=urlStr||""; return /[?&#](reset=1|type=recovery)/.test(s) || /\/reset-password/.test(s); }

export const cloudEnabled =
  /^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) &&
  !SUPABASE_URL.includes("YOUR_PROJECT") &&
  !!SUPABASE_ANON_KEY && !SUPABASE_ANON_KEY.includes("YOUR_");
