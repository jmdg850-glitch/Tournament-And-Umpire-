-- Official writes: transactional upsert/delete. Callable only as service_role.
-- Clients never receive the service_role key and cannot EXECUTE this function.

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
      where c.table_schema = 'public' and c.table_name = tbl;

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
