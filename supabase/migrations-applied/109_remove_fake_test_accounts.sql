-- STATUS: NOT YET APPLIED — Supabase MCP was unavailable this session, so this could not be run
-- or verified directly against the live "NextG" project (qfyfomiqxouqftrgganh). Run manually via
-- the Supabase dashboard's SQL editor (or a future session with working MCP access), reviewing
-- the SELECT preview output BEFORE running the DELETE section.
--
-- Bug #2 from the "Bug Fix Pass" request (see plan history / SECURITY.md-adjacent context):
-- fake/test accounts ("Admin", "repro owner test", etc.) appear in production user lists.
-- Investigation confirmed this is NOT a client-code bug — no mock/seed data exists anywhere in
-- src/. Cloud.fetchDirectory() (src/lib/cloud.js) displays whatever rows exist in public.players
-- unfiltered. The root cause is leftover live rows, almost certainly originating from the
-- ADMIN_ACCOUNT client-side backdoor (name:"Admin", email:"admin@picklelive.com") that was
-- removed in Phase 10 (see git history) — every login upserted a players/accounts row via
-- Cloud.upsertProfile, so using that backdoor before its removal left a permanent row behind.
--
-- Confirmed by the user: admin@picklelive.com is one such fake account. Add further WHERE
-- clauses / a second block below if more fake accounts (e.g. "repro owner test") are identified.

-- ============================================================================
-- STEP 1 — PREVIEW ONLY. Run this first and read the output before proceeding.
-- Confirms exactly which rows would be affected, and surfaces anything referencing them
-- elsewhere (clubs owned, posts authored, matches organized) so a real user's content is never
-- accidentally caught in a blanket delete.
-- ============================================================================
select 'accounts' as table_name, id, name, email, role, created_at from public.accounts
where email = 'admin@picklelive.com'
union all
select 'players' as table_name, id, name, email, null as role, updated_at from public.players
where email = 'admin@picklelive.com';

-- Check for any content this account may have created, so you can decide separately whether
-- that content is also test data or something to reassign/preserve. This migration does NOT
-- delete any of the rows below automatically — identity cleanup only.
select 'clubs owned' as ref, id, name from public.clubs
where owner_id = (select id from public.accounts where email = 'admin@picklelive.com');
select 'posts authored' as ref, id, text from public.posts
where author_id = (select id from public.accounts where email = 'admin@picklelive.com');
select 'matches (history) as participant' as ref, id from public.matches
where participants like '%'||(select id from public.accounts where email = 'admin@picklelive.com')||'%';

-- ============================================================================
-- STEP 2 — THE ACTUAL DELETE. Only run after confirming Step 1's output looks correct
-- (i.e. this really is the fake/test row and not a real user who happens to share a pattern).
-- Scoped strictly to email match — never a name/role guess alone, to avoid catching a real user.
-- ============================================================================
delete from public.players where email = 'admin@picklelive.com';
delete from public.accounts where email = 'admin@picklelive.com';

-- ============================================================================
-- STEP 3 — Supabase Auth user (separate system, not touched by the SQL above).
-- If admin@picklelive.com also has a real Supabase Auth account (check Authentication → Users
-- in the dashboard), delete it there too via the Auth admin UI — deleting via raw SQL against
-- auth.users is not the recommended path and isn't included here.
-- ============================================================================
