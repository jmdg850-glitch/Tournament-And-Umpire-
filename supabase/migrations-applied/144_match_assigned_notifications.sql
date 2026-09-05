-- 144: match_notification_events — idempotency for the new "match_assigned" notification type.
--
-- Players placed into a tournament match currently receive no notification at all — the
-- `notifications` table/Cloud.sendNotification/inbox pipeline already exists and works (see
-- umpire_assigned), it's just never called for match assignment.
--
-- NOTE: notifications RLS is NOT touched here. It looks permissive in the original
-- 04_multi_organizer.sql migration file (using(true)), but that was already superseded live by
-- 104_policies_mixmatch_notifications.sql (applied 2026-07-28), confirmed via direct query
-- against the live database before writing this migration: select/update/delete are already
-- `user_id = auth.uid()::text or is_admin()`, and insert is already
-- `coalesce(actor_id, auth.uid()::text) = auth.uid()::text or is_admin()`. Re-applying a plain
-- `user_id = auth.uid()::text` policy here would have been a REGRESSION (dropping the is_admin()
-- bypass), so that part of the original plan is intentionally skipped. Every new match_assigned
-- notification write must still set `actor_id` to the caller's own id (matching the existing
-- umpire_assigned call site's pattern) or the insert will be rejected by the existing policy.
--
-- match_notification_events: claims a (match_id, user_id, type) triple exactly once, so a
-- schedule regeneration, realtime echo, or repeated bracket-advancement pass never produces a
-- duplicate "you've been added to a match" notification for the same match+player. Deliberately
-- a separate table rather than a unique index on notifications(match_id,user_id,type) — other
-- existing notification types on that table (match_organizer_invite) legitimately recur for the
-- same match+user (invite, decline, re-invite), so a shared uniqueness constraint there would
-- silently break that instead of just gating this one new type. Does not touch, alter, or
-- delete any existing table, column, or row. Safe to re-run.
create table if not exists public.match_notification_events (
  match_id text not null,
  user_id text not null,
  type text not null,
  created_at timestamptz not null default now(),
  primary key (match_id, user_id, type)
);

alter table public.match_notification_events enable row level security;

-- Low-sensitivity claim rows (just ids, no content) — same authenticated-only permissive
-- pattern the rest of this schema uses for non-owner-scoped tables.
create policy "mne_select" on public.match_notification_events
  for select to authenticated using (true);
create policy "mne_insert" on public.match_notification_events
  for insert to authenticated with check (true);
