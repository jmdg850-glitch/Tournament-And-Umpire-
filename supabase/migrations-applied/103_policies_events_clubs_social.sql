-- ============================================================================
-- 103: Events, attendance, clubs, chat, feed — events, event_attendees,
--      clubs, messages, posts
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28).
--
-- Design notes
-- - events.organizer_ids is a jsonb ARRAY of co-organizer ids; the `?`
--   operator tests membership.
-- - Hosts manage other people's attendee rows (approve, assign courts/teams,
--   payment), so event_attendees policies grant the event owner/co-organizers
--   control over all rows of their events via an EXISTS subquery.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- events
-- ----------------------------------------------------------------------------
drop policy if exists "events read"   on public.events;
drop policy if exists "events insert" on public.events;
drop policy if exists "events update" on public.events;
drop policy if exists "events delete" on public.events;

create policy events_select on public.events
  for select to authenticated
  using (true);

create policy events_insert on public.events
  for insert to authenticated
  with check (owner_id = auth.uid()::text or public.is_admin());

create policy events_update on public.events
  for update to authenticated
  using (
    owner_id = auth.uid()::text
    or organizer_ids ? auth.uid()::text
    or public.is_admin()
  )
  with check (
    owner_id = auth.uid()::text
    or organizer_ids ? auth.uid()::text
    or public.is_admin()
  );

create policy events_delete on public.events
  for delete to authenticated
  using (owner_id = auth.uid()::text or public.is_admin());

-- ----------------------------------------------------------------------------
-- event_attendees
-- ----------------------------------------------------------------------------
drop policy if exists "att read"   on public.event_attendees;
drop policy if exists "att insert" on public.event_attendees;
drop policy if exists "att update" on public.event_attendees;
drop policy if exists "att delete" on public.event_attendees;

create policy event_attendees_select on public.event_attendees
  for select to authenticated
  using (true);

-- Join yourself (or your guest "+1", guest_of = you); hosts may add anyone.
create policy event_attendees_insert on public.event_attendees
  for insert to authenticated
  with check (
    user_id = auth.uid()::text
    or guest_of = auth.uid()::text
    or exists (
      select 1 from public.events e
      where e.id = event_id
        and (e.owner_id = auth.uid()::text or e.organizer_ids ? auth.uid()::text)
    )
    or public.is_admin()
  );

create policy event_attendees_update on public.event_attendees
  for update to authenticated
  using (
    user_id = auth.uid()::text
    or guest_of = auth.uid()::text
    or exists (
      select 1 from public.events e
      where e.id = event_id
        and (e.owner_id = auth.uid()::text or e.organizer_ids ? auth.uid()::text)
    )
    or public.is_admin()
  )
  with check (true);

create policy event_attendees_delete on public.event_attendees
  for delete to authenticated
  using (
    user_id = auth.uid()::text
    or guest_of = auth.uid()::text
    or exists (
      select 1 from public.events e
      where e.id = event_id
        and (e.owner_id = auth.uid()::text or e.organizer_ids ? auth.uid()::text)
    )
    or public.is_admin()
  );

-- ----------------------------------------------------------------------------
-- clubs
-- ⚠️  APP CONSTRAINT: the whole club object (members, join requests, chat
--     settings…) lives in clubs.data jsonb, and JOINING a club means a
--     non-owner updating that jsonb. Until membership moves to its own table
--     or an RPC, UPDATE must stay open to authenticated users — this is the
--     weakest policy in the set and is called out in SECURITY.md.
-- ----------------------------------------------------------------------------
drop policy if exists "clubs read"   on public.clubs;
drop policy if exists "clubs insert" on public.clubs;
drop policy if exists "clubs update" on public.clubs;
drop policy if exists "clubs delete" on public.clubs;

create policy clubs_select on public.clubs
  for select to authenticated
  using (true);

create policy clubs_insert on public.clubs
  for insert to authenticated
  with check (coalesce(owner_id, auth.uid()::text) = auth.uid()::text or public.is_admin());

create policy clubs_update on public.clubs
  for update to authenticated
  using (true)          -- see caveat above: members join by writing data jsonb
  with check (true);

create policy clubs_delete on public.clubs
  for delete to authenticated
  using (owner_id = auth.uid()::text or public.is_admin());

-- ----------------------------------------------------------------------------
-- messages (event + club chat; append-only)
-- ----------------------------------------------------------------------------
drop policy if exists "messages read"   on public.messages;
drop policy if exists "messages insert" on public.messages;

create policy messages_select on public.messages
  for select to authenticated
  using (true);

create policy messages_insert on public.messages
  for insert to authenticated
  with check (user_id = auth.uid()::text or public.is_admin());

-- ----------------------------------------------------------------------------
-- posts (social feed)
-- ⚠️  posts.likes is a JSON string that any liker rewrites, so UPDATE cannot
--     be author-only without moving likes to their own table / RPC. Kept open
--     to authenticated; called out in SECURITY.md.
-- ----------------------------------------------------------------------------
drop policy if exists "posts read"   on public.posts;
drop policy if exists "posts insert" on public.posts;
drop policy if exists "posts update" on public.posts;
drop policy if exists "posts delete" on public.posts;

create policy posts_select on public.posts
  for select to authenticated
  using (true);

create policy posts_insert on public.posts
  for insert to authenticated
  with check (author_id = auth.uid()::text or public.is_admin());

create policy posts_update on public.posts
  for update to authenticated
  using (true)          -- see caveat above: likes live on the post row
  with check (true);

create policy posts_delete on public.posts
  for delete to authenticated
  using (author_id = auth.uid()::text or public.is_admin());
