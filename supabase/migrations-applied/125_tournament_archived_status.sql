-- STATUS: APPLIED (version 20260806144540, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 125: Archive as a distinct tournament status, past "completed".
-- ============================================================================
-- Additive only. Widens the existing tournaments_status_check constraint
-- (confirmed live via direct query: CHECK (status = ANY (ARRAY['draft',
-- 'active','completed','cancelled']))) to also allow 'archived'. No existing
-- row's status changes — every tournament stays exactly as it is today;
-- 'archived' is only ever written going forward, via the new Archive action
-- in TournamentsListScreen.jsx (shown once a tournament is 'completed').
-- Safe to re-run (drop-if-exists then re-add).
-- ============================================================================

alter table public.tournaments drop constraint if exists tournaments_status_check;
alter table public.tournaments add constraint tournaments_status_check
  check (status in ('draft','active','completed','cancelled','archived'));
