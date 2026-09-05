-- STATUS: APPLIED (version 20260806063154, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 120: Match Format extension — Win By + custom Timeouts per division.
-- ============================================================================
-- Additive only. `win_by` defaults to 'two' for every existing division,
-- which is exactly today's hardcoded behavior in src/lib/scoring.js's
-- checkGameWin (scoreA-scoreB>=2) — so no existing division's live/finished
-- matches change behavior until an organizer explicitly picks a different
-- value on a *new* division (checkGameWin's app-layer change makes 'two'
-- reproduce current behavior byte-for-byte). `timeouts_allowed` stays
-- nullable — null means "use scoring.js's existing DEFAULT_TIMEOUTS_ALLOWED",
-- so it's inert for every pre-existing row until an organizer sets it.
-- ============================================================================

alter table public.tournament_divisions
  add column if not exists win_by text not null default 'two';

alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_win_by_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_win_by_check
  check (win_by in ('one','two','none'));

alter table public.tournament_divisions
  add column if not exists timeouts_allowed integer;
