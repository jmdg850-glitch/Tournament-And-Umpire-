// Service-role Supabase client — bypasses RLS entirely. Never expose
// SUPABASE_SERVICE_ROLE_KEY outside this server-side function runtime (it is
// set as a Supabase secret, never a VITE_* env var, so it can never ship in
// the frontend bundle).
import { createClient } from "npm:@supabase/supabase-js@2";

export function supabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Plain anon-key client, used only to verify a caller's JWT (verifyCaller.ts)
// — never used for data access, which always goes through supabaseAdmin().
export function supabaseAnon() {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not configured");
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Anon-key client carrying the CALLER's own bearer token — PostgREST resolves
// auth.uid()/auth.jwt() from this token, so RLS and SECURITY DEFINER RPCs
// (e.g. ensure_my_account()) run in the caller's own identity, not the
// service role's. Never used for anything the caller isn't already allowed
// to do themselves — this is not a privilege-escalation path.
export function supabaseAsUser(token: string) {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not configured");
  }
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}
