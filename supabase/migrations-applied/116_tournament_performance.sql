-- STATUS: APPLIED (version 20260804084745, confirmed live via list_migrations, 2026-08-04).
--
-- ============================================================================
-- 116: Performance cleanup for the tournament tables added in 112-115, per
--      get_advisors (performance) run after those migrations went live.
-- ============================================================================
-- Two issues, both purely non-functional (no behavior/permission change):
--
-- 1. auth_rls_initplan: the tournaments/tournament_divisions/
--    tournament_registrations/tournament_matches policies (112) call
--    auth.uid() directly, so Postgres re-evaluates it once per row instead of
--    once per query. 107_rls_perf_initplan_cleanup.sql already fixed this
--    mechanically for every policy that existed at the time via a regex
--    sweep of pg_policies; the tournament policies didn't exist yet, so they
--    were never covered. Re-running the identical dynamic sweep (safe: it
--    only rewrites policies whose qual/with_check still contains a bare
--    auth.uid()/role()/jwt() call, so already-fixed policies are untouched)
--    picks up exactly the new ones.
-- 2. unindexed_foreign_keys: tournament_matches has 6 FK columns and
--    tournament_registrations has 1 with no covering index, which makes
--    cascade deletes (tournaments -> divisions -> registrations/matches) and
--    lookups by these columns do sequential scans as data grows. Safe to
--    re-run (if not exists).
--
-- Does not touch, alter, or delete any existing row, table, or column.
-- ============================================================================

do $$
declare
  r record;
  new_qual text;
  new_check text;
  sql text;
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and tablename in ('tournaments','tournament_divisions','tournament_registrations','tournament_matches')
      and (qual ~ 'auth\.(uid|role|jwt)\(\)' or with_check ~ 'auth\.(uid|role|jwt)\(\)')
  loop
    new_qual := r.qual;
    new_check := r.with_check;
    if new_qual is not null then
      new_qual := regexp_replace(new_qual, 'auth\.(uid|role|jwt)\(\)', '(select auth.\1())', 'g');
    end if;
    if new_check is not null then
      new_check := regexp_replace(new_check, 'auth\.(uid|role|jwt)\(\)', '(select auth.\1())', 'g');
    end if;

    sql := format('alter policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    if new_qual is not null then
      sql := sql || format(' using (%s)', new_qual);
    end if;
    if new_check is not null then
      sql := sql || format(' with check (%s)', new_check);
    end if;
    execute sql;
  end loop;
end $$;

create index if not exists tournament_matches_tournament_idx on public.tournament_matches (tournament_id);
create index if not exists tournament_matches_court_idx on public.tournament_matches (court_id);
create index if not exists tournament_matches_registration_a_idx on public.tournament_matches (registration_a_id);
create index if not exists tournament_matches_registration_b_idx on public.tournament_matches (registration_b_id);
create index if not exists tournament_matches_next_match_idx on public.tournament_matches (next_match_id);
create index if not exists tournament_matches_loser_next_match_idx on public.tournament_matches (loser_next_match_id);
create index if not exists tournament_matches_completed_match_idx on public.tournament_matches (completed_match_id);

create index if not exists tournament_registrations_tournament_idx on public.tournament_registrations (tournament_id);
