-- Multi-organizer events + notifications inbox.
-- Adds TWO nullable/defaulted columns to the existing `events` table and ONE new table.
-- Does not touch, alter, or delete any existing table, column, or row (players, accounts,
-- events' existing columns, event_attendees, clubs, matches, messages, posts, live_matches,
-- friend_requests, mixmatch_players, mixmatch_categories, mixmatch_teams,
-- mixmatch_category_players, rating_config, rating_history, live_sessions are all left exactly
-- as-is). Safe to re-run (every statement is `if not exists`).
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.

-- events.organizer_ids / organizer_names: co-organizers granted full control of the event
-- (view/manage players, waiting list, live matches, courts, scores, event settings) except
-- deleting the event or transferring ownership, which stay gated to owner_id. Mirrors the
-- existing match.organizerId/organizerIds pattern and live_sessions' jsonb columns — same
-- shape, no new concept. Defaults to empty so every existing event behaves exactly as before.
alter table public.events add column if not exists organizer_ids jsonb not null default '[]'::jsonb;
alter table public.events add column if not exists organizer_names jsonb not null default '{}'::jsonb;

-- notifications: a durable, per-user, read/unread inbox item. New table — justified because
-- nothing existing models this shape (friend_requests is a different, purpose-built table;
-- live_matches/live_sessions are broadcast/shared data, not addressed to one user). Used first
-- for "you were added as an organizer" but the `type`/`event_id` shape is generic enough to
-- reuse for future notification kinds without another migration.
create table if not exists public.notifications (
  id text primary key,
  user_id text not null,            -- recipient
  type text not null,               -- e.g. 'event_organizer_added'
  title text not null,
  body text,
  event_id text,                    -- deep-link target (events.id), nullable
  actor_id text,
  actor_name text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_idx on public.notifications (user_id);

alter table public.notifications enable row level security;

-- Permissive policies, matching how every other table in this app is accessed today (client
-- uses the anon key directly, no server).
create policy "notifications_select" on public.notifications for select using (true);
create policy "notifications_insert" on public.notifications for insert with check (true);
create policy "notifications_update" on public.notifications for update using (true);
create policy "notifications_delete" on public.notifications for delete using (true);
