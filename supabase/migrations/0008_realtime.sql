-- Enable Postgres changes for organizer/live windows.
-- Replica identity FULL is required so UPDATE filters on non-PK columns work.

alter table public.matches replica identity full;
alter table public.score_events replica identity full;
alter table public.match_results replica identity full;
alter table public.court_assignments replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.matches;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.score_events;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.match_results;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.court_assignments;
exception when duplicate_object then null;
end $$;
