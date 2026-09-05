-- STATUS: APPLIED (version 20260728091137, confirmed live via list_migrations, 2026-07-28).
--
-- Phase 27 of the Claude Code production-debug pass. Mechanical RLS performance cleanup — wraps
-- every direct auth.uid()/auth.role()/auth.jwt() call in every public-schema policy with
-- (select ...), Supabase's documented pattern to avoid re-evaluating the function once per row
-- instead of once per query (get_advisors' auth_rls_initplan lint, 57 policies flagged before
-- this ran). Purely a rewrite of the policy expression text — the boolean logic, and therefore
-- who can read/write which rows, is unchanged; verified via get_advisors + pg_policies + spot
-- checks against clubs/live_matches/players after this ran, and confirmed all 57 warnings cleared.
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
