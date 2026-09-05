-- ============================================================================
-- 111: DUPR Partner API integration — additive only.
-- ============================================================================
-- STATUS: APPLIED (2026-07-30, via Supabase MCP). Requires 100 (is_admin)
-- and 102 (is_co_organizer_of) already applied.
--
-- Nothing here alters, drops, or loosens any existing table, column, or
-- policy. See /Users/jm/.claude/plans/... "DUPR Partner API Integration for
-- PickleLive" for the full design and rationale.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- accounts: DUPR identity linkage (own-account flow — src/screens/settings/
-- DuprPanel.jsx). These columns are intentionally NOT added to the existing
-- column-select grant in 101_policies_identity.sql (accounts stays PII-locked;
-- reads go through my_account(), which does `select *` as SECURITY DEFINER
-- and so picks these up automatically — no grant change needed for reads).
-- ----------------------------------------------------------------------------
alter table public.accounts add column if not exists dupr_id text;
alter table public.accounts add column if not exists dupr_full_name text;
alter table public.accounts add column if not exists dupr_status text not null default 'unlinked';
alter table public.accounts add column if not exists dupr_linked_at timestamptz;

-- WRITE protection: accounts_update (101_policies_identity.sql) is a full-row
-- policy — "id = auth.uid() OR is_admin()" — with no column-level distinction,
-- so without this trigger any signed-in user could PATCH their own dupr_id to
-- an arbitrary string and have PickleLive submit real match results to a
-- DUPR account they don't own. The Edge Function (service role) is the only
-- writer allowed to actually change these four columns; a normal
-- authenticated client update silently keeps the previous values instead.
create or replace function public.guard_dupr_account_columns()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if auth.role() is distinct from 'service_role' then
    new.dupr_id := old.dupr_id;
    new.dupr_full_name := old.dupr_full_name;
    new.dupr_status := old.dupr_status;
    new.dupr_linked_at := old.dupr_linked_at;
  end if;
  return new;
end;
$$;

drop trigger if exists guard_dupr_account_columns on public.accounts;
create trigger guard_dupr_account_columns
  before update on public.accounts
  for each row
  execute function public.guard_dupr_account_columns();

-- ----------------------------------------------------------------------------
-- mixmatch_players: DUPR id for guest/manual/imported roster rows that have
-- no PickleLive account of their own (src/modals/PlayerEditPanel.jsx).
-- mixmatch_players already has fully permissive `using(true)` RLS on every
-- verb, predating this feature (01_mixmatch_core.sql) — that pre-existing
-- looseness is out of scope to tighten here (see plan doc). Practically, a
-- submission still requires being the match's own organizer/co-organizer
-- (enforced in the Edge Function's authorizeMatch check), which bounds who
-- can act on a given roster row's dupr_id day-to-day even though the column
-- itself isn't independently RLS-protected.
-- ----------------------------------------------------------------------------
alter table public.mixmatch_players add column if not exists dupr_id text;

-- ----------------------------------------------------------------------------
-- dupr_match_submissions: one row per match, upserted as a state machine —
-- gives idempotency "for free" (a PK violation can't happen twice for the
-- same match). SELECT-only for clients; every write goes through the
-- submit-match Edge Function's service-role key, same convention already
-- documented on `matches` ("admin corrections go through the service role",
-- 102_policies_matches_live.sql).
-- ----------------------------------------------------------------------------
create table if not exists public.dupr_match_submissions (
  match_id text primary key references public.matches(id) on delete cascade,
  identifier text not null unique,
  organizer_id text not null,
  status text not null default 'pending'
    check (status in ('pending','submitting','submitted','failed','skipped')),
  dupr_match_code text,
  dupr_hashed_match_code text,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz,
  last_error text,
  next_retry_at timestamptz,
  request_payload jsonb,
  response_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists dupr_match_submissions_organizer_idx
  on public.dupr_match_submissions (organizer_id);

alter table public.dupr_match_submissions enable row level security;

drop policy if exists dupr_match_submissions_select on public.dupr_match_submissions;
create policy dupr_match_submissions_select on public.dupr_match_submissions
  for select to authenticated
  using (
    organizer_id = auth.uid()::text
    or public.is_co_organizer_of(organizer_id)
    or public.is_admin()
  );
-- Deliberately no insert/update/delete policy for `authenticated` — see
-- header. Only the service-role key (bypasses RLS) writes this table.

-- ----------------------------------------------------------------------------
-- dupr_auth_cache: server-side-only Bearer token cache (singleton row).
-- RLS enabled with ZERO policies granted to anon/authenticated = invisible to
-- every JWT-authenticated request; reachable only via the service-role key
-- inside the Edge Function.
-- ----------------------------------------------------------------------------
create table if not exists public.dupr_auth_cache (
  id text primary key default 'singleton',
  access_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.dupr_auth_cache enable row level security;

-- ----------------------------------------------------------------------------
-- dupr_webhook_events: raw landing table for DUPR webhook payloads. v1 only
-- logs — the payload shape/signature scheme is unverified until real
-- credentials exist (see plan doc), so nothing here acts on the payload yet.
-- ----------------------------------------------------------------------------
create table if not exists public.dupr_webhook_events (
  id text primary key,
  topic text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  processed boolean not null default false
);
alter table public.dupr_webhook_events enable row level security;

drop policy if exists dupr_webhook_events_select on public.dupr_webhook_events;
create policy dupr_webhook_events_select on public.dupr_webhook_events
  for select to authenticated
  using (public.is_admin());
-- Insert only via the service-role webhook receiver — no insert policy for
-- authenticated/anon.

-- ----------------------------------------------------------------------------
-- rating_config: per-organizer auto-submit opt-in. Existing RLS
-- (organizer/co-organizer/admin-scoped, 102_policies_matches_live.sql)
-- already covers these new columns correctly — no policy change needed.
-- ----------------------------------------------------------------------------
alter table public.rating_config add column if not exists dupr_auto_submit boolean not null default false;
alter table public.rating_config add column if not exists dupr_match_source text not null default 'PARTNER';
