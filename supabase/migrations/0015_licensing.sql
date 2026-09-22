-- 0015_licensing.sql
-- Commercial licensing for the Tournament Operator and Umpire apps.
--
-- Additive only: creates new tables/functions, touches no existing table.
-- All license state is written by the `license` Edge Function using the
-- service role. Clients (anon/authenticated) never write, and can read only
-- a narrow, non-secret slice of their OWN license and device rows.
--
-- The decision logic (key format, lifecycle, device limits) lives in
-- packages/license/src/core.js. This file enforces the same invariants at the
-- database level as a backstop (state-machine trigger, device-limit trigger,
-- partial unique indexes, append-only event log).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.license_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create table if not exists public.licenses (
  id uuid primary key default gen_random_uuid(),
  -- HMAC-SHA256(canonical key, server pepper), lowercase hex. Lookup only.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  -- AES-GCM ciphertext (server secret) so an admin can re-reveal the key.
  key_ciphertext text not null,
  -- Last 4 characters of the key, for masked display in lists.
  key_hint text not null check (char_length(key_hint) = 4),
  status text not null default 'unused'
    check (status in ('unused', 'active', 'expired', 'revoked')),
  customer_name text not null default '',
  customer_email text,
  owner_user_id uuid references auth.users(id) on delete set null,
  plan text not null default 'Tournament Pro',
  device_limit integer not null default 3 check (device_limit between 1 and 50),
  expires_at timestamptz,
  notes text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text,
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists licenses_status_idx on public.licenses (status);
create index if not exists licenses_owner_idx on public.licenses (owner_user_id);
create index if not exists licenses_email_idx on public.licenses (lower(customer_email));
create index if not exists licenses_created_idx on public.licenses (created_at desc);

-- A user may hold at most one ACTIVE license at a time.
create unique index if not exists licenses_one_active_per_owner
  on public.licenses (owner_user_id)
  where status = 'active' and owner_user_id is not null;

create table if not exists public.license_devices (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  device_id text not null check (char_length(device_id) between 8 and 128),
  app_type text not null check (app_type in ('operator', 'umpire')),
  platform text not null check (platform in ('windows', 'android', 'web', 'other')),
  device_label text not null default '',
  activated_at timestamptz not null default now(),
  deactivated_at timestamptz,
  last_seen_at timestamptz not null default now()
);

create index if not exists license_devices_license_idx on public.license_devices (license_id);
create index if not exists license_devices_user_idx on public.license_devices (user_id);

-- The same installation can hold only one live slot per app on a license.
create unique index if not exists license_devices_one_live_slot
  on public.license_devices (license_id, device_id, app_type)
  where deactivated_at is null;

create table if not exists public.license_events (
  id uuid primary key default gen_random_uuid(),
  license_id uuid references public.licenses(id) on delete set null,
  actor_id uuid,
  actor_kind text not null default 'system'
    check (actor_kind in ('admin', 'customer', 'system')),
  event_type text not null check (event_type in (
    'LICENSE_CREATED', 'LICENSE_ACTIVATED', 'DEVICE_REGISTERED', 'DEVICE_RELEASED',
    'LICENSE_REVOKED', 'LICENSE_REACTIVATED', 'LICENSE_EXPIRED', 'LICENSE_UPDATED',
    'LICENSE_REVEALED', 'ACTIVATION_FAILED', 'SETTINGS_UPDATED', 'ADMIN_LOGIN'
  )),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists license_events_license_idx on public.license_events (license_id, created_at desc);
create index if not exists license_events_created_idx on public.license_events (created_at desc);
create index if not exists license_events_actor_idx on public.license_events (actor_id, event_type, created_at desc);

create table if not exists public.license_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

-- Enforcement is OFF until the owner turns it on from License Admin.
insert into public.license_settings (key, value)
values ('enforcement', 'false'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Database-level invariants (backstop for packages/license/src/core.js)
-- ---------------------------------------------------------------------------

-- Lifecycle guard: legal status transitions, immutable key hash, owner cannot
-- be reassigned once set, version/updated_at maintained.
create or replace function private.licenses_guard()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if new.key_hash is distinct from old.key_hash then
    raise exception 'license key hash is immutable' using errcode = 'LV001';
  end if;

  if old.owner_user_id is not null
     and new.owner_user_id is not null
     and new.owner_user_id is distinct from old.owner_user_id then
    raise exception 'license ownership cannot be reassigned' using errcode = 'LV002';
  end if;

  if new.status is distinct from old.status then
    if not (
      (old.status = 'unused'  and new.status in ('active', 'revoked', 'expired')) or
      (old.status = 'active'  and new.status in ('expired', 'revoked')) or
      (old.status = 'expired' and new.status in ('active', 'unused', 'revoked')) or
      (old.status = 'revoked' and new.status in ('active', 'unused'))
    ) then
      raise exception 'illegal license status transition % -> %', old.status, new.status
        using errcode = 'LV003';
    end if;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists licenses_guard on public.licenses;
create trigger licenses_guard
  before update on public.licenses
  for each row execute function private.licenses_guard();

-- Device-limit backstop: serialises on the license row and refuses a live slot
-- beyond the license's device_limit.
create or replace function private.license_devices_limit()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
declare
  v_limit integer;
  v_used integer;
begin
  if new.deactivated_at is not null then
    return new;
  end if;

  select device_limit into v_limit from public.licenses where id = new.license_id for update;
  if v_limit is null then
    raise exception 'license not found' using errcode = 'LV004';
  end if;

  select count(*) into v_used
    from public.license_devices
   where license_id = new.license_id and deactivated_at is null;

  if v_used >= v_limit then
    raise exception 'device limit reached' using errcode = 'LV005';
  end if;
  return new;
end;
$$;

drop trigger if exists license_devices_limit on public.license_devices;
create trigger license_devices_limit
  before insert on public.license_devices
  for each row execute function private.license_devices_limit();

-- The audit log is append-only. Only the database owner (maintenance / test
-- cleanup) may change it; the service role used by the Edge Function cannot.
create or replace function private.license_events_immutable()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if current_user in ('postgres', 'supabase_admin') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'license_events is append-only' using errcode = 'LV006';
end;
$$;

drop trigger if exists license_events_immutable on public.license_events;
create trigger license_events_immutable
  before update or delete on public.license_events
  for each row execute function private.license_events_immutable();

-- ---------------------------------------------------------------------------
-- Transactional writers (service_role only)
-- ---------------------------------------------------------------------------

-- Applies a license change, device changes and audit events in ONE transaction.
-- Optimistic concurrency: the caller passes the license `version` it decided
-- against; a mismatch raises LV409 and the Edge Function re-reads and retries.
--
-- p = {
--   license_id, expected_version,
--   patch:   { <any of the whitelisted license columns> }   -- present keys only
--   device_insert:  { user_id, device_id, app_type, platform, device_label }
--   device_release: { device_row_id }
--   events:  [ { event_type, actor_id, actor_kind, metadata } ]
-- }
create or replace function public.license_commit(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_id uuid := (p->>'license_id')::uuid;
  v_expected integer := (p->>'expected_version')::integer;
  v_patch jsonb := coalesce(p->'patch', '{}'::jsonb);
  v_current integer;
  v_new_version integer;
  v_ev jsonb;
  v_dev uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'license_commit is restricted to service_role' using errcode = '42501';
  end if;

  select version into v_current from public.licenses where id = v_id for update;
  if v_current is null then
    raise exception 'license not found' using errcode = 'LV004';
  end if;
  if v_expected is null or v_current <> v_expected then
    raise exception 'license version conflict' using errcode = 'LV409';
  end if;

  if v_patch <> '{}'::jsonb then
    update public.licenses set
      status         = case when v_patch ? 'status'         then v_patch->>'status'                        else status end,
      owner_user_id  = case when v_patch ? 'owner_user_id'  then (v_patch->>'owner_user_id')::uuid         else owner_user_id end,
      activated_at   = case when v_patch ? 'activated_at'   then (v_patch->>'activated_at')::timestamptz   else activated_at end,
      revoked_at     = case when v_patch ? 'revoked_at'     then (v_patch->>'revoked_at')::timestamptz     else revoked_at end,
      revoked_reason = case when v_patch ? 'revoked_reason' then v_patch->>'revoked_reason'                else revoked_reason end,
      expires_at     = case when v_patch ? 'expires_at'     then (v_patch->>'expires_at')::timestamptz     else expires_at end,
      device_limit   = case when v_patch ? 'device_limit'   then (v_patch->>'device_limit')::integer       else device_limit end,
      customer_name  = case when v_patch ? 'customer_name'  then v_patch->>'customer_name'                 else customer_name end,
      customer_email = case when v_patch ? 'customer_email' then v_patch->>'customer_email'                else customer_email end,
      plan           = case when v_patch ? 'plan'           then v_patch->>'plan'                          else plan end,
      notes          = case when v_patch ? 'notes'          then v_patch->>'notes'                         else notes end
    where id = v_id;
  else
    -- No column change, but the caller's decision still consumed this version.
    update public.licenses set updated_at = now() where id = v_id;
  end if;

  if p ? 'device_release' then
    v_dev := (p->'device_release'->>'device_row_id')::uuid;
    update public.license_devices
       set deactivated_at = now()
     where id = v_dev and license_id = v_id and deactivated_at is null;
    if not found then
      raise exception 'device not found or already released' using errcode = 'LV007';
    end if;
  end if;

  if p ? 'device_insert' then
    insert into public.license_devices (license_id, user_id, device_id, app_type, platform, device_label)
    values (
      v_id,
      nullif(p->'device_insert'->>'user_id', '')::uuid,
      p->'device_insert'->>'device_id',
      p->'device_insert'->>'app_type',
      p->'device_insert'->>'platform',
      coalesce(p->'device_insert'->>'device_label', '')
    );
  end if;

  for v_ev in select * from jsonb_array_elements(coalesce(p->'events', '[]'::jsonb)) loop
    insert into public.license_events (license_id, actor_id, actor_kind, event_type, metadata)
    values (
      v_id,
      nullif(v_ev->>'actor_id', '')::uuid,
      coalesce(v_ev->>'actor_kind', 'system'),
      v_ev->>'event_type',
      coalesce(v_ev->'metadata', '{}'::jsonb)
    );
  end loop;

  select version into v_new_version from public.licenses where id = v_id;
  return jsonb_build_object('version', v_new_version);
end;
$$;

-- Heartbeat: records last_seen on a live device slot. Deliberately does not
-- touch the license row so concurrent checks never conflict on `version`.
create or replace function public.license_touch_device(p_device_row uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'license_touch_device is restricted to service_role' using errcode = '42501';
  end if;
  update public.license_devices
     set last_seen_at = now()
   where id = p_device_row and deactivated_at is null;
end;
$$;

revoke all on function public.license_commit(jsonb) from public, anon, authenticated;
grant execute on function public.license_commit(jsonb) to service_role;
revoke all on function public.license_touch_device(uuid) from public, anon, authenticated;
grant execute on function public.license_touch_device(uuid) to service_role;

revoke all on function private.licenses_guard() from public, anon, authenticated;
revoke all on function private.license_devices_limit() from public, anon, authenticated;
revoke all on function private.license_events_immutable() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS + grants
-- ---------------------------------------------------------------------------

alter table public.license_admins   enable row level security;
alter table public.licenses         enable row level security;
alter table public.license_devices  enable row level security;
alter table public.license_events   enable row level security;
alter table public.license_settings enable row level security;

alter table public.license_admins   force row level security;
alter table public.licenses         force row level security;
alter table public.license_devices  force row level security;
alter table public.license_events   force row level security;
alter table public.license_settings force row level security;

-- Supabase's baseline grants broad table privileges to anon/authenticated.
-- Revoke them ALL first (column grants are additive - see 0010), then grant
-- back only the narrow SELECT slice customers may read about themselves.
revoke all on public.license_admins   from anon, authenticated;
revoke all on public.licenses         from anon, authenticated;
revoke all on public.license_devices  from anon, authenticated;
revoke all on public.license_events   from anon, authenticated;
revoke all on public.license_settings from anon, authenticated;

-- Customers: own license, non-secret columns only (never key_hash,
-- key_ciphertext, notes, created_by).
grant select (id, status, customer_name, plan, device_limit, expires_at,
              activated_at, created_at, key_hint, owner_user_id)
  on public.licenses to authenticated;

grant select (id, license_id, user_id, app_type, platform, device_label,
              activated_at, deactivated_at, last_seen_at)
  on public.license_devices to authenticated;

drop policy if exists licenses_select_own on public.licenses;
create policy licenses_select_own on public.licenses
  for select to authenticated
  using (owner_user_id = (select auth.uid()));

drop policy if exists license_devices_select_own on public.license_devices;
create policy license_devices_select_own on public.license_devices
  for select to authenticated
  using (user_id = (select auth.uid()));

-- license_admins, license_events, license_settings: no client policies and no
-- client grants. Reachable only through the `license` Edge Function.
