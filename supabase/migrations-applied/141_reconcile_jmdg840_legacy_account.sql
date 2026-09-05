-- ============================================================================
-- 141: one-time reconciliation — repoint jmdg840@gmail.com's legacy account id
-- ============================================================================
-- Legacy accounts row id='1782974982310_fa8p' (JM DE GUZMAN, created
-- 2026-07-02) and the account's current Supabase Auth session
-- (auth.users.id='903379d3-41c2-4274-82c0-07004bde9367') resolve to the same
-- verified email. Migration 140's ensure_my_account() will perform this exact
-- accounts.id re-key automatically on next login, but the 28 historical rows
-- below (notifications/friend_requests/events/event_attendees/
-- mixmatch_players/courts — none FK-declared to accounts.id, none touched by
-- 140's RPC) would otherwise be left pointing at an id that no longer exists
-- in accounts. One-time, reviewed migration — checked live beforehand for
-- unique-constraint conflicts (none: event_attendees(event_id,user_id) is the
-- only relevant unique constraint among these tables, and no overlap exists).
-- ============================================================================

-- event_attendees has a BEFORE UPDATE trigger (trg_pin_event_attendees_identity)
-- that raises on any event_id/user_id change on an existing row — a general
-- guard against accidentally reassigning attendee identity, not meant to
-- block this one legitimate reconciliation. Disabled only for the single
-- targeted UPDATE below, then immediately re-enabled.
alter table public.event_attendees disable trigger trg_pin_event_attendees_identity;

do $$
declare
  legacy_id text := '1782974982310_fa8p';
  new_id text := '903379d3-41c2-4274-82c0-07004bde9367';
begin
  update public.accounts set id = new_id where id = legacy_id;
  update public.notifications set actor_id = new_id where actor_id = legacy_id;
  update public.friend_requests set from_id = new_id where from_id = legacy_id;
  update public.friend_requests set to_id = new_id where to_id = legacy_id;
  update public.events set owner_id = new_id where owner_id = legacy_id;
  update public.event_attendees set user_id = new_id where user_id = legacy_id;
  update public.mixmatch_players set organizer_id = new_id where organizer_id = legacy_id;
  update public.courts set organizer_id = new_id where organizer_id = legacy_id;
end $$;

alter table public.event_attendees enable trigger trg_pin_event_attendees_identity;
