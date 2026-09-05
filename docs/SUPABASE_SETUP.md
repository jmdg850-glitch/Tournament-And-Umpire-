# Supabase setup

## Project

Name: **Tournament App**  
Ref / ID: `evuvgxruavnadpbiehgb`  
URL: `https://evuvgxruavnadpbiehgb.supabase.co`  
Region: `ap-southeast-1`

This is a new project. The previous **Tournament** project was paused to free the free-tier slot. **NextG** (PickleLive) was not used.

## What you may need to click

If dashboard confirmation is required:

1. [Tournament App settings](https://supabase.com/dashboard/project/evuvgxruavnadpbiehgb)
2. Authentication → URL configuration is now set on the live project:
   - Site URL: `http://localhost:5174` (no public production domain exists yet — **DOMAIN CONFIGURATION PENDING**)
   - Redirects: `http://localhost:5174`, `http://localhost:5174/**`, `http://localhost:5175`, `http://localhost:5175/**`, plus Vite preview `4174`/`4175`
   - Desktop password-reset callback (add in the dashboard if not already present): `tournament-operator://auth/callback`
   Operator is pinned to **5174** and umpire to **5175** (`strictPort: true`).
3. Authentication → Providers → Email enabled. Email confirmations are **off** for local development so organizer signup works without inbox access. Turn **on** before public self-serve signup.
4. Authentication → leaked password protection (HaveIBeenPwned) requires **Pro plan or above**. On the current free-tier Tournament App project this remains **PLAN-GATED / disabled**. Do not claim it is enabled.
5. MFA/TOTP: dashboard advisor currently reports insufficient MFA options. Staff-event optional; enable when required.
5. Edge Functions → confirm `command` is deployed with JWT verification on
6. Copy the **publishable** key into app `.env.local` files (client-safe)
7. Copy the **service role** key only into a private server env if you run `packages/api` locally — never into Vite env (`VITE_*`)

## Apply migrations

From this repo, using MCP `apply_migration` or:

```bash
npx supabase link --project-ref evuvgxruavnadpbiehgb
npx supabase db push
```

Then run `supabase/seed.dev.sql` against the development database only.

## Official writes

Confirm `apply_official_writes` is not granted to `anon` or `authenticated`.
