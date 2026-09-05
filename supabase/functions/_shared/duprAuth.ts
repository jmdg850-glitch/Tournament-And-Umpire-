// DUPR Bearer-token acquisition + caching. DUPR's /auth/{version}/token
// returns a token + expiry but no refresh token (per the reference PHP
// client) — re-authenticate via HTTP Basic Auth (clientKey:clientSecret)
// again as expiry approaches. Cached in public.dupr_auth_cache (a singleton
// row, service-role-only table) so cold Edge Function invocations don't each
// pay for a fresh token fetch.
import { supabaseAdmin } from "./supabaseAdmin.ts";

const REFRESH_MARGIN_MS = 60_000; // mirrors the reference client's 60s margin

function config() {
  const baseUrl = Deno.env.get("DUPR_BASE_URL") || "https://uat.mydupr.com/api";
  // Confirmed against the live spec (https://uat.mydupr.com/api/v3/api-docs,
  // /auth/{version}/token's `version` path param): default is "v1.0", not "v1".
  const version = Deno.env.get("DUPR_VERSION") || "v1.0";
  const clientKey = Deno.env.get("DUPR_CLIENT_KEY");
  const clientSecret = Deno.env.get("DUPR_CLIENT_SECRET");
  return { baseUrl, version, clientKey, clientSecret };
}

async function fetchFreshToken(): Promise<{ token: string; expiresAt: Date; requestId?: string }> {
  const { baseUrl, version, clientKey, clientSecret } = config();
  if (!clientKey || !clientSecret) {
    throw new Error("DUPR_CLIENT_KEY / DUPR_CLIENT_SECRET not configured");
  }
  const basic = btoa(`${clientKey}:${clientSecret}`);
  const res = await fetch(`${baseUrl}/auth/${version}/token`, {
    method: "POST",
    headers: {
      // Confirmed against the live spec: DUPR expects the base64 credentials
      // in a custom `x-authorization` header, NOT the standard `Authorization`
      // header — the previous implementation used the wrong header entirely.
      "x-authorization": basic,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const requestId = res.headers.get("X-Request-Id") || undefined;
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.status !== "SUCCESS") {
    const suffix = requestId ? ` (X-Request-Id: ${requestId})` : "";
    throw new Error(`DUPR auth failed (${res.status}): ${body?.message || "unknown error"}${suffix}`);
  }
  // `result.expiry` is an ISO timestamp per the spec (token valid 1 hour);
  // falls back to a conservative 10-minute assumption if unparsable so the
  // cache never claims an unbounded lifetime.
  const parsed = body.result?.expiry ? new Date(body.result.expiry) : null;
  const expiresAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(Date.now() + 10 * 60_000);
  return { token: body.result.token as string, expiresAt, requestId };
}

export async function getDuprBearerToken(): Promise<string> {
  const admin = supabaseAdmin();
  const { data: cached } = await admin
    .from("dupr_auth_cache")
    .select("access_token, expires_at")
    .eq("id", "singleton")
    .maybeSingle();

  if (cached && new Date(cached.expires_at).getTime() - Date.now() > REFRESH_MARGIN_MS) {
    return cached.access_token as string;
  }

  const { token, expiresAt, requestId } = await fetchFreshToken();
  if (requestId) console.log(`[dupr] token refreshed, X-Request-Id: ${requestId}`);
  await admin.from("dupr_auth_cache").upsert({
    id: "singleton",
    access_token: token,
    expires_at: expiresAt.toISOString(),
    updated_at: new Date().toISOString(),
  });
  return token;
}
