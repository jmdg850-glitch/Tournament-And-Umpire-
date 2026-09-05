-- SUPERSEDED (2026-07-28): the permissive using(true) policies below were replaced by
-- 102_policies_matches_live.sql's organizer-scoped policies, confirmed live via list_migrations
-- + a direct pg_policies query. Kept here only as a historical record of live_matches' first RLS
-- pass — do not re-apply this file, it would reopen the write hole 102/105/106 closed.
--
-- Live Matches RLS — defines explicit row-level-security policies for the `live_matches` table.
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.
--
-- Why: `live_matches` predates version-controlled migrations (it was created by hand, along with
-- matches/events/accounts/players/friend_requests, before this migration history started — see
-- supabase_migration_v3_live_board.sql, which only ever added it to the Realtime publication and
-- never defined its policies). No migration anywhere has ever granted it a DELETE policy. Since
-- Supabase does not throw when RLS silently filters a DELETE down to zero affected rows, this can
-- make a match look deleted on the organizer's own device (local state is optimistic) while the
-- row is actually still live in the database — which is exactly what every OTHER connected device
-- keeps seeing via Cloud.fetchLiveMatches()/the Realtime board as a still-"LIVE" match. Explicitly
-- granting select/insert/update/delete here (matching the same permissive `using(true)` shape
-- already used by every other roster/session table in this app — courts, mixmatch_players,
-- rating_history, etc.) is what actually lets a deleted/cancelled/held/ended match's row disappear
-- for good.
--
-- Unlike v7/v3 (which pair `create policy` with `create table if not exists` on a brand-new
-- table, so a first-time `create policy` can never collide), `live_matches` already exists with
-- an unverified/unknown current policy set — so this migration uses `drop policy if exists` +
-- `create policy` instead of assuming a clean slate, and is safe to re-run any number of times.

alter table public.live_matches enable row level security; -- no-op if already enabled

drop policy if exists "live_matches_select" on public.live_matches;
drop policy if exists "live_matches_insert" on public.live_matches;
drop policy if exists "live_matches_update" on public.live_matches;
drop policy if exists "live_matches_delete" on public.live_matches;

create policy "live_matches_select" on public.live_matches for select using (true);
create policy "live_matches_insert" on public.live_matches for insert with check (true);
create policy "live_matches_update" on public.live_matches for update using (true);
create policy "live_matches_delete" on public.live_matches for delete using (true);

-- Diagnostic — run this before AND after applying the policies above to confirm the fix:
--   1. Is `live_matches` actually in the Realtime publication? (also checks `events`/`live_sessions`
--      in case supabase_migration_v8_events_realtime.sql / v3_live_board.sql were never run either)
--   2. Is RLS even enabled on `live_matches`?
--   3. What policies currently exist on `live_matches`, and for which commands?
--
-- select schemaname, tablename from pg_publication_tables
-- where pubname='supabase_realtime' and tablename in ('events','live_matches','live_sessions');
--
-- select relname, relrowsecurity, relforcerowsecurity from pg_class where relname='live_matches';
--
-- select polname, cmd, permissive, qual, with_check from pg_policies
-- where schemaname='public' and tablename='live_matches';
