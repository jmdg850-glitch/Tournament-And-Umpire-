-- Courts — the organizer's court list (name/color/active), previously 100% local-only
-- (localStorage), which is why an accepted co-organizer's device showed its own default
-- Court 1-4 instead of the event owner's actual courts. Mirrors mixmatch_teams exactly:
-- one row per court, keyed by organizer_id, same permissive frontend-gated RLS pattern
-- every other roster-shaped table in this app already uses. No new tables beyond this one;
-- does not touch or alter any existing table, column, or row.
--
-- Paste this into the Supabase SQL editor the same way you ran the earlier migration files.

create table if not exists public.courts (
  id text primary key,
  organizer_id text not null,
  name text not null,
  color text,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);

create index if not exists courts_organizer_idx on public.courts (organizer_id);

alter table public.courts enable row level security;

create policy "courts_select" on public.courts for select using (true);
create policy "courts_insert" on public.courts for insert with check (true);
create policy "courts_update" on public.courts for update using (true);
create policy "courts_delete" on public.courts for delete using (true);
