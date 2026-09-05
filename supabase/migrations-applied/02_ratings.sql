-- Rating Engine v2 — organizer-configurable starting rating + per-match rating history.
-- Adds TWO new tables. Does not touch, alter, or delete any existing table, column, or row
-- (players, accounts, events, event_attendees, clubs, matches, messages, posts, live_matches,
-- friend_requests, mixmatch_players, mixmatch_categories, mixmatch_teams,
-- mixmatch_category_players are all left exactly as-is).
--
-- Paste this into the Supabase SQL editor the same way you ran supabase_migration.sql.
-- Safe to re-run (every statement is `if not exists`).

-- rating_config: one row per organizer holding their configurable default starting rating
-- (Admin Command Center -> Ratings tab). Read at boot and applied to the shared RatingEngine
-- singleton client-side; falls back to the localStorage-cached value (and then 3.000) if the
-- row doesn't exist yet or the app is running fully offline.
create table if not exists public.rating_config (
  organizer_id text primary key,
  base_rating numeric not null default 3.000,
  updated_at timestamptz not null default now()
);

alter table public.rating_config enable row level security;

create policy "rating_config_select" on public.rating_config for select using (true);
create policy "rating_config_insert" on public.rating_config for insert with check (true);
create policy "rating_config_update" on public.rating_config for update using (true);
create policy "rating_config_delete" on public.rating_config for delete using (true);


-- rating_history: one row per rating change, written best-effort from endMatch() for every
-- affected player (registered accounts and guest/manual/imported roster rows alike — they share
-- the same rating engine and this same history table). Powers each player's profile "Rating
-- Trend" sparkline and highest/lowest/confidence stats. Purely additive/append-only; nothing
-- else in the app reads or writes rows here except the client-side RatingHistorySpark/
-- ratingStatsFor helpers (which primarily read the client-cached ratingHistory array on the
-- player object — this table exists for cross-device sync and future analytics/graphs).
create table if not exists public.rating_history (
  id text primary key,
  player_id text not null,
  organizer_id text,
  match_id text,
  rating_type text not null,           -- 'singles' | 'doubles'
  rating_before numeric,
  rating_after numeric,
  delta numeric,
  confidence_before numeric,
  confidence_after numeric,
  created_at timestamptz not null default now()
);

create index if not exists rating_history_player_idx on public.rating_history (player_id);
create index if not exists rating_history_organizer_idx on public.rating_history (organizer_id);

alter table public.rating_history enable row level security;

create policy "rating_history_select" on public.rating_history for select using (true);
create policy "rating_history_insert" on public.rating_history for insert with check (true);
create policy "rating_history_update" on public.rating_history for update using (true);
create policy "rating_history_delete" on public.rating_history for delete using (true);
