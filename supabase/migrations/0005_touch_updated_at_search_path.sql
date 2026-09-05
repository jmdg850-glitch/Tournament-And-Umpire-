-- Pin search_path on private.touch_updated_at (security advisor: mutable search_path).
-- Also prevent duplicate Team Elimination child pair matches for the same parent slot.

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create unique index if not exists matches_parent_pair_slot_uidx
  on public.matches (parent_match_id, pair_slot)
  where parent_match_id is not null and pair_slot is not null;
