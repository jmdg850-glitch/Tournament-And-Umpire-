-- STATUS: APPLIED (version 20260805070925, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 118: Bronze Match (3rd-place playoff) for Single Elimination divisions.
-- ============================================================================
-- Additive only. has_bronze_match defaults false for every existing division
-- (round_robin/single_elimination/double_elimination all unaffected). Widens
-- the existing named bracket_side check (confirmed live as
-- tournament_matches_bracket_side_check, from migration 114) to also allow
-- 'bronze' — a single extra match generated only when a single-elimination
-- division explicitly opts in, wired from the two semifinal matches' losers
-- (see tournamentBracket.js). Double elimination doesn't need this: its 3rd
-- place is already unambiguous (the losers-bracket runner-up), so bronze
-- match generation is scoped to single_elimination only at the app layer.
-- ============================================================================

alter table public.tournament_divisions
  add column if not exists has_bronze_match boolean not null default false;

alter table public.tournament_matches
  drop constraint if exists tournament_matches_bracket_side_check;
alter table public.tournament_matches
  add constraint tournament_matches_bracket_side_check
  check (bracket_side in ('winners','losers','final','bronze'));
