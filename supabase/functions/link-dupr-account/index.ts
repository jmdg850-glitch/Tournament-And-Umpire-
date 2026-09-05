// POST { mode: "sso", userToken, refreshToken, duprId, expiresAt? } — link the
//   caller's own account via the real DUPR "Login with DUPR" iframe flow.
// POST { mode: "self", disconnect: true } — unlink the caller's own account.
// POST { mode: "search", query } — full-text DUPR name search (organizer
//   picking a guest player's real identity — there is no email-lookup
//   endpoint in the real DUPR API).
// POST { mode: "guest", mixmatchPlayerId, duprId, fullName? } — an organizer
//   links a guest/manual roster row (no PickleLive account of its own) to a
//   DUPR id they picked from a "search" result.
import { getDupr } from "../_shared/duprClient.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { verifyCaller } from "../_shared/verifyCaller.ts";
import { ensureAccountExists } from "../_shared/ensureAccount.ts";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const caller = await verifyCaller(req);
  if ("error" in caller) return json({ ok: false, error: caller.error }, caller.status);

  const body = await req.json().catch(() => ({}));
  const admin = supabaseAdmin();
  const dupr = getDupr();

  if (body.mode === "sso-config") {
    // Per DUPR's RaaS SSO docs, the login iframe URL is
    // https://<host>/login-external-app/:clientKey where :clientKey is the
    // partner's Client Key, base64-encoded — this is meant to be embedded in
    // a page the browser loads (like an OAuth client_id), unlike
    // DUPR_CLIENT_SECRET which never leaves this Edge Function. Served from
    // config rather than baked into the Vite build so UAT/production can be
    // switched via secrets alone.
    const clientKey = Deno.env.get("DUPR_CLIENT_KEY");
    if (!clientKey) return json({ ok: false, error: "DUPR not configured" }, 503);
    const env = (Deno.env.get("DUPR_ENV") || "uat").toLowerCase();
    const host = env === "production" ? "dashboard.dupr.com" : "uat.dupr.gg";
    return json({ ok: true, clientKeyBase64: btoa(clientKey), loginHost: host });
  }

  if (body.mode === "self" && body.disconnect) {
    const upd = await admin
      .from("accounts")
      .update({ dupr_id: null, dupr_full_name: null, dupr_status: "unlinked", dupr_linked_at: null })
      .eq("id", caller.userId);
    if (upd.error) return json({ ok: false, error: "Could not update account" }, 500);
    const del = await admin.from("dupr_user_sso_tokens").delete().eq("account_id", caller.userId);
    if (del.error) return json({ ok: false, error: "Could not clear stored tokens" }, 500);
    return json({ ok: true, status: "unlinked" });
  }

  if (body.mode === "sso") {
    // The iframe handshake (DuprPanel.jsx) already tells us the DUPR id and
    // hands over the user's own DUPR-issued tokens directly — no separate
    // lookup call is needed or possible (there is no email-lookup endpoint in
    // the real API). We still call getUserDetails (using OUR OWN partner
    // bearer token, not the user's SSO token) as a sanity check that the id
    // is real and to fetch a display name, rather than trusting the iframe
    // payload's fields blindly.
    const userToken = String(body.userToken || "");
    const refreshToken = String(body.refreshToken || "");
    const duprId = String(body.duprId || "");
    if (!userToken || !refreshToken || !duprId) {
      return json({ ok: false, error: "userToken, refreshToken and duprId are required" }, 400);
    }

    // A signed-in auth user may not have completed the client-side profile
    // creation step yet (accounts rows are normally created by ensureProfile()
    // in App.jsx, not at signup) — ensure it here so DUPR linking doesn't
    // depend on that having already happened. Delegates to the
    // ensure_my_account() RPC, scoped to the caller's own JWT (never a
    // client-supplied id), so this can only ever resolve/create the caller's
    // own row.
    const accountEnsure = await ensureAccountExists(caller.token);
    if (!accountEnsure.ok) {
      return json({ ok: false, error: "Couldn't save your DUPR link — please try again." }, 200);
    }

    const details = await dupr.getUserDetails(duprId);
    if (!details.ok) {
      return json({ ok: false, error: details.error || "Could not verify DUPR identity" }, 200);
    }
    const fullName = details.data?.fullName || null;
    // Separate from PickleLive's own accounts.singles_rating/doubles_rating
    // (internal rating system) — display-only, never fed into that engine.
    const duprSinglesRating = details.data?.singlesRating ?? null;
    const duprDoublesRating = details.data?.doublesRating ?? null;

    // Refuse to steal a DUPR identity that's already linked to a DIFFERENT
    // PickleLive account, rather than silently reassigning it — surfaces a
    // safe, generic message with no details about the other account.
    const conflict = await admin
      .from("accounts")
      .select("id")
      .eq("dupr_id", duprId)
      .eq("dupr_status", "linked")
      .neq("id", caller.userId)
      .maybeSingle();
    if (conflict.data) {
      return json({ ok: false, error: "This DUPR account is already connected to another PickleLive account. Please unlink it from that account first or contact PickleLive Support." }, 200);
    }

    const expiresAt = body.expiresAt ? new Date(String(body.expiresAt)) : null;
    const tokenUpsert = await admin.from("dupr_user_sso_tokens").upsert({
      account_id: caller.userId,
      user_token: userToken,
      refresh_token: refreshToken,
      expires_at: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      updated_at: new Date().toISOString(),
    });
    // dupr_user_sso_tokens.account_id has a FK on accounts(id) — ensureAccountExists
    // above guarantees that row exists, so this should only fire on a genuine
    // DB error now, not a missing profile.
    if (tokenUpsert.error) {
      return json({ ok: false, error: "Couldn't save your DUPR link — please try again." }, 200);
    }

    const acctUpdate = await admin
      .from("accounts")
      .update({
        dupr_id: duprId,
        dupr_full_name: fullName,
        dupr_status: "linked",
        dupr_linked_at: new Date().toISOString(),
        dupr_singles_rating: duprSinglesRating,
        dupr_doubles_rating: duprDoublesRating,
      })
      .eq("id", caller.userId)
      .select("id");
    if (acctUpdate.error || !acctUpdate.data?.length) {
      // Roll back the token row rather than leaving it orphaned from an
      // account that was never actually marked linked.
      await admin.from("dupr_user_sso_tokens").delete().eq("account_id", caller.userId);
      return json({ ok: false, error: "Couldn't save your DUPR link — please try again." }, 200);
    }

    // Best-effort propagation to any roster rows already linked to this
    // account — optimization only, submission always re-resolves
    // authoritatively via idResolver regardless.
    await admin.from("mixmatch_players").update({ dupr_id: duprId }).eq("linked_user_id", caller.userId);

    return json({ ok: true, status: "linked", duprId, fullName });
  }

  if (body.mode === "search") {
    const query = String(body.query || "").trim();
    if (!query) return json({ ok: false, error: "query is required" }, 400);
    const result = await dupr.searchPlayersByName(query, 10);
    if (!result.ok) return json({ ok: false, error: result.error || "DUPR search failed" }, 200);
    return json({ ok: true, hits: result.data?.hits || [] });
  }

  if (body.mode === "guest") {
    const mixmatchPlayerId = String(body.mixmatchPlayerId || "");
    const duprId = String(body.duprId || "");
    if (!mixmatchPlayerId || !duprId) {
      return json({ ok: false, error: "mixmatchPlayerId and duprId are required" }, 400);
    }

    // Only the organizer/co-organizer of this roster row's own organizer may
    // link it — check the roster row's organizer_id against the caller,
    // mirroring the same trust boundary submit-match enforces per match.
    const { data: rosterRow } = await admin
      .from("mixmatch_players")
      .select("id, organizer_id, name")
      .eq("id", mixmatchPlayerId)
      .maybeSingle();
    if (!rosterRow) return json({ ok: false, error: "Roster player not found" }, 404);
    if (rosterRow.organizer_id !== caller.userId) {
      const { data: adminRow } = await admin.from("admins").select("user_id").eq("user_id", caller.userId).maybeSingle();
      const { data: coOrgEvent } = await admin
        .from("events")
        .select("organizer_ids")
        .eq("owner_id", rosterRow.organizer_id)
        .contains("organizer_ids", [caller.userId])
        .limit(1)
        .maybeSingle();
      if (!adminRow && !coOrgEvent) return json({ ok: false, error: "Not authorized for this roster" }, 403);
    }

    // Confirm the id is a real DUPR identity before trusting it, rather than
    // storing whatever the client sent unverified.
    const details = await dupr.getUserDetails(duprId);
    if (!details.ok) return json({ ok: false, error: details.error || "Could not verify DUPR identity" }, 200);

    const rosterUpdate = await admin.from("mixmatch_players").update({ dupr_id: duprId }).eq("id", mixmatchPlayerId);
    if (rosterUpdate.error) return json({ ok: false, error: "Could not save DUPR link for that player" }, 500);
    return json({ ok: true, status: "linked", duprId, fullName: details.data?.fullName || null });
  }

  return json({ ok: false, error: "Unknown mode" }, 400);
});
