import { isUuid } from "@tournament/engine";
import { firstQueryError } from "../lib.js";

// Deliberately NOT a reuse of lib.js's loadDeskData: that loader also fetches
// tournament_members, court_devices, and every profile in the project —
// none of which anon is (or should be) granted access to (see
// supabase/migrations/0012_public_live_tournaments.sql and
// 0013_public_tournaments_view_fix.sql). This is a smaller, public-safe
// sibling: only the tables/columns those migrations actually grant to anon,
// scoped to one is_public tournament. The resulting `data` shape is still
// compatible with lib.js's pure helpers (sideOf, courtFor, scoreLine,
// stageTitle, membersOfParticipant, personLabel, isTeamMatchup,
// playableMatches, teamEliminationStandings) and brackets.jsx's
// DivisionBracketCard, none of which read the tables this loader omits.
export function slugLookupColumn(slugOrId) {
  return isUuid(slugOrId) ? "id" : "slug";
}

export async function loadPublicTournamentData(supabase, slugOrId) {
  const column = slugLookupColumn(slugOrId);
  // anon only has a column-restricted grant on tournaments (id, name, sport,
  // status, slug, created_at) plus an is_public=true RLS policy — not a
  // wildcard select("*"), so a non-public/nonexistent id or slug comes back
  // as either zero rows (RLS) or a real "unknown column" error if this ever
  // asks for more than those columns.
  const { data: t, error: tErr } = await supabase
    .from("tournaments")
    .select("id, name, sport, status, slug, created_at")
    .eq(column, slugOrId)
    .maybeSingle();
  if (tErr) return { data: null, error: tErr };
  if (!t) return { data: null, error: null };

  const primary = await Promise.all([
    supabase.from("divisions").select("*").eq("tournament_id", t.id),
    supabase.from("persons").select("id, tournament_id, display_name").eq("tournament_id", t.id).order("display_name"),
    supabase.from("teams").select("*").eq("tournament_id", t.id).order("name"),
    supabase.from("participants").select("*").eq("tournament_id", t.id),
    supabase.from("courts").select("*").eq("tournament_id", t.id).order("sort_order"),
    supabase.from("matches").select("*").eq("tournament_id", t.id).order("round"),
  ]);
  const primaryErr = firstQueryError(primary);
  if (primaryErr) return { data: null, error: primaryErr };
  const [divisions, persons, teams, participants, courts, matches] = primary;
  const matchIds = (matches.data || []).map((m) => m.id);
  const participantIds = (participants.data || []).map((p) => p.id);
  const divisionIds = (divisions.data || []).map((d) => d.id);

  const empty = Promise.resolve({ data: [] });
  const dependent = await Promise.all([
    matchIds.length ? supabase.from("match_results").select("*").in("match_id", matchIds) : empty,
    matchIds.length ? supabase.from("court_assignments").select("*").in("match_id", matchIds) : empty,
    matchIds.length ? supabase.from("match_participants").select("*").in("match_id", matchIds) : empty,
    participantIds.length ? supabase.from("participant_members").select("*").in("participant_id", participantIds) : empty,
    divisionIds.length ? supabase.from("stages").select("*").in("division_id", divisionIds) : empty,
  ]);
  const dependentErr = firstQueryError(dependent);
  if (dependentErr) return { data: null, error: dependentErr };
  const [results, courtAssignments, matchParticipants, participantMembers, stages] = dependent;

  return {
    error: null,
    data: {
      tournament: t,
      divisions: divisions.data || [],
      persons: persons.data || [],
      teams: teams.data || [],
      participants: participants.data || [],
      participantMembers: participantMembers.data || [],
      stages: stages.data || [],
      courts: courts.data || [],
      matches: matches.data || [],
      results: results.data || [],
      courtAssignments: courtAssignments.data || [],
      matchParticipants: matchParticipants.data || [],
      // No members/courtDevices/umpireAssignments/profiles — umpireFor/memberName
      // are simply never called by the public UI, so their absence never crashes it.
    },
  };
}
