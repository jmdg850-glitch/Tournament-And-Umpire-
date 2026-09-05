-- STATUS: APPLIED (version 20260728090337, confirmed live via list_migrations, 2026-07-28).
--
-- Phase 17 of the Claude Code production-debug pass. Direct pg_policies audit (not just reading
-- local migration files, which is what let this go unnoticed) found clubs_update / posts_update /
-- matches_insert had no real authorization (USING/WITH CHECK true) — any authenticated user could
-- rewrite any club, rewrite any other user's post, or fabricate arbitrary completed-match history
-- rows. This closes all three, plus adds toggle_post_like() so restricting posts_update to the
-- author doesn't break the "like a post" feature for everyone else.

-- 1. clubs: only the owner, a club admin (data->'adminIds'), or an app admin may update.
drop policy if exists clubs_update on public.clubs;
create policy clubs_update on public.clubs for update
  to authenticated
  using ((owner_id = auth.uid()::text) or (data->'adminIds' ? auth.uid()::text) or is_admin())
  with check ((owner_id = auth.uid()::text) or (data->'adminIds' ? auth.uid()::text) or is_admin());

-- 2. matches (completed-match history): only a participant-side organizer/co-organizer or
--    an app admin may insert a record, mirroring how live_matches already ties writes to
--    organizerId/organizerIds. Legacy rows with no organizerId stay open (matches existing
--    live_matches convention for pre-existing data).
drop policy if exists matches_insert on public.matches;
create policy matches_insert on public.matches for insert
  to authenticated
  with check (
    ((data->>'organizerId') is null)
    or (data->>'organizerId' = auth.uid()::text)
    or (data->'organizerIds' ? auth.uid()::text)
    or is_admin()
  );

-- 3. posts: only the author or an app admin may directly update a post row (text/image/etc).
--    Liking someone else's post is a real feature that needs a narrower, controlled path —
--    see toggle_post_like() below, which is the only way a non-author can still touch a row.
drop policy if exists posts_update on public.posts;
create policy posts_update on public.posts for update
  to authenticated
  using ((author_id = auth.uid()::text) or is_admin())
  with check ((author_id = auth.uid()::text) or is_admin());

-- 4. toggle_post_like: lets any authenticated user toggle their own id in a post's `likes`
-- column (stored as JSON text) without granting general UPDATE rights on that post's other
-- columns. Returns the new likes array as a JSON string (same shape the client already reads).
-- src/lib/cloud.js's likePost() and src/App.jsx's likePost() were updated in the same phase to
-- call this RPC instead of a raw posts.update().
create or replace function public.toggle_post_like(post_id text)
returns text
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  me text := auth.uid()::text;
  cur jsonb;
  result jsonb;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;

  select likes into cur from public.posts where id = post_id;
  if not found then
    raise exception 'post not found';
  end if;
  cur := coalesce(cur::jsonb, '[]'::jsonb);

  if cur ? me then
    select coalesce(jsonb_agg(v), '[]'::jsonb) into result from jsonb_array_elements_text(cur) v where v <> me;
  else
    result := cur || to_jsonb(me);
  end if;

  update public.posts set likes = result::text where id = post_id;
  return result::text;
end;
$$;

revoke all on function public.toggle_post_like(text) from public;
grant execute on function public.toggle_post_like(text) to authenticated;
