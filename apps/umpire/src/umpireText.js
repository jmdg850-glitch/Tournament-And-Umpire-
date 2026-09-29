// Umpire-facing wording for failures and sync state. Pure functions — no
// React, no I/O — so they are unit-tested (umpireText.test.js).
//
// The umpire is courtside and under time pressure: every message says what
// happened and what to do next, never a raw backend string or HTTP code. The
// raw error is still logged (console.warn) for anyone debugging.

const NETWORK = "No connection. Check Wi-Fi or mobile data and try again.";
const SERVER = "The server isn't responding. Try again in a moment.";

const BY_ACTION = {
  signin: {
    auth: "Email or password is incorrect.",
    fallback: "Couldn't sign in. Check your email and password and try again.",
  },
  reset: {
    fallback: "Couldn't send the reset email. Try again in a moment.",
  },
  pair: {
    auth: "That pairing code isn't valid or has expired. Scan the QR again or ask the organizer for a new code.",
    fallback: "That pairing code isn't valid or has expired. Scan the QR again or ask the organizer for a new code.",
  },
  load: {
    fallback: "Couldn't load this right now. Try again in a moment.",
  },
  action: {
    fallback: "That didn't go through. Reload the match and try again.",
  },
};

// Command API codes an umpire can realistically hit (packages/api handlers).
const BY_CODE = {
  MATCH_NOT_READY: "This match isn't ready to start yet — the organizer still needs to finish setting it up.",
  MATCH_ALREADY_STARTED: "This match has already started. Tap Reload to see the latest score.",
  MATCH_NOT_ACTIVE: "This match isn't live any more. Tap Reload to see its current status.",
  ILLEGAL_TRANSITION: "This match can't do that from its current status. Tap Reload to see the latest.",
  MATCH_NOT_WON: "No one has won yet, so the match can't be completed.",
  MATCH_NOT_EDITABLE: "This match can't be edited any more.",
  WOULD_CHANGE_WINNER: "That score would change the winner of a completed match. Ask the organizer to fix it.",
  INVALID_SCORE: "That score isn't valid for this match.",
  INVALID_GAME_TIME: "Enter a game time within the allowed range.",
  TIMER_UNAVAILABLE: "Game time isn't available for this tournament yet.",
  COURT_MISMATCH: "This match isn't on this court any more. Go back and refresh the court list.",
  CORRECTION_UNSUPPORTED: "Score corrections can't be made from a court device.",
  RETRY_LATER: "The server is busy. Try again in a moment.",
};

function httpStatus(err) {
  const n = Number(err?.status);
  return Number.isFinite(n) ? n : null;
}

// `action`: "signin" | "reset" | "pair" | "load" | "action".
export function friendlyError(err, action = "action") {
  const copy = BY_ACTION[action] || BY_ACTION.action;
  const status = httpStatus(err);
  const code = String(err?.code || "");
  const message = String(err?.message || err || "");
  let text;
  // Messages this app wrote itself (sign-in needed while scores are saved on
  // the device) are already specific — keep them.
  if (code === "NEEDS_AUTH" && message) return message;
  if (BY_CODE[code] && action !== "pair" && action !== "signin") {
    text = BY_CODE[code];
  } else if (status == null || status === 0) {
    // No HTTP answer at all (fetch failed, timed out, DNS): offline or the
    // server is unreachable. supabase-js reports this as status 0.
    text = /invalid login credentials/i.test(message) ? BY_ACTION.signin.auth : NETWORK;
  } else if (action === "signin" && (status === 400 || /invalid_credentials/.test(code) || /invalid login credentials/i.test(message))) {
    text = BY_ACTION.signin.auth;
  } else if (action === "pair" && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    text = copy.auth;
  } else if (status === 401) {
    text = "Your sign-in has expired. Sign in again to continue.";
  } else if (status === 403) {
    text = "You're not assigned to this match any more. Go back and check with the organizer.";
  } else if (status === 409 && (code === "STALE_STATE" || code === "OUT_OF_ORDER")) {
    text = "This match changed on another device. Tap Reload to see the latest score.";
  } else if (status >= 500 || status === 408 || status === 429) {
    text = SERVER;
  } else {
    text = copy.fallback;
  }
  if (typeof console !== "undefined" && err) console.warn(`[umpire:${action}]`, message, status ?? "", code);
  return text;
}

// The single status shown in the match header. Priority: problems the umpire
// must act on first, then transient work, then the calm steady state.
//   tone: "ok" | "busy" | "warn" | "error"
export function syncChipState({ inConflict, needsAuth, offline, pending = 0, saving, justSynced, durable = true }) {
  if (inConflict) return { tone: "error", label: "Sync problem" };
  if (durable === false) return { tone: "error", label: "Not saving offline" };
  if (needsAuth && pending > 0) return { tone: "warn", label: `Sign in needed · ${pending} saved` };
  if (offline) return pending > 0
    ? { tone: "warn", label: `Offline · ${pending} saved` }
    : { tone: "warn", label: "Offline" };
  if (saving) return { tone: "busy", label: "Saving…" };
  if (pending > 0) return { tone: "busy", label: `Syncing ${pending}` };
  if (justSynced) return { tone: "ok", label: "Synced" };
  return { tone: "ok", label: "Online" };
}
