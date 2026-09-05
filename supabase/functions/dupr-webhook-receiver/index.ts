// DUPR webhook landing endpoint. verify_jwt=false in the function's config —
// DUPR carries no Supabase session, so gate instead with a PickleLive-chosen
// secret query param (set as a Supabase secret, embedded in the URL given to
// DUPR at registration time: POST /{version}/webhook).
//
// v1 deliberately only logs to dupr_webhook_events and returns 202 — DUPR's
// payload shape and signature/verification scheme were not found in
// available research (see plan doc). Treat the body as low-trust: nothing
// here acts on its contents yet. Once real credentials exist and a live
// payload has been observed, extend this to (a) verify a signature header if
// DUPR provides one, and (b) re-fetch authoritative state via an
// authenticated GET rather than trusting fields in the body directly.
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  const expected = Deno.env.get("DUPR_WEBHOOK_SECRET");

  if (!expected || key !== expected) {
    return new Response("Not found", { status: 404 }); // don't leak that this endpoint exists
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return new Response("Bad request", { status: 400 });

  const admin = supabaseAdmin();
  await admin.from("dupr_webhook_events").insert({
    id: crypto.randomUUID(),
    topic: typeof payload.topic === "string" ? payload.topic : null,
    payload,
  });

  return new Response(null, { status: 202 });
});
