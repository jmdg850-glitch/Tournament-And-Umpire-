-- Live Match Board — real-time spectator view for every logged-in user.
-- Adds ONE new table (live_sessions) and enables Realtime replication for it plus the
-- existing live_matches table. Does not touch, alter, or delete any existing table, column,
-- or row (players, accounts, events, event_attendees, clubs, matches, messages, posts,
-- live_matches, friend_requests, mixmatch_players, mixmatch_categories, mixmatch_teams,
-- mixmatch_category_players, rating_config, rating_history are all left exactly as-is).
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.
-- Safe to re-run (every statement is `if not exists`, and the Realtime publication statements
-- are wrapped so re-adding an already-subscribed table is a harmless no-op instead of an error).

-- live_sessions: one row per organizer while they have an active live match-making session
-- (Mix & Match or manual matches currently running/queued). There is intentionally no separate
-- "events" table — a session is implicit: it exists for as long as the organizer has at least
-- one live/paused match or a non-empty waiting queue, and the app deletes the row once neither
-- is true anymore. `queue`/`sitting_out`/`player_names` are stored as flexible jsonb documents,
-- matching how `clubs.data`/`matches.data`/`live_matches.data` already store full JS objects.
create table if not exists public.live_sessions (
  organizer_id text primary key,
  organizer_name text,
  event_name text,
  round integer not null default 1,
  queue jsonb not null default '[]'::jsonb,
  sitting_out jsonb not null default '[]'::jsonb,
  player_names jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.live_sessions enable row level security;

create policy "live_sessions_select" on public.live_sessions for select using (true);
create policy "live_sessions_insert" on public.live_sessions for insert with check (true);
create policy "live_sessions_update" on public.live_sessions for update using (true);
create policy "live_sessions_delete" on public.live_sessions for delete using (true);

-- Enable Realtime (postgres_changes) so the Live Match Board pushes updates instantly instead
-- of waiting for the client's periodic poll. Wrapped so re-running this file after a table is
-- already in the publication doesn't error.
do $$
begin
  alter publication supabase_realtime add table public.live_matches;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.live_sessions;
exception when duplicate_object then null;
end $$;
