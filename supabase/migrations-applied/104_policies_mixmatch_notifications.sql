-- ============================================================================
-- 104: Organizer roster tables + notifications — mixmatch_players,
--      mixmatch_categories, mixmatch_teams, mixmatch_category_players,
--      notifications
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28). Requires 100 (is_admin) AND 102
-- (is_co_organizer_of) — apply strictly after both.
--
-- Co-organizer writes: a co-organizer running the owner's event reads AND
-- WRITES the owner's roster directly (rosterOwnerId in App.jsx). Writes below
-- allow owner, admin, or an accepted co-organizer via is_co_organizer_of()
-- (defined in 102), so this keeps working under the tightened policies.
-- ============================================================================

-- Helper macro pattern for the four organizer-scoped roster tables.
-- (Kept explicit per table for reviewability.)
--
-- Co-organizer writes (rosterOwnerId in App.jsx) are allowed via
-- is_co_organizer_of() (defined in 102_policies_matches_live.sql, which must
-- apply before this file) — an accepted organizer invite on an event owned by
-- organizer_id grants the same write access as the owner.

-- mixmatch_players ----------------------------------------------------------
drop policy if exists mixmatch_players_select on public.mixmatch_players;
drop policy if exists mixmatch_players_insert on public.mixmatch_players;
drop policy if exists mixmatch_players_update on public.mixmatch_players;
drop policy if exists mixmatch_players_delete on public.mixmatch_players;

create policy mixmatch_players_select on public.mixmatch_players
  for select to authenticated using (true);
create policy mixmatch_players_insert on public.mixmatch_players
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
create policy mixmatch_players_update on public.mixmatch_players
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));
create policy mixmatch_players_delete on public.mixmatch_players
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- mixmatch_categories -------------------------------------------------------
drop policy if exists mixmatch_categories_select on public.mixmatch_categories;
drop policy if exists mixmatch_categories_insert on public.mixmatch_categories;
drop policy if exists mixmatch_categories_update on public.mixmatch_categories;
drop policy if exists mixmatch_categories_delete on public.mixmatch_categories;

create policy mixmatch_categories_select on public.mixmatch_categories
  for select to authenticated using (true);
create policy mixmatch_categories_insert on public.mixmatch_categories
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
create policy mixmatch_categories_update on public.mixmatch_categories
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));
create policy mixmatch_categories_delete on public.mixmatch_categories
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- mixmatch_teams ------------------------------------------------------------
drop policy if exists mixmatch_teams_select on public.mixmatch_teams;
drop policy if exists mixmatch_teams_insert on public.mixmatch_teams;
drop policy if exists mixmatch_teams_update on public.mixmatch_teams;
drop policy if exists mixmatch_teams_delete on public.mixmatch_teams;

create policy mixmatch_teams_select on public.mixmatch_teams
  for select to authenticated using (true);
create policy mixmatch_teams_insert on public.mixmatch_teams
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
create policy mixmatch_teams_update on public.mixmatch_teams
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));
create policy mixmatch_teams_delete on public.mixmatch_teams
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- mixmatch_category_players -------------------------------------------------
drop policy if exists mixmatch_category_players_select on public.mixmatch_category_players;
drop policy if exists mixmatch_category_players_insert on public.mixmatch_category_players;
drop policy if exists mixmatch_category_players_update on public.mixmatch_category_players;
drop policy if exists mixmatch_category_players_delete on public.mixmatch_category_players;

create policy mixmatch_category_players_select on public.mixmatch_category_players
  for select to authenticated using (true);
create policy mixmatch_category_players_insert on public.mixmatch_category_players
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
create policy mixmatch_category_players_update on public.mixmatch_category_players
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));
create policy mixmatch_category_players_delete on public.mixmatch_category_players
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- ----------------------------------------------------------------------------
-- notifications
-- Senders create notifications FOR recipients (actor_id = sender), recipients
-- read/mark-read/delete their own inbox. Today SELECT `true` lets anyone read
-- anyone's inbox — this closes that.
-- ----------------------------------------------------------------------------
drop policy if exists notifications_select on public.notifications;
drop policy if exists notifications_insert on public.notifications;
drop policy if exists notifications_update on public.notifications;
drop policy if exists notifications_delete on public.notifications;

create policy notifications_select on public.notifications
  for select to authenticated
  using (user_id = auth.uid()::text or public.is_admin());

create policy notifications_insert on public.notifications
  for insert to authenticated
  with check (coalesce(actor_id, auth.uid()::text) = auth.uid()::text or public.is_admin());

create policy notifications_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid()::text or public.is_admin())
  with check (user_id = auth.uid()::text or public.is_admin());

create policy notifications_delete on public.notifications
  for delete to authenticated
  using (user_id = auth.uid()::text or public.is_admin());
