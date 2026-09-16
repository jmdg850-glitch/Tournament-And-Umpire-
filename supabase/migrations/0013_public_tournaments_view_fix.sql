-- Replaces 0012's public_tournaments view: Supabase's security linter
-- correctly flags any view that relies on its owner's RLS-bypassing
-- privileges (the "Security Definer View" advisory) as needing explicit
-- review, since it's a common accidental-exposure footgun in general. In
-- this specific case it was deliberate and safe (the view's own
-- `where is_public = true` clause was the sole gate, no sensitive columns
-- selected) — but the same result is achievable without an owner-privilege
-- view at all: a column-restricted GRANT plus a normal RLS policy directly
-- on tournaments, exactly the pattern already used for persons in 0012.
-- That's simpler, keeps every anon-readable table on the same mechanism,
-- and clears the lint cleanly instead of needing it suppressed.

drop view if exists public.public_tournaments;

create policy tournaments_select_anon on public.tournaments
  for select to anon
  using (is_public = true);

grant select (id, name, sport, status, slug, created_at) on public.tournaments to anon;
