-- STATUS: APPLIED (version 20260806063146, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 119: Tournament Details extension — banner image + tournament type(s).
-- ============================================================================
-- Additive only. `types` is a jsonb array (app-level values: "singles",
-- "doubles", "mixed" — multi-select, matching the spec's "allow multiple
-- selections"), defaulting to '[]' so every existing tournament row is
-- unaffected until an organizer edits it. No CHECK constraint on the array
-- contents (consistent with how organizer_ids/organizer_names and every other
-- jsonb column in this table set is left unvalidated at the DB layer — the
-- app is the single writer). `banner_url` mirrors the existing `logo_url`
-- column exactly (same nullable text shape).
-- ============================================================================

alter table public.tournaments
  add column if not exists banner_url text;

alter table public.tournaments
  add column if not exists types jsonb not null default '[]'::jsonb;
