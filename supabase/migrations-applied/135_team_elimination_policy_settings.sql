-- ============================================================================
-- 135: Team Elimination configurable Same-Team Matchup Policy + Elimination
--      Participant Mode settings on tournament_divisions.
-- ============================================================================
-- Additive, idempotent columns following the exact pattern migration 122 used
-- for pool_knockout_format (nullable enum-like text + a separately-named CHECK
-- constraint, `add column if not exists` so this is safe to re-run).
--
-- same_team_matchup_policy defaults to 'never' (not null) so every existing
-- team_elimination division (and any created before an organizer touches the
-- new setting) keeps exactly the behavior already shipped in migration 134 —
-- maximum separation at every round, no regression.
--
-- elimination_participant_mode defaults to 'all' (not null) — every existing
-- division already effectively runs "All Pairs Advance" today (BracketView.jsx
-- has always taken every non-withdrawn registration), so this default is also
-- a pure no-op for anything generated before this migration.
--
-- elimination_participant_count stays nullable — only meaningful for the two
-- 'top_x'/'top_x_per_team' modes, same nullability reasoning as
-- pool_knockout_format staying null for non-pool formats.
-- ============================================================================

alter table public.tournament_divisions
  add column if not exists same_team_matchup_policy text not null default 'never';
alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_same_team_matchup_policy_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_same_team_matchup_policy_check
  check (same_team_matchup_policy in ('never','avoid_semis','allow_anywhere'));

alter table public.tournament_divisions
  add column if not exists elimination_participant_mode text not null default 'all';
alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_elimination_participant_mode_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_elimination_participant_mode_check
  check (elimination_participant_mode in ('all','top_x','top_x_per_team','manual'));

alter table public.tournament_divisions
  add column if not exists elimination_participant_count integer;
