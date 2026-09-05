-- Deny by default. Authenticated clients may SELECT rows they are members of.
-- All official tournament writes go through the API + apply_official_writes.

create or replace function private.is_tournament_member(tid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournament_members m
    where m.tournament_id = tid
      and m.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_tournament_member(uuid) from public, anon;
grant execute on function private.is_tournament_member(uuid) to authenticated, service_role;

create or replace function private.match_tournament_id(mid uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select tournament_id from public.matches where id = mid;
$$;

revoke all on function private.match_tournament_id(uuid) from public, anon;
grant execute on function private.match_tournament_id(uuid) to authenticated, service_role;

alter table public.profiles enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_members enable row level security;
alter table public.divisions enable row level security;
alter table public.persons enable row level security;
alter table public.teams enable row level security;
alter table public.team_members enable row level security;
alter table public.participants enable row level security;
alter table public.participant_members enable row level security;
alter table public.courts enable row level security;
alter table public.stages enable row level security;
alter table public.matches enable row level security;
alter table public.match_participants enable row level security;
alter table public.score_events enable row level security;
alter table public.match_results enable row level security;
alter table public.court_assignments enable row level security;
alter table public.umpire_assignments enable row level security;
alter table public.command_receipts enable row level security;
alter table public.audit_logs enable row level security;

alter table public.profiles force row level security;
alter table public.tournaments force row level security;
alter table public.tournament_members force row level security;
alter table public.divisions force row level security;
alter table public.persons force row level security;
alter table public.teams force row level security;
alter table public.team_members force row level security;
alter table public.participants force row level security;
alter table public.participant_members force row level security;
alter table public.courts force row level security;
alter table public.stages force row level security;
alter table public.matches force row level security;
alter table public.match_participants force row level security;
alter table public.score_events force row level security;
alter table public.match_results force row level security;
alter table public.court_assignments force row level security;
alter table public.umpire_assignments force row level security;
alter table public.command_receipts force row level security;
alter table public.audit_logs force row level security;

-- profiles: self + fellow tournament members
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or exists (
      select 1
      from public.tournament_members mine
      join public.tournament_members theirs on theirs.tournament_id = mine.tournament_id
      where mine.user_id = (select auth.uid())
        and theirs.user_id = profiles.id
    )
  );

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy tournaments_select on public.tournaments
  for select to authenticated
  using (private.is_tournament_member(id));

create policy tournament_members_select on public.tournament_members
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy divisions_select on public.divisions
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy persons_select on public.persons
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy teams_select on public.teams
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy team_members_select on public.team_members
  for select to authenticated
  using (
    exists (
      select 1 from public.teams t
      where t.id = team_members.team_id
        and private.is_tournament_member(t.tournament_id)
    )
  );

create policy participants_select on public.participants
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy participant_members_select on public.participant_members
  for select to authenticated
  using (
    exists (
      select 1 from public.participants p
      where p.id = participant_members.participant_id
        and private.is_tournament_member(p.tournament_id)
    )
  );

create policy courts_select on public.courts
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy stages_select on public.stages
  for select to authenticated
  using (
    exists (
      select 1 from public.divisions d
      where d.id = stages.division_id
        and private.is_tournament_member(d.tournament_id)
    )
  );

create policy matches_select on public.matches
  for select to authenticated
  using (private.is_tournament_member(tournament_id));

create policy match_participants_select on public.match_participants
  for select to authenticated
  using (private.is_tournament_member(private.match_tournament_id(match_id)));

create policy score_events_select on public.score_events
  for select to authenticated
  using (private.is_tournament_member(private.match_tournament_id(match_id)));

create policy match_results_select on public.match_results
  for select to authenticated
  using (private.is_tournament_member(private.match_tournament_id(match_id)));

create policy court_assignments_select on public.court_assignments
  for select to authenticated
  using (private.is_tournament_member(private.match_tournament_id(match_id)));

create policy umpire_assignments_select on public.umpire_assignments
  for select to authenticated
  using (private.is_tournament_member(private.match_tournament_id(match_id)));

create policy command_receipts_select on public.command_receipts
  for select to authenticated
  using (actor_id = (select auth.uid()));

create policy audit_logs_select on public.audit_logs
  for select to authenticated
  using (
    tournament_id is not null
    and private.is_tournament_member(tournament_id)
  );

grant usage on schema public to authenticated, anon;
grant select on all tables in schema public to authenticated;
grant update (display_name, updated_at) on public.profiles to authenticated;

revoke insert, delete on all tables in schema public from anon, authenticated;
revoke update on public.tournaments from anon, authenticated;
revoke update on public.tournament_members from anon, authenticated;
revoke update on public.divisions from anon, authenticated;
revoke update on public.persons from anon, authenticated;
revoke update on public.teams from anon, authenticated;
revoke update on public.team_members from anon, authenticated;
revoke update on public.participants from anon, authenticated;
revoke update on public.participant_members from anon, authenticated;
revoke update on public.courts from anon, authenticated;
revoke update on public.stages from anon, authenticated;
revoke update on public.matches from anon, authenticated;
revoke update on public.match_participants from anon, authenticated;
revoke update on public.score_events from anon, authenticated;
revoke update on public.match_results from anon, authenticated;
revoke update on public.court_assignments from anon, authenticated;
revoke update on public.umpire_assignments from anon, authenticated;
revoke update on public.command_receipts from anon, authenticated;
revoke update on public.audit_logs from anon, authenticated;
