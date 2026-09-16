// Slug generation for the public "Live" spectator page (see
// supabase/migrations/0012_public_live_tournaments.sql). Slugs are always
// server-generated from the tournament name, lazily on first publish — never
// organizer-typed — so there's no profanity/format validation surface here.
import { httpError } from "./writes.js";

export function generateTournamentSlug(name) {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base || "tournament";
}

export function candidateSlug(base, attempt) {
  if (attempt <= 1) return base;
  if (attempt <= 9) return `${base}-${attempt}`;
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 5);
  return `${base}-${suffix}`;
}

export async function ensureUniqueSlug(admin, tournamentId, name) {
  const base = generateTournamentSlug(name);
  for (let attempt = 1; attempt <= 14; attempt++) {
    const candidate = candidateSlug(base, attempt);
    const { data, error } = await admin
      .from("tournaments")
      .select("id")
      .eq("slug", candidate)
      .neq("id", tournamentId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  throw httpError(500, "SLUG_GENERATION_FAILED", "Could not generate a unique tournament slug");
}
