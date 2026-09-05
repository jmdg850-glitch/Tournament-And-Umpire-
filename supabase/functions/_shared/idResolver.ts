// Resolves each match participant (a mixmatch_players.id) to a DUPR id.
// Authoritative resolution point — the client-side "has DUPR" check in the
// UI is advisory only; this is what submit-match actually trusts.
import { supabaseAdmin } from "./supabaseAdmin.ts";

export interface ResolveResult {
  resolved: Map<string, string>; // mixmatch_players.id -> dupr id
  missing: { playerId: string; name: string }[];
}

export async function resolveDuprIds(playerIds: string[]): Promise<ResolveResult> {
  const admin = supabaseAdmin();
  const resolved = new Map<string, string>();
  const missing: { playerId: string; name: string }[] = [];

  const { data: rosterRows } = await admin
    .from("mixmatch_players")
    .select("id, name, dupr_id, linked_user_id")
    .in("id", playerIds);

  const rows = rosterRows || [];
  const needsAccountLookup = rows.filter((r) => !r.dupr_id && r.linked_user_id);

  let accountDuprIds = new Map<string, string>();
  if (needsAccountLookup.length > 0) {
    const accountIds = needsAccountLookup.map((r) => r.linked_user_id as string);
    const { data: accountRows } = await admin
      .from("accounts")
      .select("id, dupr_id, dupr_status")
      .in("id", accountIds);
    accountDuprIds = new Map(
      (accountRows || [])
        .filter((a) => a.dupr_status === "linked" && a.dupr_id)
        .map((a) => [a.id as string, a.dupr_id as string]),
    );
  }

  for (const playerId of playerIds) {
    const row = rows.find((r) => r.id === playerId);
    if (!row) {
      missing.push({ playerId, name: "Unknown player" });
      continue;
    }
    console.log(`[DUPR] PickleLive player ${playerId} (${row.name}) — linked_user_id=${row.linked_user_id || "none"}`);
    const duprId = row.dupr_id || (row.linked_user_id ? accountDuprIds.get(row.linked_user_id) : undefined);
    if (duprId) {
      console.log(`[DUPR] Linked DUPR account for ${playerId} — [DUPR] DUPR Player ID=${duprId} (source=${row.dupr_id ? "mixmatch_players.dupr_id" : "accounts.dupr_id via linked_user_id"})`);
      resolved.set(playerId, duprId);
    } else {
      console.log(`[DUPR] No linked DUPR account for ${playerId} (${row.name})`);
      missing.push({ playerId, name: row.name });
    }
  }

  return { resolved, missing };
}
