-- STATUS: APPLIED (version 20260728090831, confirmed live via list_migrations, 2026-07-28).
--
-- Phase 18 of the Claude Code production-debug pass. Closes the reassignment/lockout vector left
-- open by live_matches_update and event_attendees_update's WITH CHECK(true). Plain RLS can only
-- see the NEW row, not compare against OLD, so this needs BEFORE UPDATE triggers rather than a
-- tighter policy expression. The app itself never legitimately changes these fields on an UPDATE
-- (verified against cloud.js's actual write paths, and functionally tested against the live DB
-- with a self-cleaning transaction before/after this was written), so this closes a real gap
-- without touching any real flow.

-- live_matches: organizerId is set once at match creation (startMatch()) and never reassigned
-- by the app afterward — only organizerIds (the co-organizer array) grows via accepted invites.
-- Block an already-legitimate organizer/co-organizer from reassigning or clearing organizerId,
-- which would otherwise hand control to someone else or drop the row into the "legacy, open to
-- everyone" branch of canControlMatch().
create or replace function public.pin_live_matches_organizer_id()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if (old.data->>'organizerId') is not null
     and (new.data->>'organizerId') is distinct from (old.data->>'organizerId') then
    raise exception 'organizerId cannot be reassigned on an existing live_matches row';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pin_live_matches_organizer_id on public.live_matches;
create trigger trg_pin_live_matches_organizer_id
  before update on public.live_matches
  for each row execute function public.pin_live_matches_organizer_id();

-- event_attendees: event_id/user_id are the row's identity (joinEvent's upsert conflict target
-- is exactly (event_id,user_id); updateAttendee/setAttendeeStatus always filter .eq() on both
-- and never include them in the SET payload) — no legitimate flow ever changes either post-insert.
create or replace function public.pin_event_attendees_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if new.event_id is distinct from old.event_id or new.user_id is distinct from old.user_id then
    raise exception 'event_id/user_id cannot change on an existing event_attendees row';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_pin_event_attendees_identity on public.event_attendees;
create trigger trg_pin_event_attendees_identity
  before update on public.event_attendees
  for each row execute function public.pin_event_attendees_identity();
