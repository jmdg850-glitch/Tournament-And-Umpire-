-- Public spectator "Live" page: an opt-in (default off), read-only, anon-role
-- view of a single tournament's live matches/scores/court/bracket/standings.
-- Mirrors the existing authenticated-member SELECT policies (0004_rls.sql,
-- 0006_court_stations.sql) 1:1, scoped by a new is_public flag instead of
-- tournament membership. Deliberately excludes profiles, tournament_members,
-- court_devices, court_pairing_grants, umpire_assignments, score_events,
-- team_members, command_receipts, audit_logs — none of these are needed by
-- the spectator page and several carry staff/device-identifying data that
-- must never be anon-readable. tournaments itself gets no anon grant at all;
-- the public_tournaments view is the only path in, and only exposes columns
-- safe for a spectator (no owner_id, no organizer-authored settings jsonb).

alter table public.tournaments add column is_public boolean not null default false;
alter table public.tournaments add column slug text unique;

create or replace function private.tournament_is_public(tid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournaments t
    where t.id = tid
      and t.is_public = true
  );
$$;

revoke all on function private.tournament_is_public(uuid) from public, anon;
grant execute on function private.tournament_is_public(uuid) to anon, authenticated, service_role;

-- match_tournament_id already exists (0004_rls.sql) but was only ever granted
-- to authenticated/service_role; the new match-scoped anon policies below
-- need to call it too.
grant execute on function private.match_tournament_id(uuid) to anon;

create or replace view public.public_tournaments as
  select id, name, sport, status, slug, created_at
  from public.tournaments
  where is_public = true;

revoke all on public.public_tournaments from public, anon, authenticated;
grant select on public.public_tournaments to anon;

create policy divisions_select_anon on public.divisions
  for select to anon
  using (private.tournament_is_public(tournament_id));

create policy persons_select_anon on public.persons
  for select to anon
  using (private.tournament_is_public(tournament_id));

create policy teams_select_anon on public.teams
  for select to anon
  using (private.tournament_is_public(tournament_id));

create policy participants_select_anon on public.participants
  for select to anon
  using (private.tournament_is_public(tournament_id));

create policy participant_members_select_anon on public.participant_members
  for select to anon
  using (
    exists (
      select 1 from public.participants p
      where p.id = participant_members.participant_id
        and private.tournament_is_public(p.tournament_id)
    )
  );

create policy courts_select_anon on public.courts
  for select to anon
  using (private.tournament_is_public(tournament_id));

create policy stages_select_anon on public.stages
  for select to anon
  using (
    exists (
      select 1 from public.divisions d
      where d.id = stages.division_id
        and private.tournament_is_public(d.tournament_id)
    )
  );

create policy matches_select_anon on public.matches
  for select to anon
  using (private.tournament_is_public(tournament_id));

create policy match_participants_select_anon on public.match_participants
  for select to anon
  using (private.tournament_is_public(private.match_tournament_id(match_id)));

create policy match_results_select_anon on public.match_results
  for select to anon
  using (private.tournament_is_public(private.match_tournament_id(match_id)));

create policy court_assignments_select_anon on public.court_assignments
  for select to anon
  using (private.tournament_is_public(private.match_tournament_id(match_id)));

grant select on public.divisions to anon;
grant select on public.teams to anon;
grant select on public.participants to anon;
grant select on public.participant_members to anon;
grant select on public.courts to anon;
grant select on public.matches to anon;
grant select on public.match_participants to anon;
grant select on public.stages to anon;
grant select on public.match_results to anon;
grant select on public.court_assignments to anon;

-- persons: column-restricted — user_id (an optional link toward an auth
-- identity) is deliberately excluded even though it would otherwise be an
-- opaque, unresolvable uuid (profiles stays fully unexposed to anon).
grant select (id, tournament_id, display_name) on public.persons to anon;

-- insert/update/delete on all these tables (and tournaments itself) are
-- already revoked from anon by 0004_rls.sql's blanket
-- `revoke insert, delete on all tables in schema public from anon, authenticated`
-- plus its per-table `revoke update ... from anon, authenticated` — every
-- table above already existed at that migration, so no further revokes are
-- needed here; only the new SELECT grants/policies above are additive.

create index tournaments_slug_idx on public.tournaments (slug);
create index tournaments_is_public_idx on public.tournaments (is_public) where is_public = true;
