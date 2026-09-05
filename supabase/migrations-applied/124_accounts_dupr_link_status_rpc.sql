-- STATUS: APPLIED (version 20260806073851, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 124: accounts_dupr_status RPC — for the Sync Center's "players missing DUPR
--      ID" check.
-- ============================================================================
-- accounts.dupr_id/dupr_status are NOT in the column-level SELECT grant added
-- by 101_policies_identity.sql (`grant select (id, name, username, photo,
-- hand, country, role, banned, singles_rating, doubles_rating, wins, losses,
-- join_date, created_at) on public.accounts to authenticated`) — a direct
-- `.from("accounts").select("dupr_id")` is rejected outright by that grant for
-- ANY row, including the caller's own (my_account() is the only existing
-- reader, and it's single-row/caller-only by design).
--
-- The Sync Center needs to know, for an arbitrary list of OTHER players'
-- account ids, whether each one has linked DUPR at all — not their actual
-- dupr_id/status/full name. Rather than widening the column grant (a bigger
-- exposure than this feature needs, and a security-policy change nobody
-- asked for), this adds one narrow SECURITY DEFINER RPC that answers only
-- that single boolean fact, same shape as is_co_organizer_of/toggle_post_like
-- already used elsewhere in this schema for exactly this kind of exception.
-- ============================================================================

create or replace function public.accounts_dupr_status(account_ids text[])
returns table(account_id text, has_dupr_id boolean)
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select id, (dupr_id is not null) from public.accounts where id = any(account_ids);
$$;

revoke all on function public.accounts_dupr_status(text[]) from public;
grant execute on function public.accounts_dupr_status(text[]) to authenticated;
