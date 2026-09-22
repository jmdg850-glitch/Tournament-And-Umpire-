export const STATION_COMMANDS = new Set([
  "station_sync",
  "start_match",
  "coin_toss",
  "score_event",
  "complete_match",
]);

export const STATION_SCORE_EVENT_TYPES = new Set(["point", "undo"]);

export const STATION_FORBIDDEN_COMMANDS = Object.freeze([
  "transition_match",
  "assign_court",
  "assign_umpire",
  "revoke_court_device",
  "open_court_pairing",
  "generate_bracket",
  "generate_team_elimination",
  "generate_team_playoffs",
  "create_tournament",
  "update_tournament",
  "transition_tournament",
  "remove_participant",
  "delete_division",
  "create_court",
  "add_member",
  "add_person",
  "create_team",
]);

function forbid(message) {
  const err = new Error(message);
  err.status = 403;
  err.code = "FORBIDDEN";
  throw err;
}

export function assertStationMayIssue(actor, type, payload) {
  if (actor?.kind !== "station") return;
  if (!STATION_COMMANDS.has(type)) {
    forbid("Court stations cannot issue this command");
  }
  if (type === "score_event") {
    const eventType = payload?.type;
    if (eventType && !STATION_SCORE_EVENT_TYPES.has(eventType)) {
      forbid("Court stations cannot issue this scoring action");
    }
  }
}

// "correction" (manual score edit) is deliberately excluded from
// STATION_SCORE_EVENT_TYPES — a paired court-tablet device is not an
// authenticated user and must not be able to issue a score correction, only
// authenticated organizer/umpire actors can (see handleScoreEvent).
const USER_ONLY_SCORE_EVENT_TYPES = new Set(["correction"]);

export function assertAllowedScoreEventType(type, actor) {
  if (actor?.kind !== "station" && USER_ONLY_SCORE_EVENT_TYPES.has(type)) return;
  if (!STATION_SCORE_EVENT_TYPES.has(type)) {
    forbid("This scoring action is not allowed");
  }
}

export function requireOrganizer(member) {
  if (!member || !["organizer", "admin"].includes(member.role)) {
    const err = new Error("Organizer role required");
    err.status = 403;
    err.code = "FORBIDDEN";
    throw err;
  }
}

export function canScoreMatch(member, umpireUserId, actorId) {
  if (member && ["organizer", "admin"].includes(member.role)) return true;
  if (member && member.role === "umpire" && umpireUserId === actorId) return true;
  return false;
}

export function requireScoreAccess(member, umpireUserId, actorId) {
  if (!canScoreMatch(member, umpireUserId, actorId)) {
    const err = new Error("Not authorized to operate this match");
    err.status = 403;
    err.code = "FORBIDDEN";
    throw err;
  }
}

export function canScoreAsStation(device, courtAssignment, match) {
  if (!device || device.status !== "active") return false;
  if (!courtAssignment || courtAssignment.court_id !== device.court_id) return false;
  if (!match || match.tournament_id !== device.tournament_id) return false;
  return true;
}

export function requireStationScoreAccess(device, courtAssignment, match) {
  if (!canScoreAsStation(device, courtAssignment, match)) {
    const err = new Error("This device is not authorized for that match");
    err.status = 403;
    err.code = "COURT_MISMATCH";
    throw err;
  }
}

export async function loadMember(admin, tournamentId, userId) {
  const { data, error } = await admin
    .from("tournament_members")
    .select("*")
    .eq("tournament_id", tournamentId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function requireProfile(admin, userId) {
  const { data, error } = await admin.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error("Profile not found");
    err.status = 401;
    err.code = "NO_PROFILE";
    throw err;
  }
  return data;
}

// Server-side Operator license entitlement (see docs/LICENSING.md). The
// Operator app's LicenseGate is a client-side UI gate only — a modified
// client, or any caller holding a stolen-but-valid Supabase JWT, could
// otherwise call /command directly and bypass it entirely. This is the
// authoritative check: it must fail closed and must never leak license
// details (email/code/other rows) in its errors.
//
// Selection of the "current" license row mirrors
// supabase/functions/license/license.js's own check() action exactly, so
// both independently-deployed functions agree on what a customer's active
// license is: the first non-revoked row, else the latest revoked one.
const LICENSE_CACHE_TTL_MS = 60_000;
// Warm-instance-local cache of *positive* results only, keyed by lowercased
// email. Denials are never cached, so a revoke takes effect on an account's
// very next command — tighter than LicenseGate's existing 6-hour poll.
const licenseAllowCache = new Map();

function licenseDecision(rows, nowMs) {
  const current = (rows || []).find((l) => l.status !== "revoked") ?? (rows || [])[0] ?? null;
  if (!current || current.status === "unused") return { ok: false, code: "LICENSE_REQUIRED" };
  if (current.status === "revoked") return { ok: false, code: "LICENSE_INVALID" };
  if (current.expires_at && Date.parse(current.expires_at) <= nowMs) {
    return { ok: false, code: "LICENSE_INVALID" };
  }
  return { ok: true };
}

export async function requireLicense(admin, actor) {
  // Court stations are anonymous devices with no email/customer identity —
  // never license-gated (docs/LICENSING.md).
  if (actor?.kind === "station") return;
  const email = String(actor?.email || "").trim().toLowerCase();
  if (!email) {
    // Defensive only: every "user" actor is resolved from a verified
    // Supabase JWT (stationAuth.resolveActor), which always sets email.
    // Fail closed rather than let an unidentifiable actor through.
    const err = new Error("An active Operator license is required for this action");
    err.status = 403;
    err.code = "LICENSE_REQUIRED";
    throw err;
  }
  const now = Date.now();
  const cachedUntil = licenseAllowCache.get(email);
  if (cachedUntil && cachedUntil > now) return;

  const { data, error } = await admin
    .from("licenses")
    .select("status, expires_at")
    .eq("email", email)
    .order("created_at", { ascending: false });
  if (error) {
    const err = new Error("License lookup failed");
    err.status = 500;
    err.code = "INTERNAL";
    throw err;
  }

  const decision = licenseDecision(data, now);
  if (!decision.ok) {
    const err = new Error("An active Operator license is required for this action");
    err.status = 403;
    err.code = decision.code;
    throw err;
  }
  licenseAllowCache.set(email, now + LICENSE_CACHE_TTL_MS);
}

export async function requireOrganizerLicensed(admin, actor, member) {
  requireOrganizer(member);
  await requireLicense(admin, actor);
}
