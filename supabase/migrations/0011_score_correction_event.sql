-- Adds 'correction' to the set of allowed score_events.type values, so an
-- authorized organizer/umpire can issue a controlled score correction through
-- the existing score_event command machinery (see packages/engine/src/scoring.js
-- applyScoreEvent's "correction" case and packages/api/src/handleCommand.js
-- handleScoreEvent). No other schema, table, or RLS policy is touched.
--
-- The existing check constraint on score_events.type was declared inline in
-- 0001_initial_schema.sql without an explicit name, so Postgres auto-named it.
-- Rather than assume that generated name, this locates it dynamically via
-- pg_constraint (a CHECK constraint on public.score_events whose definition
-- mentions the "type" column) and replaces only that constraint.

do $$
declare
  existing_constraint text;
begin
  select con.conname
    into existing_constraint
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = 'public'
      and rel.relname = 'score_events'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%type%'
    limit 1;

  if existing_constraint is null then
    raise exception 'Could not locate the existing CHECK constraint on public.score_events.type';
  end if;

  execute format('alter table public.score_events drop constraint %I', existing_constraint);
end $$;

alter table public.score_events
  add constraint score_events_type_check
  check (type in ('point', 'undo', 'timeout', 'coin_toss', 'correction'));
