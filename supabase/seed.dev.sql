-- DEVELOPMENT seed only. Not for production. Passwords are local-dev values, not real credentials.

create extension if not exists pgcrypto with schema extensions;

-- Helper: create a confirmed email user if missing.
create or replace function private.upsert_dev_user(uid uuid, email text, password text, display_name text)
returns void
language plpgsql
security definer
set search_path = auth, public, extensions
as $$
begin
  if exists (select 1 from auth.users where id = uid) then
    update public.profiles set display_name = display_name where id = uid;
    return;
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) values (
    '00000000-0000-0000-0000-000000000000',
    uid,
    'authenticated',
    'authenticated',
    email,
    crypt(password, gen_salt('bf')),
    now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    jsonb_build_object('display_name', display_name),
    now(),
    now(),
    '',
    '',
    '',
    ''
  );

  insert into auth.identities (
    id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at
  ) values (
    gen_random_uuid(),
    uid,
    jsonb_build_object('sub', uid::text, 'email', email),
    'email',
    uid::text,
    now(),
    now(),
    now()
  );
end;
$$;

select private.upsert_dev_user(
  'a1000000-0000-4000-8000-000000000001',
  'organizer.dev@tournament.local',
  'dev-organizer-pass',
  'Dev Organizer'
);

select private.upsert_dev_user(
  'a1000000-0000-4000-8000-000000000002',
  'umpire.dev@tournament.local',
  'dev-umpire-pass',
  'Dev Umpire'
);

select private.upsert_dev_user(
  'a1000000-0000-4000-8000-000000000003',
  'outsider.dev@tournament.local',
  'dev-outsider-pass',
  'Dev Outsider'
);
