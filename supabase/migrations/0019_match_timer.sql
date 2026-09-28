-- Game timer: one nullable jsonb column on public.matches.
--
-- Shape (written only by the command API, see packages/engine/src/gameTimer.js):
--   { "v": 1, "durationSec": int, "remainingMs": int,
--     "runningSince": timestamptz-as-text | null, "updatedAt": text, "updatedBy": uuid-as-text }
-- NULL (every existing row) = no timer: the match behaves exactly as before.
--
-- Why a column: score_state is rebuilt from score_events by the scoring
-- reducer, so it cannot hold anything else, and no other matches column fits.
--
-- Nothing else changes:
--   - apply_official_writes (0018) writes whatever columns exist, so it picks
--     this one up without being redefined;
--   - matches RLS / SELECT grants and the realtime publication (REPLICA
--     IDENTITY FULL) already cover every column;
--   - no default, no backfill, no constraint: non-destructive and instant.
--
-- Compatibility:
--   - Old command API + this migration: the column is carried through
--     unchanged by `...match` spreads; no timer is ever set.
--   - New command API WITHOUT this migration: start_match skips the timer and
--     set_match_timer answers 409 TIMER_UNAVAILABLE.
--
-- Rollback: `alter table public.matches drop column if exists timer;`

alter table public.matches
  add column if not exists timer jsonb;
