-- ============================================================================
-- 101: Identity tables — accounts, players, friend_requests
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28). Requires 100 (is_admin) and the app changes
-- in SECURITY.md §"Apply sequence".
--
-- Verified current state (2026-07-25, via pg_policies):
--   accounts:        SELECT/INSERT/UPDATE all `true`; NO DELETE policy at all
--                    (Cloud.deleteAccount currently deletes 0 rows silently).
--   players:         SELECT/INSERT/UPDATE all `true`; NO DELETE policy.
--   friend_requests: SELECT/INSERT/UPDATE/DELETE all `true`.
--   accounts.password_hash: legacy pre-Supabase-Auth column; 2 of 6 rows still
--                    hold hashes, world-readable today.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- accounts (PII: email, phone, address, age, sex)
-- App usage: profile mirror keyed by auth.uid(); read at login by email /
-- username, upserted on signup, updated from profile screens.
--
-- ⚠️  APP CHANGE REQUIRED before applying: username login resolves
--     username -> email BEFORE any session exists (Cloud.findAccountByUsername).
--     Owner-only SELECT breaks that. Ship the resolve_login() RPC below and
--     switch LoginScreen to it first.
-- ----------------------------------------------------------------------------

-- Destructive but necessary: remove legacy password hashes from the API surface
-- entirely. Supabase Auth owns credentials; nothing in the app reads this.
alter table public.accounts drop column if exists password_hash;

drop policy if exists "accounts read"   on public.accounts;
drop policy if exists "accounts insert" on public.accounts;
drop policy if exists "accounts update" on public.accounts;

-- Signed-in users may read profiles (names/photos/ratings power the directory,
-- friends and leaderboards). Anonymous readers get nothing. Column-level
-- protection for PII (email/phone/address/age/sex) is delivered by the
-- public_profiles view below — point directory reads at the view.
create policy accounts_select on public.accounts
  for select to authenticated
  using (true);

create policy accounts_insert on public.accounts
  for insert to authenticated
  with check (id = auth.uid()::text);

create policy accounts_update on public.accounts
  for update to authenticated
  using (id = auth.uid()::text or public.is_admin())
  with check (id = auth.uid()::text or public.is_admin());

-- New: owners (and admins) can actually delete their account row.
create policy accounts_delete on public.accounts
  for delete to authenticated
  using (id = auth.uid()::text or public.is_admin());

-- PII-free projection for directory/leaderboard style reads.
create or replace view public.public_profiles as
  select id, name, username, photo, hand, country, role, banned,
         singles_rating, doubles_rating, wins, losses, join_date, created_at
  from public.accounts;

-- Views run with the invoker's rights under RLS when security_invoker is on.
alter view public.public_profiles set (security_invoker = on);
grant select on public.public_profiles to authenticated;

-- ----------------------------------------------------------------------------
-- Column-level PII lockdown on accounts itself.
--
-- accounts_select (above) is `USING (true) TO authenticated` so the directory/
-- leaderboard/friends features can see every profile — but RLS is a ROW
-- filter, not a column filter. Without this, any authenticated user could
-- bypass public_profiles entirely and query
-- `/rest/v1/accounts?select=email,phone,address,age,sex` directly, reading
-- every user's PII. Revoke table-level SELECT and re-grant only the same
-- PII-free column list public_profiles already exposes, so a direct accounts
-- query can no longer return email/phone/address/age/sex for ANY row,
-- including the caller's own.
-- ----------------------------------------------------------------------------
revoke select on public.accounts from authenticated;
grant select (id, name, username, photo, hand, country, role, banned,
              singles_rating, doubles_rating, wins, losses, join_date, created_at)
  on public.accounts to authenticated;
-- INSERT/UPDATE/DELETE are row-level policies, not column grants, and are
-- unaffected by the above — a user can still write their own full row
-- (including PII columns) via accounts_insert/accounts_update.

-- Callers can no longer read their own PII columns via a direct accounts
-- select (see column revoke above) — this RPC is the replacement: full row,
-- including PII, but only ever the caller's own.
create or replace function public.my_account()
returns public.accounts
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select * from public.accounts where id = auth.uid()::text;
$$;
revoke all on function public.my_account() from public;
grant execute on function public.my_account() to authenticated;

-- Username -> email resolution for the login screen (pre-session).
-- SECURITY DEFINER so it works for anon, but it only answers the exact
-- question the login flow needs and never exposes rows.
create or replace function public.resolve_login(identifier text)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select email from public.accounts
  where lower(username) = lower(identifier) or lower(email) = lower(identifier)
  limit 1;
$$;
revoke all on function public.resolve_login(text) from public;
grant execute on function public.resolve_login(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- players (public directory mirror; id = auth.uid() of the registered user)
-- ----------------------------------------------------------------------------
drop policy if exists "players read"   on public.players;
drop policy if exists "players insert" on public.players;
drop policy if exists "players update" on public.players;

create policy players_select on public.players
  for select to authenticated
  using (true);

create policy players_insert on public.players
  for insert to authenticated
  with check (id = auth.uid()::text);

create policy players_update on public.players
  for update to authenticated
  using (id = auth.uid()::text or public.is_admin())
  with check (id = auth.uid()::text or public.is_admin());

create policy players_delete on public.players
  for delete to authenticated
  using (id = auth.uid()::text or public.is_admin());

-- ----------------------------------------------------------------------------
-- friend_requests (two-party rows: from_id, to_id)
-- ----------------------------------------------------------------------------
drop policy if exists "reqs read"   on public.friend_requests;
drop policy if exists "reqs insert" on public.friend_requests;
drop policy if exists "reqs update" on public.friend_requests;
drop policy if exists "reqs delete" on public.friend_requests;

create policy friend_requests_select on public.friend_requests
  for select to authenticated
  using (from_id = auth.uid()::text or to_id = auth.uid()::text);

create policy friend_requests_insert on public.friend_requests
  for insert to authenticated
  with check (from_id = auth.uid()::text);

-- Recipient accepts/declines; sender may cancel.
create policy friend_requests_update on public.friend_requests
  for update to authenticated
  using (from_id = auth.uid()::text or to_id = auth.uid()::text)
  with check (from_id = auth.uid()::text or to_id = auth.uid()::text);

create policy friend_requests_delete on public.friend_requests
  for delete to authenticated
  using (from_id = auth.uid()::text or to_id = auth.uid()::text);
