-- Atomic command idempotency + optimistic concurrency for the official write
-- path. Additive: no table is dropped, no existing row is changed, and every
-- existing caller keeps working (see "Compatibility" below).
--
-- 1. Atomic command claim.
--    Before this migration the command API checked `command_receipts` with a
--    plain SELECT and only wrote the receipt at the end, as an
--    `ON CONFLICT (id) DO UPDATE` upsert. Two concurrent requests with the
--    same command_id could therefore both pass the check, both run the
--    handler, and both commit their domain writes (the receipt upsert never
--    fails — the second one just overwrites the first).
--    Now the receipt row of a batch is INSERTED FIRST, with
--    `ON CONFLICT (id) DO NOTHING`. The primary-key index makes a concurrent
--    second insert of the same id wait for the first transaction; if the
--    first commits, the second inserts nothing and this function raises
--    SQLSTATE TC001, which aborts that whole transaction — none of its domain
--    writes are kept. Exactly one execution of a command_id can ever commit.
--
-- 2. `command_receipts.request_hash` (nullable). The command API stores a
--    SHA-256 of the request (type + canonical payload) so a reused command_id
--    with a DIFFERENT request is rejected instead of being answered with the
--    first request's result. Old rows keep NULL (treated as "unknown").
--
-- 3. Version checks on `matches`, evaluated under a row lock BEFORE any write:
--    payload.expect       = [{ "table": "matches", "id": uuid, "updated_at": ts }]
--       The row the handler read must still be the current row. Otherwise
--       SQLSTATE TC412 (a server-internal read/write race: the command API
--       re-runs the command against fresh state).
--    payload.precondition = [{ "table": "matches", "id": uuid, "updated_at": ts }]
--       A client-supplied "I last saw this version" check (future offline
--       writes). Otherwise SQLSTATE TC409 (the client's data is stale: HTTP
--       409 STALE_STATE). DETAIL carries the current version, in the same
--       JSON timestamp format the API returns for matches.updated_at.
--    Only `matches` is accepted; anything else raises (22023).
--
-- Compatibility:
--   - Old command API + this migration: an old concurrent duplicate now
--     fails its whole batch (TC001 → the old API reports 500 → the client
--     retries → the retry finds the receipt and replays it). No new effect.
--   - New command API + database WITHOUT this migration: `expect` /
--     `precondition` keys are ignored and `request_hash` is dropped by the
--     present-columns filter, i.e. exactly today's behaviour.
--
-- Rollback: re-run the function body from
-- 0007_official_writes_present_columns.sql. The `request_hash` column can be
-- left in place (nullable, unused by the old function).

alter table public.command_receipts
  add column if not exists request_hash text;

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
  cur timestamptz;
  claimed integer;
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

  -- 1. Claim the command (insert-only). Nothing else is written unless the
  --    claim succeeds.
  if jsonb_typeof(payload->'upserts'->'command_receipts') = 'array' then
    for rec in select elem from jsonb_array_elements(payload->'upserts'->'command_receipts') as elem
    loop
      if rec->>'id' is null then
        raise exception 'upsert row for command_receipts requires id';
      end if;
      select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position)
      into col_list
      from information_schema.columns c
      where c.table_schema = 'public'
        and c.table_name = 'command_receipts'
        and rec ? c.column_name;
      execute format(
        'insert into public.command_receipts (%s) select %s from jsonb_populate_record(null::public.command_receipts, $1)
         on conflict (id) do nothing',
        col_list, col_list
      ) using rec;
      get diagnostics claimed = row_count;
      if claimed = 0 then
        raise exception 'command already applied' using errcode = 'TC001', detail = rec->>'id';
      end if;
    end loop;
  end if;

  -- 2. Version checks, under a row lock held until commit, so nothing can
  --    change the row between the check and the write below. All checked
  --    rows are locked first, in id order, so two batches checking the same
  --    rows can't deadlock by locking them in opposite orders.
  perform 1
  from public.matches m
  where m.id in (
    select (e->>'id')::uuid
    from jsonb_array_elements(
      (case when jsonb_typeof(payload->'expect') = 'array' then payload->'expect' else '[]'::jsonb end)
      || (case when jsonb_typeof(payload->'precondition') = 'array' then payload->'precondition' else '[]'::jsonb end)
    ) as e
    where e->>'table' = 'matches'
  )
  order by m.id
  for update;

  if jsonb_typeof(payload->'expect') = 'array' then
    for rec in select elem from jsonb_array_elements(payload->'expect') as elem
    loop
      if rec->>'table' is distinct from 'matches' then
        raise exception 'expect supports only matches' using errcode = '22023';
      end if;
      select m.updated_at into cur from public.matches m where m.id = (rec->>'id')::uuid for update;
      if not found or cur is distinct from (rec->>'updated_at')::timestamptz then
        raise exception 'row changed since it was read' using errcode = 'TC412', detail = coalesce(to_json(cur) #>> '{}', '');
      end if;
    end loop;
  end if;
  if jsonb_typeof(payload->'precondition') = 'array' then
    for rec in select elem from jsonb_array_elements(payload->'precondition') as elem
    loop
      if rec->>'table' is distinct from 'matches' then
        raise exception 'precondition supports only matches' using errcode = '22023';
      end if;
      select m.updated_at into cur from public.matches m where m.id = (rec->>'id')::uuid for update;
      if not found or cur is distinct from (rec->>'updated_at')::timestamptz then
        raise exception 'stale state' using errcode = 'TC409', detail = coalesce(to_json(cur) #>> '{}', '');
      end if;
    end loop;
  end if;

  -- 3. Domain writes (unchanged from 0007; receipts were written in step 1).
  foreach tbl in array allowed
  loop
    if tbl = 'command_receipts' then
      continue;
    end if;
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
