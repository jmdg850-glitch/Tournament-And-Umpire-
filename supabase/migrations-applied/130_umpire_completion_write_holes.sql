-- STATUS: APPLIED (via Supabase MCP apply_migration, 2026-08-08, during a live QA pass of
-- the umpire feature).
-- ============================================================================
-- 130: Umpire match-completion write holes — matches_insert, live_matches_delete.
-- ============================================================================
-- Migration 127 widened tournament_matches_update and live_matches_insert/update for the
-- assigned umpire, but missed two more tables the SAME endMatch() completion flow writes to:
--
--   1. matches (completed-match history, migration 105's matches_insert) — still required
--      data->>'organizerId' = auth.uid(), which for a tournament match is the tournament's
--      real organizer, not the umpire. Reproduced live: an umpire ending their own assigned
--      match got this INSERT silently rejected by RLS. Cloud.upsertMatch (see accompanying
--      JS fix) never checked the Supabase response's `error` field, so this looked like a
--      successful write and the Outbox permanently dropped it — no retry, no visible error,
--      and the match's own history row simply never existed.
--   2. live_matches_delete (migration 102) — still organizerId-only. endMatch()'s
--      Outbox.enqueue("deleteLiveMatch",...) silently no-opped (RLS blocks 0 rows, not an
--      error) for the umpire, so the live match row was never cleaned up and kept showing
--      as LIVE everywhere after the umpire "finished" it.
--
-- Downstream effect of #1: the tournament_matches completion PATCH (status: completed,
-- completed_match_id: <the matches row's id>) then failed its own foreign key constraint
-- (tournament_matches_completed_match_id_fkey), because that matches row never existed —
-- so the umpire's match got permanently stuck showing "in_progress"/"LIVE" on the bracket,
-- organizer dashboards, and Live Matches board, even though the umpire's own screen had
-- already moved on to Match History believing it succeeded.
--
-- Same shape as 127/129: purely additive, ORs in the existing
-- is_assigned_umpire_for_tournament_match() helper, every existing predicate unchanged.
-- ============================================================================

drop policy if exists matches_insert on public.matches;
create policy matches_insert on public.matches for insert
  to authenticated
  with check (
    ((data->>'organizerId') is null)
    or (data->>'organizerId' = auth.uid()::text)
    or (data->'organizerIds' ? auth.uid()::text)
    or is_admin()
    or (data->>'tournamentMatchId' is not null and public.is_assigned_umpire_for_tournament_match(data->>'tournamentMatchId'))
  );

drop policy if exists live_matches_delete on public.live_matches;
create policy live_matches_delete on public.live_matches
  for delete to authenticated
  using (
    data->>'organizerId' is null
    or data->>'organizerId' = auth.uid()::text
    or data->'organizerIds' ? auth.uid()::text
    or public.is_admin()
    or (data->>'tournamentMatchId' is not null and public.is_assigned_umpire_for_tournament_match(data->>'tournamentMatchId'))
  );
