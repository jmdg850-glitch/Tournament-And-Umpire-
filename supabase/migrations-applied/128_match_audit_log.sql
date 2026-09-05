-- STATUS: APPLIED (version 20260807094042, confirmed live via list_migrations, 2026-08-07).
-- ============================================================================
-- 128: match_audit_log — durable, cross-device audit trail for umpire
--      assignment / coin toss / match lifecycle events.
-- ============================================================================
-- New table only. src/lib/log.js is a local-device-only ring buffer (confirmed
-- by direct read — LS-backed, never touches Supabase) and cannot serve as a
-- durable, cross-device-visible audit trail, so this is genuinely new
-- infrastructure, not a duplicate of anything existing.
--
-- Append-only, same precedent as the existing `matches` table (completed-match
-- history): readable by the match's organizer + assigned umpire + admin only,
-- insertable by the same three parties (each records their own actions), no
-- update/delete policy for anyone but admin — an audit log must never be
-- editable by a non-admin party, including the person it might be recording.
-- ============================================================================

create table if not exists public.match_audit_log (
  id text primary key,
  tournament_match_id text not null references public.tournament_matches(id) on delete cascade,
  live_match_id text,
  organizer_id text not null,     -- denormalized from tournament_matches.organizer_id at write time, for RLS scoping
  actor_id text not null,
  actor_name text,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists match_audit_log_tournament_match_idx on public.match_audit_log (tournament_match_id);
create index if not exists match_audit_log_organizer_idx on public.match_audit_log (organizer_id);

alter table public.match_audit_log enable row level security;

drop policy if exists match_audit_log_select on public.match_audit_log;
drop policy if exists match_audit_log_insert on public.match_audit_log;

create policy match_audit_log_select on public.match_audit_log
  for select to authenticated
  using (
    organizer_id = auth.uid()::text
    or public.is_admin()
    or public.is_assigned_umpire_for_tournament_match(tournament_match_id)
  );

create policy match_audit_log_insert on public.match_audit_log
  for insert to authenticated
  with check (
    actor_id = auth.uid()::text
    and (
      organizer_id = auth.uid()::text
      or public.is_admin()
      or public.is_assigned_umpire_for_tournament_match(tournament_match_id)
    )
  );

-- Deliberately no update/delete policy for anyone but admin (none granted here
-- at all — admin corrections, if ever needed, go through the service role,
-- matching the `matches` table's own append-only precedent).

alter publication supabase_realtime add table public.match_audit_log;
