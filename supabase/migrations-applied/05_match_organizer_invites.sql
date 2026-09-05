-- Match Organizer Invites — persistent, notified, realtime-synced co-organizer invitations for
-- MATCHES (distinct from the existing event organizer_ids/organizer_names columns on `events`,
-- which stay exactly as-is and remain instant-add/no-invite). Adds ONE new table and TWO
-- nullable columns on the existing `notifications` table. Does not touch, alter, or delete any
-- existing table, column, or row. Safe to re-run (every statement is `if not exists`, and the
-- Realtime publication statement is wrapped so re-adding an already-subscribed table is a
-- harmless no-op instead of an error).
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.

-- match_organizer_invites: one row per invite. `match.organizerIds` (embedded in the
-- live_matches/matches JSON payload, see startMatch() in App.jsx) only ever contains the ids of
-- invites that have reached status = 'accepted' here — this table is the single source of truth
-- for who has actually agreed to co-organize a given match, so there's never a lost-update race
-- when several invites for the same match are accepted independently.
create table if not exists public.match_organizer_invites (
  id text primary key,
  match_id text not null,
  owner_id text not null,           -- the match's creator/owner (accounts.id)
  owner_name text,
  invitee_id text not null,         -- the invited co-organizer (accounts.id)
  invitee_name text,
  court_name text,                  -- denormalized context for the notification, avoids a join
  match_summary text,               -- e.g. "Doubles · Jul 21" — denormalized display context
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','cancelled')),
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

create index if not exists moi_match_idx on public.match_organizer_invites (match_id);
create index if not exists moi_invitee_idx on public.match_organizer_invites (invitee_id);
create index if not exists moi_owner_idx on public.match_organizer_invites (owner_id);

-- Prevents inviting the same person to the same match twice while a prior invite is still
-- pending (defensive DB-level backstop; the UI already can't pick the same id twice in one
-- session, this guards against a double-tapped Start / multi-device race).
create unique index if not exists moi_unique_pending
  on public.match_organizer_invites (match_id, invitee_id) where status = 'pending';

alter table public.match_organizer_invites enable row level security;

-- Real auth.uid()-based RLS — unlike every other table in this app (which uses permissive
-- `using (true)` policies, since there's no server and everything goes through the anon key),
-- this table only lets the two actual parties see or touch a given invite. Every registered
-- account authenticates through Supabase Auth with id = accounts.id (see Cloud.createAccount's
-- comment in App.jsx), so auth.uid() reliably matches owner_id/invitee_id for real accounts.
-- (The one exception is the app's hardcoded local admin shortcut, which never creates a real
-- Supabase Auth session — admins don't need this table since canControlMatch already grants
-- them full access to every match unconditionally.)
create policy "moi_select" on public.match_organizer_invites
  for select using (owner_id = auth.uid()::text or invitee_id = auth.uid()::text);
create policy "moi_insert" on public.match_organizer_invites
  for insert with check (owner_id = auth.uid()::text);
create policy "moi_update" on public.match_organizer_invites
  for update using (owner_id = auth.uid()::text or invitee_id = auth.uid()::text)
  with check (owner_id = auth.uid()::text or invitee_id = auth.uid()::text);

-- Enable Realtime so the match owner's device can react the instant an invite is accepted
-- (see Cloud.subscribeMyOwnedMatchInvites in App.jsx) instead of waiting for a poll.
do $$
begin
  alter publication supabase_realtime add table public.match_organizer_invites;
exception when duplicate_object then null;
end $$;

-- notifications: reuse the existing table (from the v1 migration) instead of inventing a
-- parallel notification path. Both columns are nullable/additive — every existing notification
-- row (event_organizer_added, etc.) is completely unaffected.
alter table public.notifications add column if not exists invite_id text;
alter table public.notifications add column if not exists match_id text;

-- Enable Realtime on notifications so a new "you've been invited to co-organize" notification
-- (or any notification) is delivered instantly instead of waiting for the existing 10s poll.
do $$
begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null;
end $$;
