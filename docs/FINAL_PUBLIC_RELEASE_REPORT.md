# Final public release report

Independent verification against repository + live Supabase **Tournament App** (`evuvgxruavnadpbiehgb`, `ap-southeast-1`) and Vercel production, 2026-08-29 (this pass ~21:55–22:20 local).

Vercel team **TOURNAMENT NEXTG** is billing-only. Apps are not connected to NextG or PickleLive.

## 1. Final Verdict

**🟡 CONDITIONAL — OWNER ACTION REQUIRED**

Cursor completed every safe code, build, and deploy step available. Public launch still needs hosted Site URL + email confirmation (dashboard), Android signing, a physical device test, and optional Pro leaked-password protection.

Do **not** treat this as 🟢 READY FOR PUBLIC RELEASE.

## 2. Architecture

**PASS.** Unchanged:

Operator / Umpire → Supabase Auth JWT → Edge Function `command` → `packages/engine` → `apply_official_writes` → PostgreSQL.

Clients mutate only via `sendCommand`. Domain-table access in `apps/operator/src` and `apps/umpire/src` is **SELECT** only (plus Auth `updateUser` for password reset).

## 3. Supabase

| Item | Status |
| --- | --- |
| Project | Tournament App `evuvgxruavnadpbiehgb` `ap-southeast-1` |
| `command` | ACTIVE, `verify_jwt: true` |
| Public tables | 19 / 19 RLS + FORCE RLS |
| `apply_official_writes` EXECUTE | `postgres`, `service_role` only |
| `anon`/`authenticated` INSERT/DELETE | none |
| `anon`/`authenticated` UPDATE | `profiles` only (RLS still applies) |

`supabase/config.toml` documents Vercel + desktop redirects. **It does not push to the hosted dashboard.** Hosted Site URL was last live-verified as `http://localhost:5174`.

## 4. Auth

| Item | Status |
| --- | --- |
| Password login (Vercel) | **PASS** (this date, earlier pass; production UI still Operator/Umpire after redeploy) |
| Signup `emailRedirectTo` | **Fixed this pass** — uses `authRedirectUrl()` (`window.location.origin` on web, `tournament-operator://auth/callback` on desktop) |
| Password reset `redirectTo` | **PASS** — same helper |
| Recovery set-password UI | **Added this pass** — Operator + Umpire show “Choose a new password” on `PASSWORD_RECOVERY` |
| Logout | **PASS** — `signOut({ scope: "local" })` Operator, Umpire, Android webview |
| Live Redirect URLs (last recover-referer probe) | Operator/Umpire exact + `/**`, localhost 5174/5175, `tournament-operator://auth/callback` |
| Hosted Site URL | **OWNER ACTION** — still localhost unless the owner changed it after the last live probe |
| Email confirmation | **OWNER ACTION** — last live settings: `mailer_autoconfirm: true` (off). Enable **after** Site URL is production HTTPS |

## 5. Security

| Item | Status |
| --- | --- |
| Service role in Vercel client env | **No** — only `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_ANON_KEY`, `VITE_COMMAND_URL` |
| `SUPABASE_SERVICE_ROLE_KEY` in apps | **No** (server/tests in `packages/api` only, not `VITE_`) |
| Real `sb_secret_` in production JS | **No** (supabase-js `startsWith('sb_secret_')` helper only) |
| Dev passwords in bundles | **No** |
| PickleLive / NextG / `qfyfomiqxouqftrgganh` in active apps + production JS | **No** |
| `.env*` / keystores gitignored | **PASS** |

## 6. Operator

Production: https://tournament-operator.vercel.app (`dpl_8ysfshG5dRp53xCiBFtXr5a9Jctv`)

Login, dashboard, tournament desk, signup (origin redirect), reset, recovery password screen, logout. Bundle includes recovery copy and Tournament App host only.

## 7. Umpire

Production: https://tournament-umpire.vercel.app (`dpl_BFWf8yzcdSmK2LSL5qYfq2S1eKk3`)

Login, assignment list, reset, recovery password screen, logout. Same backend. Live scoring on a physical phone: **DEVICE ACTION**.

## 8. Team Elimination

Live API tests **7** passed this pass (includes Team Elimination, scoring persistence/idempotency, outsider 403). Engine **170** passed.

## 9. Vercel

| App | URL | Deploy |
| --- | --- | --- |
| Operator | https://tournament-operator.vercel.app | `dpl_8ysfshG5dRp53xCiBFtXr5a9Jctv` READY |
| Umpire | https://tournament-umpire.vercel.app | `dpl_BFWf8yzcdSmK2LSL5qYfq2S1eKk3` READY |

Custom domain: **not assigned**.

## 10. Windows

Built this pass (`electron-builder --publish never`, `npmRebuild: false`):

- Product: Tournament Operator (`app.tournament.operator`)
- Icon: `apps/operator/build/icon.ico`
- Protocol: `tournament-operator://` in electron-builder + `setAsDefaultProtocolClient`
- NSIS desktop + Start Menu shortcuts (`installer.nsh`)
- Installer generated; unpacked exe launched (process started, then stopped)

Desktop login/dashboard/logout against live Auth was verified on this machine earlier today; this pass confirmed the new installer builds and the unpacked exe starts.

## 11. Android

| Item | Status |
| --- | --- |
| Package | `app.tournament.umpire` |
| Label | Tournament Umpire |
| minSdk / targetSdk | 24 / 36 |
| `keystore.properties` | **Missing** |
| Signed APK/AAB | **Not built** (no owner keystore) |
| Leftover unsigned | `app-release-unsigned.apk`, `app-release.aab` (prior unsigned outputs) |

## 12. Automated tests (this pass)

```
npm run lint          exit 0 (workspace lint stubs)
npm run build         Operator + Umpire web, exit 0
npm run typecheck     no TypeScript typecheck in this repo (honest stub)
RUN_LIVE_API_TESTS=1 npm test
  engine:    Test Files 11 passed, Tests 170 passed
  contracts: 1 passed
  api live:  Test Files 2 passed, Tests 7 passed (198.30s)
  exit 0   (2026-08-29 21:55 local)
npm run build:desktop -w @tournament/operator
  Tournament-Operator-Setup-1.0.0.exe  (2026-08-29 22:20 local)
```

## 13. Release artifacts

| Artifact | Path | This pass |
| --- | --- | --- |
| Operator web | `apps/operator/dist/` (`index-CXJkHGrP.js`) | **Yes** |
| Umpire web | `apps/umpire/dist/` (`index-CAFhzUSv.js`) | **Yes** |
| Windows installer | `apps/operator/release/Tournament-Operator-Setup-1.0.0.exe` | **Yes** (95,423,645 bytes, 2026-08-29 22:20) |
| Windows unpacked | `apps/operator/release/win-unpacked/Tournament Operator.exe` | **Yes** (launched) |
| Android signed APK/AAB | — | **No** (no keystore) |

## 14. Remaining owner actions

1. Supabase Dashboard → Site URL → `https://tournament-operator.vercel.app` → Save.
2. After Site URL is production HTTPS: turn **Confirm email** ON.
3. Send one Operator production reset email and confirm the link opens Vercel (not localhost), then set the new password on the recovery screen.
4. Create Android keystore locally: copy `apps/umpire/android/keystore.properties.example` → `keystore.properties`, put `umpire-release.jks` under `apps/umpire/android/keystores/` (gitignored). Then `npm run build:android -w @tournament/umpire` and Gradle signed `assembleRelease` / `bundleRelease`.
5. Optional: custom production domain.

## 15. Remaining device actions

Physical Android: toss → score → complete → reload.

## 16. Remaining paid-plan actions

Leaked-password protection (HaveIBeenPwned): advisor WARN, Pro+.  
MFA: advisor WARN, optional.

## OWNER ACTIONS

- Set hosted Site URL to `https://tournament-operator.vercel.app`
- Enable email confirmation after that
- Confirm one production reset email lands on Vercel and the new set-password screen
- Android signing keystore (never commit)
- Physical Android scoring test
- Optional: custom domain; Supabase Pro leaked-password

```text
FINAL VERDICT:
🟡 CONDITIONAL — OWNER ACTION REQUIRED
```
