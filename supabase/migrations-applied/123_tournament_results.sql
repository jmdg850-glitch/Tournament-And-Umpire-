-- STATUS: APPLIED (version 20260806073404, confirmed live via list_migrations, 2026-08-06).
--
-- ============================================================================
-- 123: Results — Champion/Runner-up/2nd Runner-up (per division) and MVP/Best
--      Sportsmanship (tournament-wide) awards.
-- ============================================================================
-- A table, not a jsonb column on `tournaments`, because champion/runner-up are
-- inherently per-division — a multi-division tournament crowns multiple
-- champions, which a single jsonb column can't express without inventing a
-- nested shape nothing else in this schema uses. A table also keeps award rows
-- independently queryable, needed by tournamentSeeding.js's
-- seedByPreviousResults (via Cloud.fetchAccountTournamentHistory) and Archive's
-- "View Results."
--
-- player_id is populated for EVERY award_type, including champion/runner-up:
-- the app fans out one row per player on the winning registration (not one row
-- per team) when recording those awards, so every award is always individually
-- queryable by player_id regardless of singles/doubles — this is the
-- assumption Cloud.fetchAccountTournamentHistory (added ahead of this
-- migration, in the Seeding phase) already relies on.
-- ============================================================================

create table if not exists public.tournament_results (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  division_id text references public.tournament_divisions(id) on delete cascade,  -- null = tournament-wide (MVP/sportsmanship)
  organizer_id text not null,
  award_type text not null check (award_type in ('champion','runner_up_1','runner_up_2','mvp','best_sportsmanship')),
  registration_id text references public.tournament_registrations(id),           -- set for champion/runner-up
  player_id text,
  player_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournament_results_tournament_idx on public.tournament_results (tournament_id);
create index if not exists tournament_results_division_idx on public.tournament_results (division_id);
create index if not exists tournament_results_player_idx on public.tournament_results (player_id);
create index if not exists tournament_results_organizer_idx on public.tournament_results (organizer_id);

alter table public.tournament_results enable row level security;

drop policy if exists tournament_results_select on public.tournament_results;
drop policy if exists tournament_results_insert on public.tournament_results;
drop policy if exists tournament_results_update on public.tournament_results;
drop policy if exists tournament_results_delete on public.tournament_results;

create policy tournament_results_select on public.tournament_results
  for select to authenticated using (true);

create policy tournament_results_insert on public.tournament_results
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_results_update on public.tournament_results
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_results_delete on public.tournament_results
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

alter publication supabase_realtime add table public.tournament_results;
