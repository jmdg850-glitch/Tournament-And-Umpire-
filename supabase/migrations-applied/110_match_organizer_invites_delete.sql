-- ============================================================================
-- 110: match_organizer_invites — add the missing DELETE policy
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28) (was safe to apply independently of the rest:
-- this table already uses real auth.uid() policies and this only ADDS the
-- delete capability the client code expects).
--
-- Without a DELETE policy, RLS filters deletes to zero rows and PostgREST
-- reports success — the exact failure mode documented for live_matches in
-- migrations-applied/09_live_matches_rls.sql.
-- ============================================================================

drop policy if exists moi_delete on public.match_organizer_invites;

create policy moi_delete on public.match_organizer_invites
  for delete to authenticated
  using (owner_id = auth.uid()::text);
