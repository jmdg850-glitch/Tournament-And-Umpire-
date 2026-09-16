-- Fixes a real gap discovered while smoke-testing 0012/0013 against a live
-- anon key: this Supabase project's baseline role setup (predating every
-- migration in this repo) already grants anon(and authenticated) a broad,
-- table-level SELECT on every table in schema public — nothing in
-- 0004_rls.sql ever revoked SELECT itself, only INSERT/UPDATE/DELETE, since
-- forced RLS with authenticated-only policies was already sufficient to
-- block anon (zero visible rows) without needing to touch that baseline
-- grant. But GRANT SELECT (col1, col2) is additive, not restrictive: it
-- layers a narrower grant on top without ever revoking the pre-existing
-- broader one, so 0012/0013's column-restricted grants on tournaments
-- (excluding owner_id) and persons (excluding user_id) never actually took
-- effect — confirmed live: an anon request for tournaments?select=owner_id
-- or persons?select=user_id on an is_public row returned real data.
-- Revoking the baseline table-level SELECT on just these two tables first
-- makes the column-restricted grant the *only* SELECT anon has, which is
-- what was always intended. No other table needs this (every other
-- anon-readable table in 0012 has no sensitive columns, so their existing
-- full-table grants are correct as they stand).

revoke select on public.tournaments from anon;
grant select (id, name, sport, status, slug, created_at) on public.tournaments to anon;

revoke select on public.persons from anon;
grant select (id, tournament_id, display_name) on public.persons to anon;
