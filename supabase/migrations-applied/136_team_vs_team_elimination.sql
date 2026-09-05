-- ============================================================================
-- 136: True Team-vs-Team Elimination — tournament_team_matchups table (the
--      actual bracket unit is now a TEAM, not a pair) + team_matchup_id/
--      pair_slot bridge columns on tournament_matches.
-- ============================================================================
-- Replaces the pair-vs-pair "team-aware placement" model from migrations
-- 134/135. Those columns (tournament_teams, tournament_registrations.team_id,
-- tournament_divisions.same_team_matchup_policy/elimination_participant_mode/
-- elimination_participant_count) are left completely untouched here — they're
-- preserved for compatibility per explicit instruction, just no longer read
-- by the application for team_elimination going forward.
--
-- A team_matchup is one "Team A vs Team B" bracket card. It contains N
-- individual pair matches (existing tournament_matches rows, linked via the
-- new team_matchup_id column) that decide it by majority. Follows the exact
-- RLS pattern already used by tournament_teams (migration 134) / tournament_pools
-- (migration 122), and the bracket-wiring column conventions already used by
-- tournament_matches (migration 112) — next_matchup_id/next_matchup_slot and
-- loser_next_matchup_id/loser_next_matchup_slot mirror next_match_id/
-- next_match_slot and loser_next_match_id/loser_next_match_slot exactly, one
-- level up (teams instead of pairs).
--
-- Mandatory: tournament_team_matchups MUST be added to the supabase_realtime
-- publication in this same migration (migration 117's postmortem, repeated in
-- 122/134's own comments) — a table left out silently drops realtime events
-- with no error.
-- ============================================================================

create table if not exists public.tournament_team_matchups (
  id text primary key,
  tournament_id text not null references public.tournaments(id) on delete cascade,
  division_id text not null references public.tournament_divisions(id) on delete cascade,
  organizer_id text not null,                            -- denormalized tournaments.owner_id

  round integer not null default 1,
  bracket_position integer,

  team_a_id text references public.tournament_teams(id),  -- nullable: TBD until a prior round resolves
  team_b_id text references public.tournament_teams(id),
  team_a_wins integer not null default 0,
  team_b_wins integer not null default 0,
  pairs_per_matchup integer not null,                      -- stored, not derived — see plan §1
  winner_team_id text references public.tournament_teams(id),

  status text not null default 'pending',
  next_matchup_id text references public.tournament_team_matchups(id),
  next_matchup_slot text,
  bracket_side text,                                        -- "bronze" tag, mirrors tournament_matches.bracket_side
  loser_next_matchup_id text references public.tournament_team_matchups(id),
  loser_next_matchup_slot text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Only 3 states are ever written by the app: "pending" (teams may still be TBD,
-- or both known but majority not yet reached), "completed" (majority reached),
-- "bye" (team-level bye auto-advance). "IN PROGRESS" in the UI is derived from
-- child pair-match statuses, not stored. "cancelled" never applies to a
-- MATCHUP — only individual pair matches get cancelled (tournament_matches.status
-- already supports that value).
alter table public.tournament_team_matchups
  drop constraint if exists tournament_team_matchups_status_check;
alter table public.tournament_team_matchups
  add constraint tournament_team_matchups_status_check
  check (status in ('pending','completed','bye'));

alter table public.tournament_team_matchups
  drop constraint if exists tournament_team_matchups_next_slot_check;
alter table public.tournament_team_matchups
  add constraint tournament_team_matchups_next_slot_check
  check (next_matchup_slot in ('A','B') or next_matchup_slot is null);

alter table public.tournament_team_matchups
  drop constraint if exists tournament_team_matchups_loser_next_slot_check;
alter table public.tournament_team_matchups
  add constraint tournament_team_matchups_loser_next_slot_check
  check (loser_next_matchup_slot in ('A','B') or loser_next_matchup_slot is null);

create index if not exists tournament_team_matchups_division_round_idx
  on public.tournament_team_matchups (division_id, round);
create index if not exists tournament_team_matchups_organizer_idx
  on public.tournament_team_matchups (organizer_id);

alter table public.tournament_team_matchups enable row level security;

drop policy if exists tournament_team_matchups_select on public.tournament_team_matchups;
drop policy if exists tournament_team_matchups_insert on public.tournament_team_matchups;
drop policy if exists tournament_team_matchups_update on public.tournament_team_matchups;
drop policy if exists tournament_team_matchups_delete on public.tournament_team_matchups;

create policy tournament_team_matchups_select on public.tournament_team_matchups
  for select to authenticated using (true);

create policy tournament_team_matchups_insert on public.tournament_team_matchups
  for insert to authenticated with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

create policy tournament_team_matchups_update on public.tournament_team_matchups
  for update to authenticated
  using (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id))
  with check (organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id));

create policy tournament_team_matchups_delete on public.tournament_team_matchups
  for delete to authenticated using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
  );

-- team_matchup_id: on delete cascade (NOT set null, unlike tournament_registrations.team_id)
-- — if a team-matchup shell is ever deleted, its child pair matches are meaningless
-- orphans and must go with it. pair_slot: 1-based display position ("Pair 1 vs Pair 1"),
-- purely for ordering. Both stay null forever for every non-team_elimination match.
alter table public.tournament_matches
  add column if not exists team_matchup_id text references public.tournament_team_matchups(id) on delete cascade;
alter table public.tournament_matches
  add column if not exists pair_slot integer;
create index if not exists tournament_matches_team_matchup_idx
  on public.tournament_matches (team_matchup_id);

alter publication supabase_realtime add table public.tournament_team_matchups;
