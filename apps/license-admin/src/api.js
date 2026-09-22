import { createBrowserClient } from "@tournament/client";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);
export const supabase = configured ? createBrowserClient(url, key) : null;

const LICENSE_URL = import.meta.env.VITE_LICENSE_URL || `${url}/functions/v1/license`;

export class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Every call goes to the server, which decides who is an admin. Nothing here is
// trusted for authorization.
export async function callAdmin(action, body = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) throw new ApiError("UNAUTHENTICATED", "Please sign in to continue.", 401);
  let res;
  try {
    res = await fetch(LICENSE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, apikey: key },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new ApiError("NETWORK", "Cannot reach the server. Check your internet connection.", 0);
  }
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok || !json?.ok) {
    throw new ApiError(json?.error?.code || "INTERNAL", json?.error?.message || "Something went wrong. Please try again.", res.status);
  }
  return json.result;
}
