import { createClient } from "npm:@supabase/supabase-js@2";
import { handleLicense, isPublicAction } from "./license.js";

// Licensing endpoint (email -> one code -> one PC). The caller's identity comes
// ONLY from the verified Supabase JWT; admin rights are checked against
// public.license_admins on every call. verify_jwt is off at the gateway because
// verification happens here (same pattern as the `command` function).

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function fail(code: string, message: string, status: number, detail?: string) {
  return json({ ok: false, error: { code, message, ...(detail ? { detail } : {}) } }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("METHOD_NOT_ALLOWED", "Method not allowed.", 405);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("VALIDATION", "The request contains invalid data.", 400, "body must be JSON");
  }

  // Code-first setup (claim / set_password) is authorized by the access code
  // itself and runs without a session; every other action needs a verified JWT.
  const isPublic = isPublicAction(body);
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt && !isPublic) return fail("UNAUTHENTICATED", "Please sign in to continue.", 401);

  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    if (isPublic) return json(await handleLicense({ admin, actor: null, body }));

    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return fail("UNAUTHENTICATED", "Please sign in to continue.", 401);
    const actor = {
      id: data.user.id,
      email: data.user.email ?? null,
      emailConfirmed: Boolean(data.user.email_confirmed_at),
    };

    return json(await handleLicense({ admin, actor, body }));
  } catch (err) {
    if (err && err.name === "LicenseError") {
      // publicMessage is the customer-safe text; `detail` is only the short
      // validation reason we wrote ourselves, never a database or stack message.
      const detail = err.code === "VALIDATION" ? err.message : undefined;
      return fail(err.code, err.publicMessage, Number(err.status) || 500, detail);
    }
    console.error("[license] unhandled:", err?.message);
    return fail("INTERNAL", "Something went wrong. Please try again.", 500);
  }
});
