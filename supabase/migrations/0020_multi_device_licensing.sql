-- 0020_multi_device_licensing.sql
-- Extends the simple licensing model (0016) from ONE PC per license to:
--
--     ONE customer email / account  ->  ONE license  ->  up to max_devices PCs
--
-- The device limit is enforced when a device REGISTERS (activation / first
-- code-first setup), by public.license_register_device below, which locks the
-- license row so two PCs racing for the last slot can never both win.
-- Everyday /command actions stay device-blind on purpose (see docs/LICENSING.md).
--
-- Additive and backward-compatible with the previously deployed `license`
-- function: it only drops the single-slot check constraint, which that function
-- never relied on to succeed. licenses.device_id / device_label are kept as
-- history and are no longer written.

alter table public.licenses
  add column max_devices integer not null default 1
    constraint licenses_max_devices_range check (max_devices between 1 and 100);

-- The single-slot rule (active <=> licenses.device_id set) no longer holds:
-- devices now live in license_devices.
alter table public.licenses drop constraint licenses_binding_matches_status;

create table public.license_devices (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.licenses(id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 128),
  -- Computer name. Display only; never used to decide anything.
  device_label text check (device_label is null or char_length(device_label) <= 80),
  -- Account that registered the device (null for a code-first setup before
  -- the account existed).
  user_id uuid references auth.users(id) on delete set null,
  first_activated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  -- Set when an admin releases the device. A released row keeps its history
  -- and no longer holds a slot; the same PC can register again later.
  released_at timestamptz
);

-- A device holds at most one live slot per license.
create unique index license_devices_one_active
  on public.license_devices (license_id, device_id) where released_at is null;
create index license_devices_license_idx on public.license_devices (license_id);

alter table public.license_devices enable row level security;
alter table public.license_devices force row level security;
revoke all on public.license_devices from anon, authenticated;
-- No policies: deny by default, same posture as public.licenses.

-- Existing licenses: max_devices defaults to 1 above. Carry each active
-- license's currently bound PC over as its one registered device.
insert into public.license_devices (license_id, device_id, device_label, user_id, first_activated_at, last_seen_at)
select id, device_id, device_label, activated_user_id, coalesce(activated_at, created_at), activated_at
from public.licenses
where status = 'active' and device_id is not null;

-- Atomic device registration. Called only by the `license` Edge Function
-- (service role). Returns jsonb:
--   { ok: true,  outcome: 'registered' | 'already_here', active_devices, max_devices }
--   { ok: false, code: 'NOT_FOUND' | 'REVOKED' | 'EXPIRED' | 'ALREADY_ACTIVATED' | 'DEVICE_LIMIT', ... }
-- p_first_only: code-first setup may establish only the license's FIRST device.
create function public.license_register_device(
  p_license_id uuid,
  p_device_id text,
  p_device_label text,
  p_user_id uuid,
  p_first_only boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_license public.licenses%rowtype;
  v_existing uuid;
  v_active integer;
begin
  -- Serializes every registration for this license: a second caller waits
  -- here until the first commits, then counts the committed rows.
  select * into v_license from public.licenses where id = p_license_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_license.status = 'revoked' then
    return jsonb_build_object('ok', false, 'code', 'REVOKED');
  end if;
  if v_license.expires_at is not null and v_license.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;

  select count(*) into v_active
  from public.license_devices
  where license_id = p_license_id and released_at is null;

  select id into v_existing
  from public.license_devices
  where license_id = p_license_id and device_id = p_device_id and released_at is null;
  if found then
    update public.license_devices set last_seen_at = now() where id = v_existing;
    return jsonb_build_object('ok', true, 'outcome', 'already_here',
      'active_devices', v_active, 'max_devices', v_license.max_devices);
  end if;

  if p_first_only and v_active >= 1 then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_ACTIVATED',
      'active_devices', v_active, 'max_devices', v_license.max_devices);
  end if;
  if v_active >= v_license.max_devices then
    return jsonb_build_object('ok', false, 'code', 'DEVICE_LIMIT',
      'active_devices', v_active, 'max_devices', v_license.max_devices);
  end if;

  insert into public.license_devices (license_id, device_id, device_label, user_id, last_seen_at)
  values (p_license_id, p_device_id, nullif(p_device_label, ''), p_user_id, now());

  update public.licenses
  set status = 'active',
      activated_at = coalesce(activated_at, now()),
      activated_user_id = coalesce(activated_user_id, p_user_id)
  where id = p_license_id;

  return jsonb_build_object('ok', true, 'outcome', 'registered',
    'active_devices', v_active + 1, 'max_devices', v_license.max_devices);
end;
$$;

revoke all on function public.license_register_device(uuid, text, text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.license_register_device(uuid, text, text, uuid, boolean) to service_role;
