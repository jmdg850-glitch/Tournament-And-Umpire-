import { createClient } from "npm:@supabase/supabase-js@2";
import { errorResponse, handleCommand, resolveActor } from "./handleCommand.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ ok: false, error: { code: "METHOD", message: "POST only" } }, 405);

  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: { code: "UNAUTHENTICATED", message: "Missing JWT" } }, 401);

  let commandId = null;
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    const admin = createClient(url, service, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const actor = await resolveActor(admin, jwt);
    const body = await req.json().catch(() => {
      throw Object.assign(new Error("Request body must be JSON"), { status: 400, code: "INVALID_COMMAND" });
    });
    commandId = typeof body?.command_id === "string" ? body.command_id : null;
    const result = await handleCommand({ admin, actor, body });
    return json(result);
  } catch (err) {
    // Deliberate API errors keep their code/message; anything else is
    // reported generically (no database or runtime internals).
    const { status, body } = errorResponse(err, commandId);
    return json(body, status);
  }
});
