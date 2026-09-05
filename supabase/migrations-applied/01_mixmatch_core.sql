-- Player Management + Mix & Match roster
-- Adds ONE new table. Does not touch, alter, or delete any existing table,
-- column, or row (players, accounts, events, event_attendees, clubs, matches,
-- messages, posts, live_matches, friend_requests are all left exactly as-is).
--
-- This table stores the organizer's own Mix & Match roster: players added
-- manually, imported from Excel, or explicitly added from the registered-user
-- directory. It is scoped per organizer (organizer_id) and is intentionally
-- separate from the `players` table (which is the global directory of real
-- registered accounts used by Friends/Leaderboard/Home) so walk-in/guest
-- entries never show up as discoverable accounts elsewhere in the app.

create table if not exists public.mixmatch_players (
  id text primary key,
  organizer_id text not null,
  name text not null,
  gender text,
  skill_level numeric,
  phone text,
  email text,
  source text not null default 'manual',   -- 'manual' | 'import' | 'registered'
  linked_user_id text,                      -- accounts.id when source = 'registered'
  banned boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists mixmatch_players_organizer_idx
  on public.mixmatch_players (organizer_id);

alter table public.mixmatch_players enable row level security;

-- Permissive policies, matching how the rest of the app's tables are accessed
-- today (client uses the anon key directly, no server). Tighten to
-- organizer_id = auth.uid()::text if you want strict per-organizer isolation.
create policy "mixmatch_players_select" on public.mixmatch_players for select using (true);
create policy "mixmatch_players_insert" on public.mixmatch_players for insert with check (true);
create policy "mixmatch_players_update" on public.mixmatch_players for update using (true);
create policy "mixmatch_players_delete" on public.mixmatch_players for delete using (true);


-- Player Categories + Organizer Teams (tournament-style, distinct from in-match Team A/B)
-- Additive only. Does not alter mixmatch_players' existing columns; only appends two
-- nullable columns to link a roster player to a category/team. Safe to re-run.

create table if not exists public.mixmatch_categories (
  id text primary key,
  organizer_id text not null,
  name text not null,
  color text,
  updated_at timestamptz not null default now()
);
create index if not exists mixmatch_categories_organizer_idx on public.mixmatch_categories (organizer_id);
alter table public.mixmatch_categories enable row level security;
create policy "mixmatch_categories_select" on public.mixmatch_categories for select using (true);
create policy "mixmatch_categories_insert" on public.mixmatch_categories for insert with check (true);
create policy "mixmatch_categories_update" on public.mixmatch_categories for update using (true);
create policy "mixmatch_categories_delete" on public.mixmatch_categories for delete using (true);

create table if not exists public.mixmatch_teams (
  id text primary key,
  organizer_id text not null,
  name text not null,
  color text,
  logo text,
  updated_at timestamptz not null default now()
);
create index if not exists mixmatch_teams_organizer_idx on public.mixmatch_teams (organizer_id);
alter table public.mixmatch_teams enable row level security;
create policy "mixmatch_teams_select" on public.mixmatch_teams for select using (true);
create policy "mixmatch_teams_insert" on public.mixmatch_teams for insert with check (true);
create policy "mixmatch_teams_update" on public.mixmatch_teams for update using (true);
create policy "mixmatch_teams_delete" on public.mixmatch_teams for delete using (true);

alter table public.mixmatch_players add column if not exists category_id text;
alter table public.mixmatch_players add column if not exists team_id text;


-- Player <-> Category memberships (many-to-many)
-- Additive only. A player may now belong to multiple categories at once. This
-- join table is the new source of truth for player<->category membership;
-- mixmatch_players.category_id (added above) is left in place untouched for
-- backward compatibility but is no longer written to going forward - it is
-- vestigial. Existing single-category assignments are backfilled below.

create table if not exists public.mixmatch_category_players (
  category_id text not null references public.mixmatch_categories(id) on delete cascade,
  player_id text not null references public.mixmatch_players(id) on delete cascade,
  organizer_id text not null,
  created_at timestamptz not null default now(),
  primary key (category_id, player_id)
);

create index if not exists mixmatch_category_players_category_idx
  on public.mixmatch_category_players (category_id);
create index if not exists mixmatch_category_players_player_idx
  on public.mixmatch_category_players (player_id);

alter table public.mixmatch_category_players enable row level security;

create policy "mixmatch_category_players_select" on public.mixmatch_category_players for select using (true);
create policy "mixmatch_category_players_insert" on public.mixmatch_category_players for insert with check (true);
create policy "mixmatch_category_players_update" on public.mixmatch_category_players for update using (true);
create policy "mixmatch_category_players_delete" on public.mixmatch_category_players for delete using (true);

-- Backfill: migrate existing single-category assignments into the new join table.
insert into public.mixmatch_category_players (category_id, player_id, organizer_id)
select category_id, id, organizer_id
from public.mixmatch_players
where category_id is not null
on conflict do nothing;
