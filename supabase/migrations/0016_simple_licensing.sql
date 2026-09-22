-- 0016_simple_licensing.sql
-- Replaces the (empty, never-used) 0015 licensing tables with the simple model:
--
--     ONE customer email  ->  ONE access code  ->  ONE PC
--
-- 0015 is kept as history (migrations are append-only). It is superseded here:
-- its events/devices/settings tables, RPCs and triggers are dropped. Only
-- public.license_admins (who may use License Admin) is kept.
--
-- All access is through the `license` Edge Function with the service role.
-- Clients (anon/authenticated) get no table access at all.

drop function if exists public.license_commit(jsonb);
drop function if exists public.license_touch_device(uuid);
drop table if exists public.license_events cascade;
drop table if exists public.license_devices cascade;
drop table if exists public.license_settings cascade;
drop table if exists public.licenses cascade;
drop function if exists private.licenses_guard();
drop function if exists private.license_devices_limit();
drop function if exists private.license_events_immutable();

create table public.licenses (
  id uuid primary key default gen_random_uuid(),
  -- Customer email, always stored lowercase. The customer must be signed in
  -- with this exact (verified) email to activate.
  email text not null check (email = lower(email) and char_length(email) between 3 and 254),
  -- XXXX-XXXX-XXXX from a 30-symbol alphabet (no 0/1/I/L/O/U). Server-only:
  -- no client can read this table.
  access_code text not null unique
    check (access_code ~ '^[2-9A-HJKMNP-TV-Z]{4}(-[2-9A-HJKMNP-TV-Z]{4}){2}$'),
  status text not null default 'unused' check (status in ('unused', 'active', 'revoked')),
  expires_at timestamptz,
  -- The PC this license is bound to (set by the first successful activation).
  device_id text,
  device_label text,
  activated_at timestamptz,
  activated_user_id uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- unused <=> no PC bound; active <=> a PC is bound; revoked keeps its history.
  constraint licenses_binding_matches_status
    check (status = 'revoked' or ((status = 'active') = (device_id is not null)))
);

-- ONE email -> ONE license. A revoked license does not block issuing a new one.
create unique index licenses_one_live_per_email
  on public.licenses (email) where status <> 'revoked';

create index licenses_created_idx on public.licenses (created_at desc);

alter table public.licenses enable row level security;
alter table public.licenses force row level security;
revoke all on public.licenses from anon, authenticated;
-- No policies: deny by default. license_admins already has the same posture.
