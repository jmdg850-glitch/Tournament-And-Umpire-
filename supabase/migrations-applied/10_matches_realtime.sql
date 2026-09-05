-- Matches Realtime — enables Realtime replication for the existing `matches` (completed-match
-- history) table. Adds ZERO new tables/columns and does not touch, alter, or delete any existing
-- table, column, or row. Safe to re-run (the Realtime publication statement is wrapped so
-- re-adding an already-subscribed table is a harmless no-op instead of an error) — same pattern
-- as supabase_migration_v3_live_board.sql, supabase_migration_v5_match_organizer_invites.sql, and
-- supabase_migration_v8_events_realtime.sql.
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.
--
-- Why: a completed match's history row is written once via Cloud.upsertMatch (see endMatch's
-- Outbox.enqueue("upsertMatch",...) in App.jsx), but until now `matches` was never added to the
-- Realtime publication, so every other connected viewer only learned a match had finished via the
-- 10s poll in App()'s sync() effect. That delay also meant a just-finished match could briefly
-- vanish entirely from a Viewer's Event page: it's dropped from `live_matches` (already realtime)
-- the instant it completes, but its History row hadn't been poll-fetched yet. This migration,
-- paired with Cloud.subscribeMatchesChanges in App.jsx, makes a finished match move to History
-- instantly instead.

do $$
begin
  alter publication supabase_realtime add table public.matches;
exception when duplicate_object then null;
end $$;
