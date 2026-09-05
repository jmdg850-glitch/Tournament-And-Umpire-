-- STATUS: APPLIED (version 20260804084234, confirmed live via list_migrations, 2026-08-04).
--
-- ============================================================================
-- 112: Tournament module (foundation phase) — tournaments, tournament_divisions,
--      tournament_registrations, tournament_matches.
-- ============================================================================
-- New tables only. Does not touch, alter, or delete any existing table, column,
-- or row (accounts, players, events, event_attendees, clubs, matches, messages,
-- posts, live_matches, live_sessions, friend_requests, mixmatch_players,
-- mixmatch_categories, mixmatch_teams, mixmatch_category_players, courts,
-- rating_config, rating_history, notifications, match_organizer_invites,
-- admins, dupr_* are all left exactly as-is). Safe to re-run (every statement
-- is `if not exists`).
--
-- Design notes
-- - Tournament divisions are deliberately a NEW concept, not a reuse of
--   mixmatch_categories (that table backs the separate, already-shipping
--   Mix & Match casual-play feature — different lifecycle/fields; reusing it
--   would risk breaking Mix & Match).
-- - Each child table denormalizes organizer_id (copied from tournaments.owner_id
--   at insert time), exactly like mixmatch_players/courts do today. This keeps
--   RLS a cheap flat check reusing public.is_co_organizer_of(organizer_id)
--   (defined in 102_policies_matches_live.sql) — no new SQL function needed.
--   A co-organizer with an accepted invite on any event owned by the same
--   owner_id automatically gets tournament-management rights for that owner's
--   tournaments too — no new role concept, per the approved design.
-- - live_matches rows are deleted the instant a match completes (existing
--   invariant — see App.jsx endMatch), so tournament_matches.live_match_id is
--   ON DELETE SET NULL: the tournament match's own status/winner/score is the
--   durable record, live_match_id is just a while-in-progress bridge.
-- - SELECT is `to authenticated using(true)` (matches events/courts) rather
--   than the fully-public live_matches/live_sessions special case, since no
--   signed-out spectate surface consumes this data yet. Widening to public
--   later is a one-line policy change, not a schema change.
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier
-- migration files.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tournaments
-- ----------------------------------------------------------------------------
create table if not exists public.tournaments (
  id text primary key,
  name text not null,
  logo_url text,
  venue text,
  start_date date,
  end_date date,
  owner_id text not null,
  owner_name text,
  organizer_ids jsonb not null default '[]'::jsonb,     -- mirrors events.organizer_ids
  organizer_names jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft','active','completed','cancelled')),
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournaments_owner_idx on public.tournaments (owner_id);

alter table public.tournaments enable row level security;

drop policy if exists tournaments_select on public.tournaments;
drop policy if exists tournaments_insert on public.tournaments;
drop policy if exists tournaments_update on public.tournaments;
drop policy if exists tournaments_delete on public.tournaments;

create policy tournaments_select on public.tournaments
  for select to authenticated using (true);

create policy tournaments_insert on public.tournaments
  for insert to authenticated with check (
    owner_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(owner_id)
  );

create policy tournaments_update on public.tournaments
  for update to authenticated
  using (owner_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(owner_id))
  with check (owner_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(owner_id));

create policy tournaments_delete on public.tournaments
  for delete to authenticated using (
    owner_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(owner_id)
  );

-- ----------------------------------------------------------------------------
-- tournament_divisions
-- ----------------------------------------------------------------------------
create table if not exists public.tournament_divisions (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  organizer_id text not null,                            -- denormalized tournaments.owner_id
  name text not null,
  category text,                                          -- e.g. "Mixed Doubles"
  skill_level text,
  is_doubles boolean not null default true,
  format text not null check (format in ('round_robin','single_elimination')),
  win_to integer not null default 11,
  best_of integer not null default 1,                     -- feeds the additive scoring.js bestOf
  status text not null default 'pending'
    check (status in ('pending','in_progress','completed')),
  seed_order jsonb,                                        -- [registration_id,...] frozen at draw time
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournament_divisions_tournament_idx on public.tournament_divisions (tournament_id);
create index if not exists tournament_divisions_organizer_idx on public.tournament_divisions (organizer_id);

alter table public.tournament_divisions enable row level security;

drop policy if exists tournament_divisions_select on public.tournament_divisions;
drop policy if exists tournament_divisions_insert on public.tournament_divisions;
drop policy if exists tournament_divisions_update on public.tournament_divisions;
drop policy if exists tournament_divisions_delete on public.tournament_divisions;

create policy tournament_divisions_select on public.tournament_divisions
  for select to authenticated using (true);

create policy tournament_divisions_insert on public.tournament_divisions
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_divisions_update on public.tournament_divisions
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_divisions_delete on public.tournament_divisions
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- ----------------------------------------------------------------------------
-- tournament_registrations
-- ----------------------------------------------------------------------------
create table if not exists public.tournament_registrations (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  division_id text not null references public.tournament_divisions(id) on delete cascade,
  organizer_id text not null,
  player_ids jsonb not null default '[]'::jsonb,          -- 1 (singles) or 2 (doubles) ids
  player_names jsonb not null default '{}'::jsonb,        -- id -> name
  linked_account_ids jsonb not null default '[]'::jsonb,  -- accounts.id among player_ids, if any
  seed integer,
  status text not null default 'registered'
    check (status in ('registered','checked_in','withdrawn')),
  source text not null default 'manual' check (source in ('manual','import','account_search')),
  created_at timestamptz not null default now()
);

create index if not exists tournament_registrations_division_idx on public.tournament_registrations (division_id);
create index if not exists tournament_registrations_organizer_idx on public.tournament_registrations (organizer_id);

alter table public.tournament_registrations enable row level security;

drop policy if exists tournament_registrations_select on public.tournament_registrations;
drop policy if exists tournament_registrations_insert on public.tournament_registrations;
drop policy if exists tournament_registrations_update on public.tournament_registrations;
drop policy if exists tournament_registrations_delete on public.tournament_registrations;

create policy tournament_registrations_select on public.tournament_registrations
  for select to authenticated using (true);

create policy tournament_registrations_insert on public.tournament_registrations
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_registrations_update on public.tournament_registrations
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_registrations_delete on public.tournament_registrations
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- ----------------------------------------------------------------------------
-- tournament_matches
-- ----------------------------------------------------------------------------
create table if not exists public.tournament_matches (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  division_id text not null references public.tournament_divisions(id) on delete cascade,
  organizer_id text not null,
  round integer not null default 1,
  round_label text,                                        -- "Round 2", "Quarterfinal", "Final"
  bracket_position integer,                                 -- slot index within the round
  registration_a_id text references public.tournament_registrations(id),
  registration_b_id text references public.tournament_registrations(id),
  court_id text references public.courts(id),                -- manual assignment only
  status text not null default 'pending'
    check (status in ('pending','scheduled','in_progress','completed','bye','cancelled')),
  winner text check (winner in ('A','B')),
  score jsonb,                                                -- {scoreA,scoreB,gamesWonA,gamesWonB,games:[...]}
  live_match_id text references public.live_matches(id) on delete set null,  -- while-in-progress bridge
  completed_match_id text references public.matches(id),                    -- bridge to the audit log
  next_match_id text references public.tournament_matches(id),              -- single-elim advancement pointer
  next_match_slot text check (next_match_slot in ('A','B')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tournament_matches_division_round_idx
  on public.tournament_matches (division_id, round);
create index if not exists tournament_matches_organizer_idx on public.tournament_matches (organizer_id);
create index if not exists tournament_matches_live_match_idx on public.tournament_matches (live_match_id);

alter table public.tournament_matches enable row level security;

drop policy if exists tournament_matches_select on public.tournament_matches;
drop policy if exists tournament_matches_insert on public.tournament_matches;
drop policy if exists tournament_matches_update on public.tournament_matches;
drop policy if exists tournament_matches_delete on public.tournament_matches;

create policy tournament_matches_select on public.tournament_matches
  for select to authenticated using (true);

create policy tournament_matches_insert on public.tournament_matches
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_matches_update on public.tournament_matches
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_matches_delete on public.tournament_matches
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );
