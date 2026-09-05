-- Court stations: device pairing for umpire Android without human Auth.
-- Dual-run: umpire_assignments and human Auth scoring remain valid.

alter table public.courts
  add column if not exists station_public_id text;

update public.courts
set station_public_id = encode(gen_random_bytes(16), 'hex')
where station_public_id is null;

alter table public.courts
  alter column station_public_id set not null;

alter table public.courts
  alter column station_public_id set default encode(gen_random_bytes(16), 'hex');

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'courts_station_public_id_key'
  ) then
    alter table public.courts add constraint courts_station_public_id_key unique (station_public_id);
  end if;
end $$;

create table if not exists public.court_devices (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts (id) on delete cascade,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  refresh_token_hash text not null,
  status text not null default 'active' check (status in ('active', 'revoked')),
  device_label text not null default '',
  paired_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists court_devices_one_active
  on public.court_devices (court_id)
  where status = 'active';

create index if not exists court_devices_court_idx on public.court_devices (court_id);
create index if not exists court_devices_hash_idx on public.court_devices (refresh_token_hash);

create table if not exists public.court_pairing_grants (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts (id) on delete cascade,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

create index if not exists court_pairing_grants_court_idx on public.court_pairing_grants (court_id);

alter table public.score_events
  alter column actor_id drop not null;

alter table public.score_events
  add column if not exists actor_device_id uuid references public.court_devices (id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'score_events_actor_xor'
  ) then
    alter table public.score_events add constraint score_events_actor_xor check (
      (actor_id is not null and actor_device_id is null)
      or (actor_id is null and actor_device_id is not null)
    );
  end if;
end $$;

alter table public.command_receipts
  alter column actor_id drop not null;

alter table public.command_receipts
  add column if not exists actor_device_id uuid references public.court_devices (id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'command_receipts_actor_xor'
  ) then
    alter table public.command_receipts add constraint command_receipts_actor_xor check (
      (actor_id is not null and actor_device_id is null)
      or (actor_id is null and actor_device_id is not null)
    );
  end if;
end $$;

alter table public.audit_logs
  add column if not exists actor_device_id uuid references public.court_devices (id) on delete set null;

alter table public.court_devices enable row level security;
alter table public.court_pairing_grants enable row level security;
alter table public.court_devices force row level security;
alter table public.court_pairing_grants force row level security;

create policy court_devices_select on public.court_devices
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy court_pairing_grants_select on public.court_pairing_grants
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

grant select on public.court_devices to authenticated;
grant select on public.court_pairing_grants to authenticated;
revoke insert, update, delete on public.court_devices from anon, authenticated;
revoke insert, update, delete on public.court_pairing_grants from anon, authenticated;

create or replace function public.apply_official_writes(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  tbl text;
  rec jsonb;
  idv uuid;
  allowed constant text[] := array[
    'profiles',
    'tournaments',
    'tournament_members',
    'divisions',
    'persons',
    'teams',
    'team_members',
    'participants',
    'participant_members',
    'courts',
    'stages',
    'matches',
    'match_participants',
    'score_events',
    'match_results',
    'court_assignments',
    'umpire_assignments',
    'court_devices',
    'court_pairing_grants',
    'command_receipts',
    'audit_logs'
  ];
  delete_order constant text[] := array[
    'audit_logs',
    'command_receipts',
    'umpire_assignments',
    'court_assignments',
    'match_results',
    'score_events',
    'match_participants',
    'matches',
    'court_pairing_grants',
    'court_devices',
    'stages',
    'courts',
    'participant_members',
    'participants',
    'team_members',
    'teams',
    'persons',
    'divisions',
    'tournament_members',
    'tournaments',
    'profiles'
  ];
  col_list text;
  upd_list text;
begin
  if coalesce(auth.role(), current_user) not in ('service_role', 'postgres', 'supabase_admin') then
    raise exception 'apply_official_writes is restricted to service_role' using errcode = '42501';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'payload must be a jsonb object';
  end if;

  foreach tbl in array allowed
  loop
    if payload->'upserts'->tbl is null or jsonb_typeof(payload->'upserts'->tbl) <> 'array' then
      continue;
    end if;
    for rec in select elem from jsonb_array_elements(payload->'upserts'->tbl) as elem
    loop
      if rec->>'id' is null then
        raise exception 'upsert row for % requires id', tbl;
      end if;

      select
        string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position),
        string_agg(
          format('%I = excluded.%I', c.column_name, c.column_name),
          ', ' order by c.ordinal_position
        ) filter (where c.column_name <> 'id')
      into col_list, upd_list
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = tbl
        and rec ? c.column_name;

      if col_list is null then
        raise exception 'upsert row for % has no known columns', tbl;
      end if;
      if upd_list is null then
        upd_list := 'id = excluded.id';
      end if;

      execute format(
        'insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1)
         on conflict (id) do update set %s',
        tbl, col_list, col_list, tbl, upd_list
      ) using rec;
    end loop;
  end loop;

  foreach tbl in array delete_order
  loop
    if payload->'deletes'->tbl is null or jsonb_typeof(payload->'deletes'->tbl) <> 'array' then
      continue;
    end if;
    for rec in select elem from jsonb_array_elements(payload->'deletes'->tbl) as elem
    loop
      idv := (rec #>> '{}')::uuid;
      if idv is null and rec ? 'id' then
        idv := (rec->>'id')::uuid;
      end if;
      if idv is null then
        raise exception 'delete for % requires uuid', tbl;
      end if;
      execute format('delete from public.%I where id = $1', tbl) using idv;
    end loop;
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.apply_official_writes(jsonb) from public, anon, authenticated;
grant execute on function public.apply_official_writes(jsonb) to service_role;
