-- Events Realtime — enables Realtime replication for the existing `events` table.
-- Adds ZERO new tables/columns and does not touch, alter, or delete any existing table, column,
-- or row. Safe to re-run (the Realtime publication statement is wrapped so re-adding an
-- already-subscribed table is a harmless no-op instead of an error) — same pattern as
-- supabase_migration_v3_live_board.sql and supabase_migration_v5_match_organizer_invites.sql.
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.
--
-- Why: `events.organizer_ids`/`organizer_names` are updated the instant a co-organizer invite is
-- accepted (see Cloud.syncEventOrganizersFromInvites in App.jsx), and an owner's title/date/
-- time/location/description edits (see Cloud.updateEvent) are also written here — but until now
-- `events` was never added to the Realtime publication, so every other device only ever picked
-- those changes up via the 10s poll in App()'s sync() effect. That delay made a freshly-accepted
-- co-organizer's full event control (canControlEvent) look stuck/broken rather than just slow to
-- arrive. This migration, paired with Cloud.subscribeEventsChanges in App.jsx, makes both arrive
-- instantly instead.

do $$
begin
  alter publication supabase_realtime add table public.events;
exception when duplicate_object then null;
end $$;
