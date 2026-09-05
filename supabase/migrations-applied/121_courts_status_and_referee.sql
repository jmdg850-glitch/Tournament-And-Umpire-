-- STATUS: APPLIED (version 20260806063203, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 121: Court Management extension (status) + Live Match referee.
-- ============================================================================
-- Additive only. `courts.status` is a NEW column alongside the existing
-- `active` boolean — it does NOT replace it. Casual Open Play's CourtMgrModal.jsx
-- continues to read/write only `active` and is completely unaffected; the
-- Tournament Module's new Court Management UI (src/screens/tournaments/) reads
-- both. Defaults to 'available' for every existing court so nothing appears
-- occupied/cleaning/maintenance until an organizer explicitly sets it.
-- `tournament_matches.referee_name` is a plain nullable text field, no new
-- referee/user concept — freeform name entry only.
-- ============================================================================

alter table public.courts
  add column if not exists status text not null default 'available';

alter table public.courts
  drop constraint if exists courts_status_check;
alter table public.courts
  add constraint courts_status_check
  check (status in ('available','occupied','cleaning','maintenance'));

alter table public.tournament_matches
  add column if not exists referee_name text;
