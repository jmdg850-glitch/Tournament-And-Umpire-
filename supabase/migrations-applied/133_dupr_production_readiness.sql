-- DUPR production-readiness pass: not_rated submission status (for tournament
-- matches whose division isn't dupr_rated), player DUPR rating storage
-- (separate from PickleLive's own rating system), and a minimal match-dispute
-- support mechanism required for DUPR partner review. All additive.

-- 1. Widen dupr_match_submissions.status to add 'not_rated' — written
--    server-side (submit-match/index.ts) for a tournament match whose
--    division has dupr_rated=false, so Sync Center / History can show a
--    clear status instead of silently never creating a row.
alter table public.dupr_match_submissions drop constraint if exists dupr_match_submissions_status_check;
alter table public.dupr_match_submissions add constraint dupr_match_submissions_status_check
  check (status in ('pending','submitting','submitted','failed','skipped','not_rated'));

-- 2. Player DUPR ratings — distinct from accounts.singles_rating/doubles_rating
-- (PickleLive's own internal rating system). Populated on self-link (Login
-- with DUPR), read-only display only.
alter table public.accounts add column if not exists dupr_singles_rating numeric;
alter table public.accounts add column if not exists dupr_doubles_rating numeric;

-- 3. Minimal match-dispute / support-request record. Never touches a DUPR
-- secret, so this is a direct authenticated client insert (RLS-gated), not
-- routed through an Edge Function. Reports are informational only — nothing
-- here ever auto-modifies or deletes a match or a DUPR submission.
create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  reporter_id text not null references public.accounts(id) on delete cascade,
  match_id text references public.matches(id) on delete set null,
  dupr_match_code text,
  issue_type text not null check (issue_type in ('incorrect_score','wrong_player','incorrect_result','dupr_submission_issue','other')),
  description text,
  status text not null default 'open' check (status in ('open','reviewing','resolved')),
  created_at timestamptz not null default now()
);
create index if not exists support_requests_reporter_idx on public.support_requests(reporter_id);
create index if not exists support_requests_match_idx on public.support_requests(match_id);

alter table public.support_requests enable row level security;

create policy support_requests_insert_own on public.support_requests
  for insert to authenticated
  with check (reporter_id = auth.uid()::text);

create policy support_requests_select_own_or_admin on public.support_requests
  for select to authenticated
  using (
    reporter_id = auth.uid()::text
    or exists (select 1 from public.admins a where a.user_id = auth.uid()::text)
  );
