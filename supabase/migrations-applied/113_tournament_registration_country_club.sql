-- STATUS: APPLIED (version 20260804084249, confirmed live via list_migrations, 2026-08-04).
--
-- ============================================================================
-- 113: Optional Country/Club fields on tournament_registrations.
-- ============================================================================
-- New nullable columns only. Does not touch, alter, or delete any existing
-- table, column, or row. Safe to re-run (add column if not exists).
--
-- Team-level (one Country/Club pair per registration row), not per-player —
-- keeps this additive and small. A mixed-country doubles team can't be
-- represented distinctly per player; accepted simplification for this pass.
-- Feeds the external scoreboard's optional "Country/Club" display line.
-- ============================================================================

alter table public.tournament_registrations
  add column if not exists country text,
  add column if not exists club text;
