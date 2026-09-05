-- Tournament domain schema. Clean history — not PickleLive / NextG.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, service_role;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '',
  platform_role text not null default 'user' check (platform_role in ('user', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sport text not null default 'pickleball',
  status text not null default 'draft' check (status in (
    'draft', 'registration', 'registration_closed', 'ready',
    'in_progress', 'completed', 'cancelled', 'archived'
  )),
  owner_id uuid not null references public.profiles (id),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tournament_members (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null check (role in ('organizer', 'admin', 'umpire', 'viewer')),
  created_at timestamptz not null default now(),
  unique (tournament_id, user_id)
);

create table public.divisions (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text not null,
  format text not null default 'single_elim' check (format in (
    'single_elim', 'double_elim', 'round_robin', 'pool', 'team_elimination'
  )),
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.persons (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  display_name text not null,
  user_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.teams (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  division_id uuid references public.divisions (id) on delete cascade,
  name text not null,
  ranking integer,
  bracket_group text,
  created_at timestamptz not null default now()
);

create table public.team_members (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references public.teams (id) on delete cascade,
  person_id uuid not null references public.persons (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (team_id, person_id)
);

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  division_id uuid not null references public.divisions (id) on delete cascade,
  kind text not null check (kind in ('singles', 'doubles', 'team_pair')),
  team_id uuid references public.teams (id) on delete set null,
  seed integer,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.participant_members (
  id uuid primary key default gen_random_uuid(),
  participant_id uuid not null references public.participants (id) on delete cascade,
  person_id uuid not null references public.persons (id) on delete cascade,
  slot integer not null default 1,
  unique (participant_id, person_id)
);

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table public.stages (
  id uuid primary key default gen_random_uuid(),
  division_id uuid not null references public.divisions (id) on delete cascade,
  kind text not null,
  name text,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  division_id uuid not null references public.divisions (id) on delete cascade,
  stage_id uuid references public.stages (id) on delete set null,
  parent_match_id uuid references public.matches (id) on delete cascade,
  pair_slot integer,
  round integer,
  bracket_position integer,
  bracket_side text,
  stage_label text,
  status text not null default 'scheduled' check (status in (
    'scheduled', 'ready', 'assigned', 'in_progress', 'completed',
    'postponed', 'cancelled', 'abandoned', 'bye'
  )),
  winner text check (winner in ('A', 'B')),
  next_match_id uuid,
  next_match_slot text check (next_match_slot in ('A', 'B')),
  loser_next_match_id uuid,
  loser_next_match_slot text check (loser_next_match_slot in ('A', 'B')),
  serving_team text check (serving_team in ('A', 'B')),
  coin_toss jsonb,
  score_state jsonb not null default '{}'::jsonb,
  team_a_wins integer not null default 0,
  team_b_wins integer not null default 0,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.match_participants (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  slot text not null check (slot in ('A', 'B')),
  participant_id uuid references public.participants (id) on delete set null,
  team_id uuid references public.teams (id) on delete set null,
  unique (match_id, slot)
);

create table public.score_events (
  id uuid primary key,
  match_id uuid not null references public.matches (id) on delete cascade,
  seq integer not null,
  type text not null check (type in ('point', 'undo', 'timeout', 'coin_toss')),
  payload jsonb not null default '{}'::jsonb,
  actor_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (match_id, seq)
);

create table public.match_results (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null unique references public.matches (id) on delete cascade,
  winner_slot text not null check (winner_slot in ('A', 'B')),
  winner_participant_id uuid references public.participants (id),
  winner_team_id uuid references public.teams (id),
  games jsonb not null default '[]'::jsonb,
  score_a integer,
  score_b integer,
  completed_at timestamptz not null default now()
);

create table public.court_assignments (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null unique references public.matches (id) on delete cascade,
  court_id uuid not null references public.courts (id) on delete cascade,
  assigned_by uuid references public.profiles (id),
  assigned_at timestamptz not null default now()
);

create table public.umpire_assignments (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null unique references public.matches (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  assigned_by uuid references public.profiles (id),
  assigned_at timestamptz not null default now()
);

create table public.command_receipts (
  id uuid primary key,
  actor_id uuid not null references public.profiles (id),
  command_type text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references public.profiles (id),
  command_id uuid,
  command_type text,
  tournament_id uuid references public.tournaments (id) on delete set null,
  match_id uuid references public.matches (id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index tournaments_owner_idx on public.tournaments (owner_id);
create index tournament_members_user_idx on public.tournament_members (user_id);
create index tournament_members_tid_idx on public.tournament_members (tournament_id);
create index divisions_tid_idx on public.divisions (tournament_id);
create index persons_tid_idx on public.persons (tournament_id);
create index teams_tid_idx on public.teams (tournament_id);
create index participants_division_idx on public.participants (division_id);
create index matches_tid_idx on public.matches (tournament_id);
create index matches_division_idx on public.matches (division_id);
create index matches_parent_idx on public.matches (parent_match_id);
create index score_events_match_idx on public.score_events (match_id, seq);
create index umpire_assignments_user_idx on public.umpire_assignments (user_id);
create index audit_logs_tid_idx on public.audit_logs (tournament_id);
