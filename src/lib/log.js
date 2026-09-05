// LOGGING SYSTEM — combined activity audit trail + developer/error log.
// Single source of truth for every logged event. Pure JS, framework-agnostic,
// pub/sub so React can subscribe. Every method is wrapped so logging can NEVER
// throw and break the app.
import { useSyncExternalStore } from "react";
import { LS } from "./storage.js";

export const Log = (() => {
  const KEY   = "pl6_logs";
  const MAX   = 600;                 // ring buffer cap (oldest trimmed)
  const LEVELS   = ["debug", "info", "success", "warn", "error"];
  const CATEGORIES = ["auth", "match", "player", "admin", "club", "friend", "system", "error"];

  let entries = [];
  const listeners = new Set();
  let installed = false;             // guard so global handlers install once
  let saveTimer = null;

  // --- load any persisted logs on boot ---
  try {
    const saved = LS.get(KEY, []);
    if (Array.isArray(saved)) entries = saved.slice(-MAX);
  } catch { entries = []; }

  const persist = () => {
    // debounce writes so a burst of points doesn't hammer localStorage
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { LS.set(KEY, entries); } catch{ /* best-effort, safe to ignore */ }
    }, 400);
  };

  const emit = () => { listeners.forEach(fn => { try { fn(); } catch{ /* best-effort, safe to ignore */ } }); };

  // Core writer. Returns the created entry (or null on total failure).
  const record = (level, category, action, meta) => {
    try {
      const entry = {
        id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        ts: Date.now(),
        level: LEVELS.includes(level) ? level : "info",
        category: CATEGORIES.includes(category) ? category : "system",
        action: String(action ?? ""),
        actor: (meta && meta.actor) || "system",
        meta: sanitizeMeta(meta),
      };
      entries.push(entry);
      if (entries.length > MAX) entries = entries.slice(-MAX);
      persist();
      emit();
      return entry;
    } catch { return null; }
  };

  // Strip functions/DOM nodes and pull `actor` out; keep it JSON-safe & small.
  const sanitizeMeta = (meta) => {
    if (!meta || typeof meta !== "object") return meta ?? null;
    const out = {};
    for (const k of Object.keys(meta)) {
      if (k === "actor") continue;
      const v = meta[k];
      const t = typeof v;
      if (v == null || t === "string" || t === "number" || t === "boolean") out[k] = v;
      else if (t === "object") { try { out[k] = JSON.parse(JSON.stringify(v)); } catch { out[k] = String(v); } }
      // functions / symbols are dropped
    }
    return Object.keys(out).length ? out : null;
  };

  // Convenience level methods: Log.info(category, action, meta) etc.
  const make = (level) => (category, action, meta) => record(level, category, action, meta);

  // Capture uncaught errors, promise rejections and console.error/warn once.
  const installGlobalHandlers = () => {
    if (installed || typeof window === "undefined") return () => {};
    installed = true;

    const onError = (ev) => {
      const msg = ev?.message || (ev?.error && ev.error.message) || "Unknown error";
      record("error", "error", "Uncaught error: " + msg, {
        source: ev?.filename, line: ev?.lineno, col: ev?.colno,
        stack: ev?.error?.stack ? String(ev.error.stack).slice(0, 800) : undefined,
      });
    };
    const onRejection = (ev) => {
      const r = ev?.reason;
      const msg = r && r.message ? r.message : String(r);
      record("error", "error", "Unhandled promise rejection: " + msg, {
        stack: r && r.stack ? String(r.stack).slice(0, 800) : undefined,
      });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    // Wrap console.error / console.warn (keep originals intact).
    const origErr = console.error;
    const origWarn = console.warn;
    const fmt = (args) => args.map(a => {
      if (a instanceof Error) return a.message;
      if (typeof a === "object") { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(" ").slice(0, 500);
    console.error = (...a) => { try { record("error", "error", "console.error: " + fmt(a)); } catch{ /* best-effort, safe to ignore */ } origErr.apply(console, a); };
    console.warn  = (...a) => { try { record("warn",  "system", "console.warn: " + fmt(a)); } catch{ /* best-effort, safe to ignore */ } origWarn.apply(console, a); };

    // cleanup for React StrictMode / unmount
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      console.error = origErr;
      console.warn = origWarn;
      installed = false;
    };
  };

  const exportAs = (format) => {
    try {
      if (format === "csv") {
        const head = ["timestamp", "level", "category", "actor", "action", "meta"];
        const rows = [...entries].reverse().map(e => [
          new Date(e.ts).toISOString(), e.level, e.category, e.actor,
          e.action, e.meta ? JSON.stringify(e.meta) : "",
        ].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","));
        return head.join(",") + "\n" + rows.join("\n");
      }
      return JSON.stringify([...entries].reverse(), null, 2);
    } catch { return ""; }
  };

  return {
    LEVELS, CATEGORIES,
    record,
    debug:   make("debug"),
    info:    make("info"),
    success: make("success"),
    warn:    make("warn"),
    error:   make("error"),
    event:   (category, action, meta) => record("info", category, action, meta), // audit-trail helper
    getAll:  () => entries,           // stable reference between updates (for useSyncExternalStore)
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    clear:   () => { entries = []; try { LS.set(KEY, entries); } catch{ /* best-effort, safe to ignore */ } emit(); },
    export:  exportAs,
    installGlobalHandlers,
  };
})();

// React hook: subscribe a component to the live log store.
export function useLogs() {
  return useSyncExternalStore(Log.subscribe, Log.getAll, Log.getAll);
}

// Small presentation config for log levels/categories.
export const LOG_LEVEL_META = {
  debug:   { color: "#94A3B8", bg: "#F1F5F9", dot: "#94A3B8", label: "DEBUG" },
  info:    { color: "#3B82F6", bg: "#EFF6FF", dot: "#3B82F6", label: "INFO" },
  success: { color: "#22C55E", bg: "#F0FDF4", dot: "#22C55E", label: "OK" },
  warn:    { color: "#F59E0B", bg: "#FFFBEB", dot: "#F59E0B", label: "WARN" },
  error:   { color: "#EF4444", bg: "#FEF2F2", dot: "#EF4444", label: "ERROR" },
};
export const LOG_CAT_ICON = { auth:"🔑", match:"🏓", player:"👤", admin:"⭐", club:"🏟", friend:"🤝", system:"⚙️", error:"⛔" };
export const fmtLogTime = (ts) => {
  try {
    const d = new Date(ts), now = Date.now(), diff = (now - ts) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return d.toLocaleDateString("en-PH", { month: "short", day: "numeric" }) + " " +
           d.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
};
