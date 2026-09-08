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
