-- Fix: public.profiles was the only domain table where 0004_rls.sql granted a
-- narrow column UPDATE (display_name, updated_at) to authenticated without first
-- revoking the broader Supabase-default UPDATE grant, unlike every other table.
-- Live-confirmed impact: authenticated users could UPDATE any column on their own
-- profiles row (RLS still row-scopes to auth.uid(), and platform_role stays blocked
-- by the private.protect_platform_role() trigger), including created_at, which was
-- intended to be immutable. This revokes the broad grant and re-asserts the same
-- narrow column grant, matching the pattern already used for every other table.

revoke update on public.profiles from anon, authenticated;
grant update (display_name, updated_at) on public.profiles to authenticated;
