-- STATUS: APPLIED (version 20260804084359, confirmed live via list_migrations, 2026-08-04).
--
-- ============================================================================
-- 115: Team name, per-player gender/age/DUPR rating on tournament_registrations.
-- ============================================================================
-- New nullable/default-empty columns only. Does not touch, alter, or delete
-- any existing table, column, or row. Safe to re-run (add column if not exists).
--
-- Gender/age/DUPR rating are per-player id -> value maps (same shape as the
-- existing player_names column), not team-level fields like country/club —
-- a doubles team has two distinct players who can have different ages,
-- genders, and ratings, so the country/club team-level shortcut from
-- migration 113 (an explicit, narrower simplification) doesn't fit here.
--
-- seed and status already exist from migration 112 — no new columns needed
-- for those two; this migration only closes the gap on the fields that were
-- never given a UI (RegistrationModal) despite existing here.
-- ============================================================================

alter table public.tournament_registrations
  add column if not exists team_name text,
  add column if not exists player_genders jsonb not null default '{}'::jsonb,
  add column if not exists player_ages jsonb not null default '{}'::jsonb,
  add column if not exists player_dupr_ratings jsonb not null default '{}'::jsonb;
