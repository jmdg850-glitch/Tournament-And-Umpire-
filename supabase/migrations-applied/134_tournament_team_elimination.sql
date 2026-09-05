-- ============================================================================
-- 134: Team Elimination — tournament_teams table (a "Team Group" containing
--      several tournament_registrations pairs) + the new team_elimination
--      division format.
-- ============================================================================
-- New table follows the exact same shape/RLS pattern as tournament_pools
-- (122_tournament_pools.sql): organizer_id denormalized from tournaments.owner_id
-- at insert time, same is_co_organizer_of() reuse — no new role concept.
-- Division-scoped (not tournament-scoped) since a team grouping only has
-- meaning relative to one bracket, same reasoning as tournament_pools.
--
-- team_id on tournament_registrations is nullable and only meaningful for
-- team_elimination divisions — every other format simply never sets it.
-- on delete set null (not cascade) so deleting a team un-assigns its pairs
-- rather than deleting the registrations themselves.
--
-- Mandatory: tournament_teams MUST be added to the supabase_realtime
-- publication in this same migration (see migration 117's postmortem, repeated
-- in 122's own comment) — a table left out of the publication silently drops
-- realtime events with no error.
-- ============================================================================

create table if not exists public.tournament_teams (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  division_id text not null references public.tournament_divisions(id) on delete cascade,
  organizer_id text not null,                            -- denormalized tournaments.owner_id
  name text not null,
  color text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournament_teams_division_idx on public.tournament_teams (division_id);
create index if not exists tournament_teams_organizer_idx on public.tournament_teams (organizer_id);

alter table public.tournament_teams enable row level security;

drop policy if exists tournament_teams_select on public.tournament_teams;
drop policy if exists tournament_teams_insert on public.tournament_teams;
drop policy if exists tournament_teams_update on public.tournament_teams;
drop policy if exists tournament_teams_delete on public.tournament_teams;

create policy tournament_teams_select on public.tournament_teams
  for select to authenticated using (true);

create policy tournament_teams_insert on public.tournament_teams
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_teams_update on public.tournament_teams
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_teams_delete on public.tournament_teams
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

alter table public.tournament_registrations
  add column if not exists team_id text references public.tournament_teams(id) on delete set null;
create index if not exists tournament_registrations_team_idx on public.tournament_registrations (team_id);

-- Widen the division format check (round_robin/single_elimination/
-- double_elimination/pool_play/pool_to_knockout, migration 122) to add
-- team_elimination. Auto-named-turned-explicit constraint, same drop/re-add
-- pattern migrations 118/122 already used successfully.
alter table public.tournament_divisions
  drop constraint if exists tournament_divisions_format_check;
alter table public.tournament_divisions
  add constraint tournament_divisions_format_check
  check (format in ('round_robin','single_elimination','double_elimination','pool_play','pool_to_knockout','team_elimination'));

alter publication supabase_realtime add table public.tournament_teams;
