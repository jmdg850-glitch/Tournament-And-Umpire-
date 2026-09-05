-- STATUS: APPLIED (version 20260806070224, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 122: Pool Play + Pool-to-Knockout — tournament_pools table, pool_id bridges,
--      and the two new division format values.
-- ============================================================================
-- New table follows the exact same shape/RLS pattern as tournament_divisions
-- (organizer_id denormalized from tournaments.owner_id at insert time, same
-- is_co_organizer_of() reuse — no new role concept). pool_id on registrations/
-- matches is nullable so every non-pool division (round_robin/single_elim/
-- double_elim) is completely unaffected — those rows simply never get a pool_id.
--
-- Mandatory: tournament_pools MUST be added to the supabase_realtime
-- publication in this same migration. Migration 117 exists specifically
-- because a prior tournament table was left out of the publication and
-- silently failed to deliver realtime events ("data disappears on refresh")
-- until that was caught and fixed after the fact — this repeats that exact
-- fix inline instead of needing a follow-up migration to catch the same bug.
-- ============================================================================

create table if not exists public.tournament_pools (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  division_id text not null references public.tournament_divisions(id) on delete cascade,
  organizer_id text not null,                            -- denormalized tournaments.owner_id
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournament_pools_division_idx on public.tournament_pools (division_id);
create index if not exists tournament_pools_organizer_idx on public.tournament_pools (organizer_id);

alter table public.tournament_pools enable row level security;

drop policy if exists tournament_pools_select on public.tournament_pools;
drop policy if exists tournament_pools_insert on public.tournament_pools;
drop policy if exists tournament_pools_update on public.tournament_pools;
drop policy if exists tournament_pools_delete on public.tournament_pools;

create policy tournament_pools_select on public.tournament_pools
  for select to authenticated using (true);

create policy tournament_pools_insert on public.tournament_pools
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_pools_update on public.tournament_pools
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_pools_delete on public.tournament_pools
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

alter table public.tournament_registrations
  add column if not exists pool_id text references public.tournament_pools(id);
create index if not exists tournament_registrations_pool_idx on public.tournament_registrations (pool_id);

alter table public.tournament_matches
  add column if not exists pool_id text references public.tournament_pools(id);
create index if not exists tournament_matches_pool_idx on public.tournament_matches (pool_id);

-- Widen the division format check (originally round_robin/single_elimination/
-- double_elimination, migration 112) to add the two pool formats. Auto-named
-- constraint, same drop/re-add pattern migration 118 already used successfully
-- for tournament_matches_bracket_side_check.
alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_format_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_format_check
  check (format in ('round_robin','single_elimination','double_elimination','pool_play','pool_to_knockout'));

alter table public.tournament_divisions
  add column if not exists pool_count integer;
alter table public.tournament_divisions
  add column if not exists pool_advance_count integer;
alter table public.tournament_divisions
  add column if not exists pool_knockout_format text;
alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_pool_knockout_format_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_pool_knockout_format_check
  check (pool_knockout_format is null or pool_knockout_format in ('single_elimination','double_elimination'));

alter publication supabase_realtime add table public.tournament_pools;
