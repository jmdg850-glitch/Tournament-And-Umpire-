// Re-implements, in TypeScript, the exact predicate PickleLive's own SQL
// already encodes for match ownership (matches_insert RLS intent + the
// is_co_organizer_of() helper in 102_policies_matches_live.sql). This can't
// just call those SQL helpers from here — they read auth.uid(), which is
// NULL under the service-role connection this function uses for every other
// query — so the same three-way check (owner / co-organizer / admin) is
// ported explicitly against the already-fetched match row.
import { supabaseAdmin } from "./supabaseAdmin.ts";
import type { PickleLiveMatch } from "./types.ts";

export async function authorizeMatch(userId: string, match: PickleLiveMatch): Promise<boolean> {
  if (match.organizerId === userId) return true;
  if ((match.organizerIds || []).includes(userId)) return true;

  const admin = supabaseAdmin();

  const { data: adminRow } = await admin
    .from("admins")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (adminRow) return true;

  // Mirrors is_co_organizer_of(owner_id): an accepted organizer invite on an
  // event owned by the match's organizer grants the same write access as the
  // owner.
  const { data: eventRow } = await admin
    .from("events")
    .select("organizer_ids")
    .eq("owner_id", match.organizerId)
    .contains("organizer_ids", [userId])
    .limit(1)
    .maybeSingle();

  return !!eventRow;
}
