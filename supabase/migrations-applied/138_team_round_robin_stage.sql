-- ============================================================================
-- 138: Team Elimination — Cross-Team Round Robin stage tag.
-- ============================================================================
-- Team Elimination no longer generates a knockout bracket (134/135/136/137).
-- It now runs a flat round robin across ALL teams in the division (every team
-- plays every other team once; Bracket Groups from 137 are dropped for this
-- format going forward — that file/UI is left in place but unused here), then
-- computes team standings, takes the Top 4, and runs Semifinals -> Battle for
-- Bronze + Final. Each Team-vs-Team matchup, at every stage, plays a balanced
-- N x (N-1) cross-rotation pair-match schedule (see tournamentTeamVsTeam.js's
-- rewritten buildPairMatchesForMatchup) instead of the old "Pair i vs Pair i"
-- majority-decided schedule.
--
-- `stage` distinguishes a matchup's role for progression logic
-- (round_robin -> semifinal -> bronze/final), independently of the existing
-- free-text `stage_label` (137) which is display-only. Left NULLABLE with NO
-- DEFAULT deliberately: existing team_elimination matchups generated before
-- this migration (under the old knockout logic) will have stage IS NULL
-- forever, which is exactly how the app tells a legacy bracket apart from one
-- generated under the new format — those old brackets are not migrated, the
-- UI just shows a "regenerate" notice for them instead of attempting to
-- render them with the new layout.
--
-- No other schema changes needed: pairs_per_matchup (136) keeps storing pairs
-- PER TEAM (N) — total individual matches for a matchup is now derived as
-- N x (N-1), not read from any column. tournament_matches.pair_slot (136)
-- keeps ordering matches 1-based within a matchup; the display "rotation
-- number" is derived client-side as floor((pair_slot-1)/N)+1.
-- ============================================================================

alter table public.tournament_team_matchups
  add column if not exists stage text;

alter table public.tournament_team_matchups
  drop constraint if exists tournament_team_matchups_stage_check;
alter table public.tournament_team_matchups
  add constraint tournament_team_matchups_stage_check
  check (stage in ('round_robin','semifinal','bronze','final') or stage is null);
