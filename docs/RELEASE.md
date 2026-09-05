# Release

## Product

**Tournament** operator + umpire apps against Supabase project **Tournament App** (`evuvgxruavnadpbiehgb`, `ap-southeast-1`).

Architecture: Auth JWT → Edge Function `command` → engine → `apply_official_writes` → PostgreSQL.

Not PickleLive. Not NextG.

## Environment (client-safe only)

`apps/operator/.env.local` and `apps/umpire/.env.local`:

```
VITE_SUPABASE_URL=https://evuvgxruavnadpbiehgb.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_COMMAND_URL=https://evuvgxruavnadpbiehgb.supabase.co/functions/v1/command
```

Never put `SUPABASE_SERVICE_ROLE_KEY` in `VITE_*`, React, Electron, or the Android web bundle.

Server-only (local `packages/api` or CI): `SUPABASE_SERVICE_ROLE_KEY`.

## Auth (current live project)

Configured in the dashboard / `supabase/config.toml`:

| Setting | Current | Notes |
| --- | --- | --- |
| Site URL | `http://localhost:5174` | No production domain exists yet. Change this when a public domain is assigned. |
| Redirects | localhost 5174/5175 and preview 4174/4175 | Keep for development. |
| Desktop reset | `tournament-operator://auth/callback` | Add this URL in Authentication → URL configuration. Password **login** does not need it (direct API). |
| Email confirmation | Off | Development so local signup works. Turn **on** before public self-serve signup. |
| MFA / TOTP | Insufficient (advisor WARN) | Optional for staff events. Enable in dashboard when required. |
| Leaked-password protection | Disabled | **PLAN-GATED** (Pro+). Not enabled. Do not claim it is on. |

Password login in the Windows app uses `signInWithPassword` against hosted Auth. It does not open a browser and does not depend on Site URL. Sign-out is **local** to that client so logging out of the operator web preview does not revoke the Windows app or umpire sessions.

Password **reset** emails need an allowed redirect. Add `tournament-operator://auth/callback` in Authentication → URL configuration if it is not already listed (also in `supabase/config.toml`). Until the dashboard list includes that URL, reset links from the desktop app will not complete. Web reset uses the page origin (`http://localhost:5174` or preview).

Android release: copy `apps/umpire/android/keystore.properties.example` to `keystore.properties`, point at a JKS that is never committed, then `assembleRelease` / `bundleRelease`. Unsigned APKs cannot be Play-signed. Physical-device umpire scoring is **DEVICE TEST PENDING** until a phone is attached.

## Builds

```bash
npm run build
npm run build:desktop -w @tournament/operator
# Android (JDK 17 or 21 — not 25). Example:
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
$env:CAPACITOR = "1"
npm run build:android -w @tournament/umpire
cd apps/umpire/android
.\gradlew.bat assembleRelease bundleRelease
```

Release APK/AAB is **unsigned** until you create `apps/umpire/android/keystore.properties` from `keystore.properties.example` and a JKS that is **never committed**.

## Artifacts

- Operator web: `apps/operator/dist/`
- Umpire web: `apps/umpire/dist/`
- Windows installer: `apps/operator/release/Tournament-Operator-Setup-1.0.0.exe`
- Android debug: `apps/umpire/android/app/build/outputs/apk/debug/app-debug.apk`
- Android release (after gradle): `apps/umpire/android/app/build/outputs/apk/release/`

## Dev seed (not production users)

Documented in `docs/DEVELOPMENT.md`. Do not bake these passwords into release binaries. They live only in `supabase/seed.dev.sql` and local docs.

## Checklist

1. Client env is publishable keys only
2. `command` Edge Function `verify_jwt = true`
3. Windows installer launches and logs in
4. Android signed only with owner keystore
5. When a public domain exists: set Site URL + HTTPS redirects
6. Before public signup: email confirmation on; leaked-password if on Pro
