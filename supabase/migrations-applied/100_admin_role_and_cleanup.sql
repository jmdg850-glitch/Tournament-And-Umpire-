-- ============================================================================
-- 100: Admin role infrastructure + policy cleanup
-- ============================================================================
-- STATUS: APPLIED (confirmed live via list_migrations, 2026-07-28).
--
-- ⚠️  DO NOT APPLY until the app changes described in SECURITY.md §"Apply
--     sequence" have shipped. The current client signs some users in WITHOUT a
--     Supabase Auth session (the local admin backdoor and offline-only users),
--     and every policy below assumes auth.uid() is present. Applying early
--     bricks those flows.
--
-- This file must be applied FIRST: later files reference public.is_admin().
-- ============================================================================

-- Admins are real Supabase Auth users listed in this table. This replaces the
-- hardcoded ADMIN_ACCOUNT / ADMIN_PW client-side backdoor.
create table if not exists public.admins (
  user_id text primary key,          -- = auth.uid()::text = accounts.id
  note text,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Nobody reads or writes admins through the API; membership is managed from
-- the dashboard / service role. is_admin() below is SECURITY DEFINER, so it
-- can read the table even though no policy grants API access.
drop policy if exists admins_no_api on public.admins;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.admins where user_id = auth.uid()::text
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Cleanup: live_matches accumulated duplicate policies over time
-- (live_matches_read + live_matches_select, live_matches_insert +
-- live_matches_write). Drop the older aliases; 102 recreates the real set.
-- ----------------------------------------------------------------------------
drop policy if exists live_matches_read  on public.live_matches;
drop policy if exists live_matches_write on public.live_matches;

-- ----------------------------------------------------------------------------
-- Hygiene: the platform event-trigger helper rls_auto_enable() is SECURITY
-- DEFINER and executable by anon/authenticated via PostgREST RPC. It is
-- harmless outside DDL context, but there is no reason to expose it.
--
-- Postgres grants EXECUTE to PUBLIC by default when a function is created, and
-- anon/authenticated inherit that PUBLIC grant regardless of a per-role
-- revoke — confirmed via get_advisors/has_function_privilege after applying
-- this file that the function was STILL callable until PUBLIC itself was
-- revoked. Revoke from PUBLIC explicitly, not just the two named roles.
-- ----------------------------------------------------------------------------
revoke execute on function public.rls_auto_enable() from public;
revoke execute on function public.rls_auto_enable() from anon, authenticated;
