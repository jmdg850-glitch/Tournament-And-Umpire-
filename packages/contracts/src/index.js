export const COMMAND_TYPES = Object.freeze([
  "create_tournament",
  "update_tournament",
  "transition_tournament",
  "create_division",
  "update_division",
  "add_person",
  "create_team",
  "add_team_member",
  "remove_team_member",
  "register_participant",
  "remove_participant",
  "create_court",
  "add_member",
  "generate_bracket",
  "generate_team_elimination",
  "generate_team_playoffs",
  "assign_court",
  "assign_umpire",
  "open_court_pairing",
  "revoke_court_device",
  "station_sync",
  "transition_match",
  "start_match",
  "coin_toss",
  "score_event",
  "complete_match",
]);

export const TOURNAMENT_STATUSES = Object.freeze([
  "draft",
  "registration",
  "registration_closed",
  "ready",
  "in_progress",
  "completed",
  "cancelled",
  "archived",
]);

export const MATCH_STATUSES = Object.freeze([
  "scheduled",
  "ready",
  "assigned",
  "in_progress",
  "completed",
  "postponed",
  "cancelled",
  "abandoned",
  "bye",
]);

export const MEMBER_ROLES = Object.freeze(["organizer", "admin", "umpire", "viewer"]);

export const DIVISION_FORMATS = Object.freeze([
  "single_elim",
  "double_elim",
  "round_robin",
  "pool",
  "team_elimination",
]);

export const SCORE_EVENT_TYPES = Object.freeze(["point", "undo", "timeout", "coin_toss"]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

export function encodePairingPayload(payload) {
  return JSON.stringify({
    v: payload?.v ?? 1,
    sid: String(payload?.sid || payload?.station_public_id || ""),
    g: String(payload?.g || payload?.pairing_token || ""),
  });
}

export function parsePairingPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return { pairingToken: "", stationPublicId: "" };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return {
        pairingToken: String(parsed.g || parsed.pairing_token || ""),
        stationPublicId: String(parsed.sid || parsed.station_public_id || ""),
      };
    }
  } catch {
    /* paste may be the raw grant token */
  }
  return { pairingToken: text, stationPublicId: "" };
}

export function parseCommandEnvelope(body) {
  if (!body || typeof body !== "object") {
    const err = new Error("Command body must be an object");
    err.code = "INVALID_COMMAND";
    err.status = 400;
    throw err;
  }
  const { command_id, type, payload } = body;
  if (!isUuid(command_id)) {
    const err = new Error("command_id must be a UUID");
    err.code = "INVALID_COMMAND";
    err.status = 400;
    throw err;
  }
  if (!COMMAND_TYPES.includes(type)) {
    const err = new Error(`Unknown command type: ${type}`);
    err.code = "UNKNOWN_COMMAND";
    err.status = 400;
    throw err;
  }
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    const err = new Error("payload must be an object");
    err.code = "INVALID_COMMAND";
    err.status = 400;
    throw err;
  }
  return { command_id, type, payload };
}
