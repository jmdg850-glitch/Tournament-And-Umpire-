-- STATUS: APPLIED (via Supabase MCP apply_migration, 2026-08-08, during a live QA pass of
-- the umpire feature — found immediately after 130 while re-testing the completion flow).
-- ============================================================================
-- 131: tournament_results_insert — widen to the assigned umpire.
-- ============================================================================
-- endMatch()'s tournament bridge calls Cloud.upsertTournamentResult (champion/runner-up
-- award rows) right after a single-elimination final completes — the SAME completion flow
-- migrations 127/130 already widened for tournament_matches/live_matches/matches. This table
-- was missed: tournament_results_insert still required organizer_id = auth.uid(), so an
-- umpire-completed final's award rows were silently rejected by RLS every time (reproduced
-- live: 4 upsertTournamentResult Outbox items stuck retrying indefinitely after 130 was
-- applied and the rest of the completion flow started succeeding).
--
-- tournament_results has no tournament_match_id column of its own (it's keyed by
-- division_id, since champion/runner-up are per-division awards, not per-match) — so instead
-- of the tournament_match_id lookup 127/130 use, this checks whether the caller is the
-- assigned umpire of ANY match in that division. That's the correct scope: an umpire only
-- ever reaches this write by having just completed a match that belongs to that division.
-- ============================================================================

drop policy if exists tournament_results_insert on public.tournament_results;
create policy tournament_results_insert on public.tournament_results
  for insert to authenticated with check (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
    or exists (
      select 1 from public.tournament_matches tm
      where tm.division_id = tournament_results.division_id
        and tm.umpire_id = auth.uid()::text
    )
  );
