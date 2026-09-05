-- Profile row for every auth user. Users cannot set platform_role.

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, platform_role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1), ''),
    'user'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

create or replace function private.protect_platform_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.platform_role is distinct from old.platform_role
     and coalesce(auth.role(), '') is distinct from 'service_role' then
    raise exception 'platform_role cannot be changed by clients';
  end if;
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.protect_platform_role() from public, anon, authenticated;

drop trigger if exists protect_platform_role on public.profiles;
create trigger protect_platform_role
  before update on public.profiles
  for each row execute function private.protect_platform_role();

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

create trigger tournaments_touch before update on public.tournaments
  for each row execute function private.touch_updated_at();
create trigger divisions_touch before update on public.divisions
  for each row execute function private.touch_updated_at();
create trigger matches_touch before update on public.matches
  for each row execute function private.touch_updated_at();
