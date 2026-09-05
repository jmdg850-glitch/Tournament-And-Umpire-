-- ============================================================================
-- 102: Match + live-play tables — matches, live_matches, live_sessions,
--      courts, rating_config, rating_history
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28).
--
-- Design notes
-- - The public Live Board is a spectator feature: anyone (including signed-out
--   viewers) can watch scores. SELECT therefore stays public on live_matches
--   and live_sessions. Writes become organizer-scoped.
-- - live_matches ownership lives INSIDE data jsonb (data->>'organizerId' plus
--   data->'organizerIds' for co-organizers accepted via invites). Policies
--   read it from there; legacy rows with no organizerId fall back to
--   authenticated-only writes (matches the client's fail-open behavior for
--   legacy matches — see canControlMatch).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- matches: append-only history of completed matches.
-- ----------------------------------------------------------------------------
drop policy if exists "matches read"   on public.matches;
drop policy if exists "matches insert" on public.matches;
drop policy if exists "matches update" on public.matches;

create policy matches_select on public.matches
  for select to authenticated
  using (true);

create policy matches_insert on public.matches
  for insert to authenticated
  with check (true);

-- Deliberately NO update/delete policies: match history is an audit log.
-- (Admin corrections go through the service role.)

-- ----------------------------------------------------------------------------
-- live_matches: in-progress scoreboards. Public spectate, organizer writes.
-- ----------------------------------------------------------------------------
drop policy if exists live_matches_select on public.live_matches;
drop policy if exists live_matches_insert on public.live_matches;
drop policy if exists live_matches_update on public.live_matches;
drop policy if exists live_matches_delete on public.live_matches;

create policy live_matches_select on public.live_matches
  for select
  using (true);  -- public live board

create policy live_matches_insert on public.live_matches
  for insert to authenticated
  with check (
    coalesce(data->>'organizerId', auth.uid()::text) = auth.uid()::text
    or public.is_admin()
  );

create policy live_matches_update on public.live_matches
  for update to authenticated
  using (
    data->>'organizerId' is null                       -- legacy rows: fail open
    or data->>'organizerId' = auth.uid()::text
    or data->'organizerIds' ? auth.uid()::text          -- accepted co-organizers
    or public.is_admin()
  )
  with check (true);

create policy live_matches_delete on public.live_matches
  for delete to authenticated
  using (
    data->>'organizerId' is null
    or data->>'organizerId' = auth.uid()::text
    or data->'organizerIds' ? auth.uid()::text
    or public.is_admin()
  );

-- ----------------------------------------------------------------------------
-- Co-organizer write helper: true when the caller has an accepted organizer
-- invite on an event owned by `owner_id`. events.organizer_ids is kept live in
-- sync with accepted match_organizer_invites (syncEventOrganizersFromInvites),
-- so this re-derives authorization from data the app already maintains for
-- exactly this purpose — no new table or RPC needed. Used below by
-- live_sessions/courts/rating_config (this file) and the mixmatch roster
-- tables (104), all of which the client writes via App.jsx's rosterOwnerId
-- whenever a co-organizer is working inside an event they don't own.
-- ----------------------------------------------------------------------------
create or replace function public.is_co_organizer_of(owner_id text)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.events e
    where e.owner_id = is_co_organizer_of.owner_id
      and e.organizer_ids ? auth.uid()::text
  );
$$;
grant execute on function public.is_co_organizer_of(text) to authenticated;

-- ----------------------------------------------------------------------------
-- live_sessions: one row per organizer (PK organizer_id). Public spectate.
-- ----------------------------------------------------------------------------
drop policy if exists live_sessions_select on public.live_sessions;
drop policy if exists live_sessions_insert on public.live_sessions;
drop policy if exists live_sessions_update on public.live_sessions;
drop policy if exists live_sessions_delete on public.live_sessions;

create policy live_sessions_select on public.live_sessions
  for select
  using (true);  -- public live board

create policy live_sessions_insert on public.live_sessions
  for insert to authenticated
  with check (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
  );

create policy live_sessions_update on public.live_sessions
  for update to authenticated
  using (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
  )
  with check (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
  );

create policy live_sessions_delete on public.live_sessions
  for delete to authenticated
  using (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_co_organizer_of(organizer_id)
  );

-- ----------------------------------------------------------------------------
-- courts / rating_config / rating_history: organizer-scoped resources.
-- Co-organizer writes (rosterOwnerId in App.jsx) are allowed via
-- is_co_organizer_of() above — an accepted organizer invite on an event owned
-- by organizer_id grants the same write access as the owner.
-- ----------------------------------------------------------------------------
drop policy if exists courts_select on public.courts;
drop policy if exists courts_insert on public.courts;
drop policy if exists courts_update on public.courts;
drop policy if exists courts_delete on public.courts;

create policy courts_select on public.courts
  for select to authenticated using (true);
create policy courts_insert on public.courts
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
create policy courts_update on public.courts
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));
create policy courts_delete on public.courts
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

drop policy if exists rating_config_select on public.rating_config;
drop policy if exists rating_config_insert on public.rating_config;
drop policy if exists rating_config_update on public.rating_config;
drop policy if exists rating_config_delete on public.rating_config;

create policy rating_config_select on public.rating_config
  for select to authenticated using (true);
create policy rating_config_insert on public.rating_config
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
create policy rating_config_update on public.rating_config
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));
create policy rating_config_delete on public.rating_config
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

drop policy if exists rating_history_select on public.rating_history;
drop policy if exists rating_history_insert on public.rating_history;
drop policy if exists rating_history_update on public.rating_history;
drop policy if exists rating_history_delete on public.rating_history;

create policy rating_history_select on public.rating_history
  for select to authenticated using (true);
-- endMatch on the organizer's device writes history rows for every player in
-- the match, so INSERT is keyed to the recording organizer, not the player.
create policy rating_history_insert on public.rating_history
  for insert to authenticated
  with check (coalesce(organizer_id, auth.uid()::text) = auth.uid()::text or public.is_admin());
-- Append-only: no update, no delete (admin corrections via service role).
