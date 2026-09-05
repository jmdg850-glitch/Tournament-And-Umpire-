-- ============================================================================
-- 137: Team Elimination Bracket Groups + persisted stage labels.
-- ============================================================================
-- Fixes the reported bug where a team_elimination bracket's first Team-vs-Team
-- round was mislabeled "Semifinal" (BracketView.jsx's roundLabel() is a pure
-- distance-from-final arithmetic function with no concept of "this is actually
-- the first round"). Stage labels ("Elimination Round"/"Semifinal"/"Quarterfinal"/
-- "Final"/"Bronze Match") are now computed once at generation time from the
-- actual matchup graph shape (src/lib/tournamentTeamGroups.js computeStageLabels)
-- and persisted here, rather than recomputed client-side from round numbers.
--
-- Also adds optional NBA-style "Bracket Groups": organizers may split Teams
-- into named groups (e.g. "Bracket A", "Bracket B") so teams play within their
-- own group until a group champion emerges; group champions then meet in a
-- merge stage (a single Final for 2 groups, or a round robin -> Final/Bronze
-- for 3+ groups — see tournamentTeamGroups.js). Purely additive/optional: a
-- team with bracket_group left null is simply ungrouped, and a division where
-- no team has a bracket_group set continues to generate the exact same flat
-- bracket as before this migration (see 136_team_vs_team_elimination.sql).
--
-- No changes to any existing column/constraint from 134/135/136. No realtime
-- publication statement needed — tournament_teams (134) and
-- tournament_team_matchups (136) are already in the supabase_realtime
-- publication, and adding a nullable column to an already-published table
-- requires no further publication action.
-- ============================================================================

-- Which named Bracket Group this Team plays in during the group phase.
-- NULL = ungrouped (legacy flat bracket behavior).
alter table public.tournament_teams
  add column if not exists bracket_group text;

-- Which group's own tier-1 bracket this matchup belongs to. NULL for
-- merge-stage rows (the Final / Bronze / round-robin-among-champions rows)
-- and for every row of a legacy/ungrouped flat bracket.
alter table public.tournament_team_matchups
  add column if not exists bracket_group text;

-- Persisted stage label ("Elimination Round" | "Quarterfinal" | "Semifinal" |
-- "Final" | "Bronze Match" | a generic "Round N"/"<Group> - Round N" fallback),
-- computed once at generation/dynamic-creation time by
-- tournamentTeamGroups.js's computeStageLabels. NULL only for team_matchup
-- rows created before this migration shipped — BracketView.jsx falls back to
-- the old roundLabel() arithmetic for those, never recomputes it for new rows.
alter table public.tournament_team_matchups
  add column if not exists stage_label text;

-- 3+ Bracket Groups only: which two groups' champion-slots this round-robin
-- merge-stage matchup is scheduled between (group labels, not team ids — the
-- real team_a_id/team_b_id are only known once each group's own decider
-- completes and patches them in). NULL everywhere else (legacy flat bracket,
-- 2-group direct Final, and every tier-1 in-group matchup).
alter table public.tournament_team_matchups
  add column if not exists merge_group_a text;
alter table public.tournament_team_matchups
  add column if not exists merge_group_b text;
