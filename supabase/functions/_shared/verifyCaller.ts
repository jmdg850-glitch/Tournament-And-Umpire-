// Verifies the incoming Supabase Auth JWT and returns the caller's user id.
// Belt-and-suspenders alongside each function's own verify_jwt=true gateway
// config — this gives the handler a trustworthy userId to authorize against,
// rather than assuming the gateway check alone is enough.
import { supabaseAnon } from "./supabaseAdmin.ts";

export async function verifyCaller(req: Request): Promise<{ userId: string; email: string | null; token: string } | { error: string; status: number }> {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return { error: "Missing Authorization header", status: 401 };

  const { data, error } = await supabaseAnon().auth.getUser(token);
  if (error || !data?.user) return { error: "Invalid or expired session", status: 401 };

  return { userId: data.user.id, email: data.user.email ?? null, token };
}
