-- ============================================================================
-- 143: Team Elimination — configurable qualification modes, same-team
--      matchup avoidance policies, and arbitrary-size knockout brackets.
-- ============================================================================
-- Wires up the same_team_matchup_policy / elimination_participant_mode /
-- elimination_participant_count columns added by 135 — they were additive
-- placeholders that the app never actually read (DivisionEditorModal.jsx
-- hardcoded them to inert defaults on every save). Nothing in the app
-- currently depends on their existing values, so extending their allowed
-- values here is safe and does not migrate/backfill any existing row.
--
-- same_team_matchup_policy: 2 new values for the two additional avoidance
-- levels (Quarterfinal-only avoidance, and the strongest "Until Final"
-- avoidance). 'never'/'avoid_semis'/'allow_anywhere' (135) are kept valid so
-- any existing row keeps passing this constraint — the app simply stops
-- writing 'never' going forward ('allow_anywhere' becomes the new default
-- meaning, since 'never' was never actually enforced as "avoid everywhere" by
-- any code that existed when it shipped).
--
-- tournament_team_matchups.stage: one new generic value, 'knockout', for
-- every pre-semifinal knockout round (Quarterfinal, Round of 16, etc. — an
-- arbitrary number of them, disambiguated by the existing `round` column and
-- the existing free-text `stage_label`, not by enumerating a fixed name per
-- possible bracket depth). The literal 'semifinal' value (138) stays reserved
-- for exactly the round that feeds Bronze, unchanged from today.
--
-- elimination_manual_qualifier_ids: new nullable jsonb column — Manual mode
-- (135's elimination_participant_mode already allowed 'manual' as a value)
-- had no column to persist which individual pairs the organizer selected.
-- Same nullability precedent as tournament_divisions.seed_order (112):
-- meaningful only when elimination_participant_mode = 'manual'.
-- ============================================================================

alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_same_team_matchup_policy_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_same_team_matchup_policy_check
  check (same_team_matchup_policy in ('never','avoid_semis','allow_anywhere','avoid_quarterfinals','avoid_until_final'));

alter table public.tournament_team_matchups
  drop constraint if exists tournament_team_matchups_stage_check;
alter table public.tournament_team_matchups
  add constraint tournament_team_matchups_stage_check
  check (stage in ('round_robin','semifinal','bronze','final','knockout') or stage is null);

alter table public.tournament_divisions
  add column if not exists elimination_manual_qualifier_ids jsonb;
