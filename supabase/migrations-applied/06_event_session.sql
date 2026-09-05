-- Event Sessions — links "New Match" (Manual / Mix & Match / Infinite Mode) to the Event
-- Calendar so the Owner, accepted Organizers, and registered Players share one workspace
-- instead of a disconnected match. Adds TWO nullable columns to TWO existing tables and
-- loosens one constraint. Does not touch, alter, or delete any existing table, column, or row
-- (events, event_attendees, matches, live_matches, players, accounts, mixmatch_players,
-- mixmatch_categories, mixmatch_teams, rating_config, rating_history, notifications,
-- match_organizer_invites' existing rows are all left exactly as-is). No new tables. Safe to
-- re-run (every statement is `if not exists`/idempotent).
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.

-- live_sessions.event_id: which Event (events.id) this organizer's current live session
-- belongs to. Mirrors the existing round/queue columns' "my ambient current session" shape —
-- the app tracks this same value locally too (see App.jsx's `activeEventId`), this column just
-- lets it survive being read back / inspected server-side. Nullable so every existing session
-- row (and any match-only session with no Event, e.g. a no-active-session "Manually Assign")
-- is untouched.
alter table public.live_sessions add column if not exists event_id text;

-- match_organizer_invites.event_id: an invite now targets EITHER a single match (the existing,
-- unchanged path — match_id set, event_id null, used only when a match has no Event) OR a
-- whole Event (the new primary path — event_id set; acceptance cascades organizer access to
-- every match inside that Event, present and future, via Cloud.syncEventOrganizersFromInvites
-- in App.jsx). match_id is loosened to nullable to allow the event-scoped case; this is a
-- backward-compatible relaxation — no existing row (which all have match_id set) is affected.
alter table public.match_organizer_invites add column if not exists event_id text;
alter table public.match_organizer_invites alter column match_id drop not null;

create index if not exists moi_event_idx on public.match_organizer_invites (event_id);
