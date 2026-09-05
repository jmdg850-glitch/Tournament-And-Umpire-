-- STATUS: APPLIED (version 20260806164009, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 126: Top 4 Playoffs opt-in for Round Robin divisions.
-- ============================================================================
-- Additive only. Defaults false for every existing division (round_robin and
-- every other format alike) — nothing changes for any division that doesn't
-- explicitly opt in via the new DivisionEditorModal toggle. Only meaningful
-- for format:"round_robin"; every other format ignores this column entirely.
--
-- No other schema change needed for this feature: the Semifinal/Final/Bronze
-- shell it generates reuses tournament_matches.registration_a_id/b_id (already
-- nullable) and bracket_side (already allows 'winners'/'final'/'bronze' per
-- migrations 114/118) — see src/lib/tournamentBracket.js's
-- generateTop4PlayoffShell for how those are populated/patched.
-- ============================================================================

alter table public.tournament_divisions
  add column if not exists top4_playoffs boolean not null default false;
