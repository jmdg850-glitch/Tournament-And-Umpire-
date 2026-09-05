-- ============================================================================
-- 140: ensure_my_account() — server-authoritative "resolve or create my own
-- profile row" RPC, callable by any authenticated user.
-- ============================================================================
-- Root cause this closes: accounts rows are created entirely client-side
-- (App.jsx's ensureProfile() -> Cloud.createAccount()), and that path never
-- checked whether the insert actually succeeded — on an accounts.email
-- UNIQUE-constraint conflict (a pre-existing row, e.g. from before this app
-- keyed accounts.id off auth.uid()) it silently kept using an in-memory-only
-- placeholder profile, never persisted. Confirmed live: jmdg840@gmail.com's
-- Supabase Auth session (auth.users.id 903379d3-...) had ~450 rows of real
-- activity (rating_history, match_audit_log, an entire active tournament)
-- attributed to it this past week with ZERO backing accounts row, because
-- its email already belonged to a legacy pre-Auth accounts row
-- (id='1782974982310_fa8p', from 2026-07-02, back when accounts.id was a
-- client-generated Date.now()+random string rather than auth.uid()::text).
--
-- This function is the single, server-side source of truth for "does the
-- caller have a profile row; if not, safely get or create one" — replacing
-- the ad hoc client insert/upsert dance. It's callable both from the browser
-- (src/lib/cloud.js's ensureMyAccount(), used by App.jsx's ensureProfile())
-- and from Edge Functions on behalf of the caller (link-dupr-account's
-- ensureAccountExists(), via a client scoped to the caller's own JWT so
-- auth.uid()/auth.jwt() resolve correctly — a service-role call has no auth
-- context and can't use this function meaningfully).
--
-- Safety: the only "reconciliation" this performs is re-keying an existing
-- accounts row to auth.uid() when that row's email matches the CALLER'S OWN
-- verified JWT email (auth.jwt()->>'email', never client-supplied input) —
-- i.e. it can only ever resolve/take over a row that already carries the
-- exact email Supabase Auth has already verified belongs to this session.
-- It never touches any row whose email doesn't match the caller's own.
-- ============================================================================

create or replace function public.ensure_my_account()
returns public.accounts
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  uid text := auth.uid()::text;
  uemail text := lower(coalesce(auth.jwt()->>'email', ''));
  acct public.accounts;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  select * into acct from public.accounts where id = uid;
  if found then
    return acct;
  end if;

  if uemail = '' then
    raise exception 'no verified email on this session';
  end if;

  -- Re-key a pre-existing row that already owns this exact verified email
  -- (e.g. a legacy pre-Auth-id row) rather than fail on the accounts_email_key
  -- unique constraint. email is UNIQUE, so at most one row can match.
  update public.accounts set id = uid
  where lower(email) = uemail and id <> uid
  returning * into acct;
  if found then
    return acct;
  end if;

  -- Genuinely new profile: create the same placeholder shape the client has
  -- always used (App.jsx's ensureProfile()/Cloud.createAccount() defaults).
  insert into public.accounts (
    id, name, username, email, hand, photo, role, banned,
    singles_rating, doubles_rating, wins, losses, join_date, created_at
  ) values (
    uid, initcap(regexp_replace(split_part(uemail, '@', 1), '[._-]+', ' ', 'g')),
    null, uemail, 'Right', null, 'player', false,
    3, 3, 0, 0, current_date, now()
  )
  on conflict (id) do nothing
  returning * into acct;
  if found then
    return acct;
  end if;

  -- Lost a concurrent-insert race — the row exists now, just re-read it.
  select * into acct from public.accounts where id = uid;
  return acct;
end;
$$;

revoke all on function public.ensure_my_account() from public;
grant execute on function public.ensure_my_account() to authenticated;
