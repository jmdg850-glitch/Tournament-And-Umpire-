-- At most ONE Team Elimination knockout (playoff) stage per division.
--
-- generate_team_playoffs checks for an existing team_knockout stage and then
-- writes the stage and its semifinal/final/bronze matches in a single
-- apply_official_writes call. Two simultaneous requests (e.g. two organizer
-- devices whose Operator auto-generates playoffs when the round robin ends)
-- could both pass the check. With this index the second write fails as a
-- whole — apply_official_writes runs in one transaction, so none of its
-- stage/match rows are kept — and the API reports PLAYOFFS_EXIST.
--
-- Scoped to kind = 'team_knockout' only: 'bracket' and 'team_round_robin'
-- stages are unaffected. Production had no division with more than one
-- stage of any kind when this was written, so the index builds cleanly.

create unique index if not exists stages_one_team_knockout_per_division_uidx
  on public.stages (division_id)
  where kind = 'team_knockout';
