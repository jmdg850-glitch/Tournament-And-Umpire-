-- ============================================================================
-- 139: Team-vs-Team umpire write hole — tournament_team_matchups_update.
-- ============================================================================
-- Reproduced live during umpire/toss-coin QA: an umpire (not the organizer)
-- completing an individual pair match inside a Team Elimination team-matchup
-- triggers advanceTournamentBracket's Outbox.enqueue("updateTeamMatchup", ...)
-- write (App.jsx, the live win-count tally and, on the matchup's final pair
-- match, its status/winnerTeamId) exactly like it does for the organizer.
-- tournament_team_matchups_update (migration 136) only ever allowed
-- organizer_id = auth.uid() / is_admin() / is_co_organizer_of(organizer_id),
-- so that write is silently rejected by RLS for the umpire — the completed
-- pair match's own row (tournament_matches, RLS already widened in migration
-- 127) is saved correctly, but the parent matchup's team_a_wins/team_b_wins
-- (and, on the deciding match, status/winner_team_id) never update. Same
-- failure shape as migration 130's write holes: the Outbox silently drops it,
-- no visible error, and Team Standings/Top-4/Semifinal generation stall
-- indefinitely for any matchup an umpire (rather than the organizer) finishes.
--
-- team_elimination postdates migration 130 (was added in 136), so this table
-- never got the umpire-widening pass 127/129/130 gave tournament_matches/
-- live_matches/matches/match_audit_log — this migration brings it in line,
-- same additive OR shape, every existing predicate unchanged.
--
-- tournament_team_matchups carries no umpire_id itself (only individual pair
-- matches do), so eligibility is "umpiring at least one pair match that
-- belongs to this matchup" — mirrors is_assigned_umpire_for_tournament_match's
-- shape/security-invoker choice exactly, one level up.
-- ============================================================================

create or replace function public.is_assigned_umpire_for_team_matchup(p_team_matchup_id text)
returns boolean
language sql
stable
security invoker
as $$
  select exists (
    select 1 from public.tournament_matches tm
    where tm.team_matchup_id = p_team_matchup_id and tm.umpire_id = auth.uid()::text
  );
$$;
grant execute on function public.is_assigned_umpire_for_team_matchup(text) to authenticated;

drop policy if exists tournament_team_matchups_update on public.tournament_team_matchups;
create policy tournament_team_matchups_update on public.tournament_team_matchups
  for update to authenticated
  using (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
    or public.is_assigned_umpire_for_team_matchup(id)
  )
  with check (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
    or public.is_assigned_umpire_for_team_matchup(id)
  );
