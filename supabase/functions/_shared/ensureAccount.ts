// Ensures a public.accounts row exists for the calling authenticated user,
// by delegating to the ensure_my_account() Postgres RPC (see migration
// 140_ensure_my_account_rpc.sql) — the single, server-side source of truth
// for "resolve or create my own profile row," also used client-side by
// src/lib/cloud.js's ensureMyAccount(). Server-side flows (like
// link-dupr-account) can't assume the client's own profile-creation step
// already ran — pending email confirmation, a dropped network call, a
// transient RPC error, or a pre-existing legacy-id row sharing the caller's
// email can all leave a fully authenticated Supabase Auth user with no (or
// the wrong) accounts row.
//
// Called with a client scoped to the CALLER's own bearer token (never the
// service-role client) so ensure_my_account()'s auth.uid()/auth.jwt() resolve
// to the caller — this can only ever create/touch/re-key the caller's own
// row, never another user's.
import { supabaseAsUser } from "./supabaseAdmin.ts";

export async function ensureAccountExists(token: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, error } = await supabaseAsUser(token).rpc("ensure_my_account");
  if (error || !data?.id) return { ok: false, error: error?.message || "Could not resolve profile" };
  return { ok: true };
}
