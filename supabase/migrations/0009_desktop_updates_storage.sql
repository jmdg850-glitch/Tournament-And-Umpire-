-- Public read-only bucket for Windows Operator auto-update artifacts.
-- Uploads are performed with the service role from the publish script, never from the app.

insert into storage.buckets (id, name, public, file_size_limit)
values ('desktop-updates', 'desktop-updates', true, 524288000)
on conflict (id) do update
set public = true,
    file_size_limit = excluded.file_size_limit;

drop policy if exists "desktop_updates_public_read" on storage.objects;
create policy "desktop_updates_public_read"
on storage.objects
for select
to public
using (bucket_id = 'desktop-updates');
