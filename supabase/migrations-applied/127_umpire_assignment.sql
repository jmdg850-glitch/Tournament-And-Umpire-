-- STATUS: APPLIED (version 20260807094017, confirmed live via list_migrations, 2026-08-07).
-- ============================================================================
-- 127: Tournament Umpire Assignment — umpire_id/name/timestamps on
--      tournament_matches, plus RLS widening on tournament_matches and
--      live_matches so the assigned umpire (not just the organizer/
--      co-organizer/admin) can write score/status updates.
-- ============================================================================
-- Additive only. umpire_id/umpire_name/umpire_assigned_at/umpire_last_seen_at
-- are plain nullable columns — every existing tournament_matches row is
-- unaffected until an organizer explicitly assigns an umpire. Mirrors how
-- referee_name (migration 121) already lives on this same row as a separate,
-- untouched freeform field — umpire is a distinct, additive concept, not a
-- replacement.
--
-- Enforcement lives at the RLS layer, not just the UI (explicit requirement):
-- tournament_matches_update gets `umpire_id = auth.uid()` ORed into its
-- existing predicate (organizer_id/is_admin()/is_co_organizer_of are
-- untouched). live_matches has no umpire concept of its own — while a
-- tournament match is live, its score lives in a live_matches row identified
-- by data->>'tournamentMatchId' (already embedded there by
-- startTournamentMatch/buildLiveMatchRow today), so a new
-- is_assigned_umpire_for_tournament_match() function (security invoker,
-- mirroring is_co_organizer_of's shape exactly, since tournament_matches
-- already has open `select`) is used to widen live_matches_insert/
-- live_matches_update the same way. Every existing predicate on all three
-- policies is preserved unchanged, only ORed with the new umpire check, so
-- existing access is strictly a superset of before this migration.
-- ============================================================================

alter table public.tournament_matches
  add column if not exists umpire_id text references public.accounts(id);
alter table public.tournament_matches
  add column if not exists umpire_name text;
alter table public.tournament_matches
  add column if not exists umpire_assigned_at timestamptz;
alter table public.tournament_matches
  add column if not exists umpire_last_seen_at timestamptz;

create index if not exists tournament_matches_umpire_idx on public.tournament_matches (umpire_id);

-- ----------------------------------------------------------------------------
-- is_assigned_umpire_for_tournament_match: used by live_matches_insert/update
-- below, since live_matches itself carries no umpire concept — only
-- tournament_matches does. security invoker (not definer) because
-- tournament_matches already grants `select using (true)` to authenticated,
-- so the invoker's own RLS view is already sufficient (same reasoning as
-- is_co_organizer_of, which is also security invoker).
-- ----------------------------------------------------------------------------
create or replace function public.is_assigned_umpire_for_tournament_match(p_tournament_match_id text)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.tournament_matches tm
    where tm.id = p_tournament_match_id and tm.umpire_id = auth.uid()::text
  );
$$;
grant execute on function public.is_assigned_umpire_for_tournament_match(text) to authenticated;

-- ----------------------------------------------------------------------------
-- tournament_matches_update: widen to also allow the assigned umpire.
-- ----------------------------------------------------------------------------
drop policy if exists tournament_matches_update on public.tournament_matches;
create policy tournament_matches_update on public.tournament_matches
  for update to authenticated
  using (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
    or umpire_id = auth.uid()::text
  )
  with check (
    organizer_id = auth.uid()::text or public.is_admin() or public.is_co_organizer_of(organizer_id)
    or umpire_id = auth.uid()::text
  );

-- ----------------------------------------------------------------------------
-- live_matches_insert / live_matches_update: widen to also allow the assigned
-- umpire, looked up via data->>'tournamentMatchId'.
-- ----------------------------------------------------------------------------
drop policy if exists live_matches_insert on public.live_matches;
create policy live_matches_insert on public.live_matches
  for insert to authenticated
  with check (
    coalesce(data->>'organizerId', auth.uid()::text) = auth.uid()::text
    or public.is_admin()
    or (data->>'tournamentMatchId' is not null and public.is_assigned_umpire_for_tournament_match(data->>'tournamentMatchId'))
  );

drop policy if exists live_matches_update on public.live_matches;
create policy live_matches_update on public.live_matches
  for update to authenticated
  using (
    data->>'organizerId' is null                       -- legacy rows: fail open
    or data->>'organizerId' = auth.uid()::text
    or data->'organizerIds' ? auth.uid()::text          -- accepted co-organizers
    or public.is_admin()
    or (data->>'tournamentMatchId' is not null and public.is_assigned_umpire_for_tournament_match(data->>'tournamentMatchId'))
  )
  with check (true);
