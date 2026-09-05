// Small shared helpers.
import { Log } from "./log.js";
import { version as PKG_VERSION } from "../../package.json";

export const uid     = ()=>`${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
export const today   = ()=>new Date().toISOString().split("T")[0];
export const fmtDate = d=>{try{return new Date(d+"T00:00:00").toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric"});}catch{return d;}};
export const ini     = n=>!n?.trim()?"?":n.trim().split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase();
export const nameOf  = (pl,id)=>pl.find(p=>p.id===id)?.name||"—";
export const teamLabel=(pl,ids)=>ids?.map(id=>nameOf(pl,id)).join(" & ")||"—";
export const clamp   = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));

// window.electronAPI only exists inside Electron's preload bridge (see
// electron/preload.cjs) — absent on web and Capacitor/Android. Hoisted here
// (was previously re-declared per-file, e.g. App.jsx/ImportModal.jsx/
// UpdateBanner.jsx) so any module can gate Electron-only UI without its own
// copy of the same one-liner.
export const hasElectron = typeof window !== "undefined" && !!window.electronAPI;

// Password strength rule, shared by signup/reset/change-password everywhere so there's one
// place to tighten it (was a bare length>=6 check duplicated across 7 call sites). Supabase's
// own leaked-password check (HaveIBeenPwned) is Pro-plan only, so this is the free-tier-
// compatible substitute: longer minimum + basic complexity instead of breach-list matching.
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_HINT = `Min. ${PASSWORD_MIN_LENGTH} characters, with at least one uppercase letter, one lowercase letter, and one number.`;
export const isStrongPassword = (pw) =>
  !!pw && pw.length >= PASSWORD_MIN_LENGTH && /[a-z]/.test(pw) && /[A-Z]/.test(pw) && /[0-9]/.test(pw);

// Resolves after `ms` regardless of what `promise` does, so a caller (e.g. pull-to-refresh) can
// never hang forever on a request that never settles — there's no AbortController/timeout
// anywhere in this app's Supabase client, so a single stuck network call would otherwise block
// the caller indefinitely. Logs via Log.warn only when the timeout actually wins the race (never
// throws either way, matching every other "never throw, always resolve/log" helper).
export const withTimeout = (promise, ms, label) => new Promise(resolve => {
  let done = false;
  const t = setTimeout(() => { if (!done) { done = true; Log.warn("system", "Operation timed out", { label, ms }); resolve(); } }, ms);
  Promise.resolve(promise).catch(() => {}).finally(() => { if (!done) { done = true; clearTimeout(t); resolve(); } });
});

// App version — single-sourced from package.json (also what electron-builder
// names the installer/portable exe after, and what Electron's app.getVersion()
// returns) so the in-app About/Settings display can never drift out of sync
// with what actually got shipped. Bump package.json's version at release time.
export const APP_VERSION = PKG_VERSION;
export const APP_BUILD   = "August 2026";


// ================================================================
// LOG VIEWER — shared UI for the combined activity + error log
// ================================================================
// Electron: real Save dialog so the user picks where the file goes, instead
// of silently landing in the Downloads folder like the <a download> fallback
// below does. Same hasElectron gating pattern as ImportModal/UpdateBanner.
// Returns null (not false) when the user cancels the dialog - that's not a
// failure, so callers shouldn't show an error toast for it.
async function downloadTextElectron(filename, text, isBase64){
  const ext = filename.slice(filename.lastIndexOf(".")+1);
  const result = await window.electronAPI.saveFileDialog({
    defaultPath: filename,
    filters: [{name: ext.toUpperCase(), extensions: [ext]}],
  });
  if(result.canceled || !result.filePath) return null;
  await window.electronAPI.writeFile(result.filePath, text, isBase64?"base64":undefined);
  return true;
}

// isBase64 (additive, default false): pass true when `text` is actually base64-encoded
// binary content (e.g. a generated .xlsx) rather than plain text — every existing caller
// omits it and is completely unaffected. Needed because neither the Electron IPC channel
// nor a <a download> Blob can be handed a raw JS binary string safely; base64 round-trips
// correctly through both.
export async function downloadText(filename, text, mime, isBase64){
  if(typeof window!=="undefined" && window.electronAPI){
    try{ return await downloadTextElectron(filename, text, isBase64); }
    catch{ return false; }
  }
  try{
    const blob = isBase64
      ? new Blob([Uint8Array.from(atob(text), c=>c.charCodeAt(0))], {type: mime || "application/octet-stream"})
      : new Blob([text], {type: mime || "text/plain"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(()=>{ try{URL.revokeObjectURL(url);}catch{ /* best-effort, safe to ignore */ } }, 1500);
    return true;
  }catch{
    if(isBase64) return false; // a data: URI fallback isn't meaningful for binary content
    try{ window.open("data:"+(mime||"text/plain")+";charset=utf-8,"+encodeURIComponent(text)); return true; }
    catch{ return false; }
  }
}
