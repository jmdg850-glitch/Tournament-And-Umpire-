-- STATUS: APPLIED (version 20260807102042, confirmed live via list_migrations, 2026-08-07).
-- ============================================================================
-- 129: match_audit_log — widen select/insert to co-organizers.
-- ============================================================================
-- Gap found during Phase 9 verification of the umpire feature: 128's policies only
-- checked `organizer_id = auth.uid()` (the tournament's primary owner) — a
-- CO-organizer (already granted full match control by tournament_matches_update's
-- own `is_co_organizer_of(organizer_id)` clause, and by canControlMatch client-side)
-- had every actual match-control action succeed, but their own Cloud.appendAuditLog
-- write would be silently rejected by RLS (appendAuditLog never throws, so this
-- never broke anything functionally — it just silently dropped that one
-- supplementary audit entry). Purely additive: ORs in the same is_co_organizer_of
-- helper tournament_matches_update already uses, every existing predicate kept as-is.
-- ============================================================================

drop policy if exists match_audit_log_select on public.match_audit_log;
drop policy if exists match_audit_log_insert on public.match_audit_log;

create policy match_audit_log_select on public.match_audit_log
  for select to authenticated
  using (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
    or public.is_assigned_umpire_for_tournament_match(tournament_match_id)
  );

create policy match_audit_log_insert on public.match_audit_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()::text
    and (
      organizer_id = auth.uid()::text
      or public.is_admin()
      or public.is_co_organizer_of(organizer_id)
      or public.is_assigned_umpire_for_tournament_match(tournament_match_id)
    )
  );
