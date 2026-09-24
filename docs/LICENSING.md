# Licensing

Simple model: **one customer email -> one access code -> one PC.**

| Piece | Where |
|---|---|
| Table | `public.licenses` (`supabase/migrations/0016_simple_licensing.sql`). `0015` is superseded history. |
| Server | Edge Function `supabase/functions/license/` (`license.js` = rules, `index.ts` = JWT + CORS) |
| Admin app | `apps/license-admin` (web) |
| Operator | `apps/operator/src/{LicenseGate.jsx,license.js,licenseDevice.js}`, `electron/licenseDevice.cjs` |
| Server-side enforcement | `packages/api/src/authz.js` (`requireLicense`, `requireOrganizerLicensed`), wired into `packages/api/src/handleCommand.js` |
| Tests | `supabase/functions/license/license.test.js` (unit), `license.live.test.js` (live, gated); `packages/api/src/authz.test.js` (unit), `packages/api/src/live.test.js` (live, gated); `apps/operator/electron/licenseDeviceIpc.test.cjs` (real Electron IPC path) |

## Rules (all enforced by the server)

- The admin generates ONE code (`XXXX-XXXX-XXXX`) for a customer email. The email is stored lowercase; a second live license for the same email is refused (a revoked one does not block a new code).
- To activate, the customer signs in to Operator with that email (email must be confirmed by Supabase Auth) and enters the code. The code must exist **for that account's email**, and not be revoked or expired. A code alone is useless without owning the email.
- The first successful activation binds the license to that PC. The same PC (relaunch, reinstall) keeps working. Any other PC gets *"This license is already activated on another PC."*
- The admin can **Release PC** (unbinds; the customer can then activate a replacement, and the old PC is locked out) or **Revoke**.
- Two PCs activating at the same instant: exactly one wins (single conditional `UPDATE`).
- Password reset uses the normal Supabase Auth flow and never touches a license (licenses are keyed by email, not password).

## Code-first activation (new buyers)

Operator's default screen for an install that has never signed in is **Activate license** (`apps/operator/src/ActivationSetup.jsx`): access code → license bound → create your password → account ready → signed in. Two session-less actions on the `license` function implement it; the access code itself is the proof (it is issued by the admin for that email):

- `claim { code, device }` — looks the license up by code alone and runs the same `decideActivation` + atomic conditional bind as `activate` (another PC → `ALREADY_ACTIVATED`; revoked/expired rejected). `activated_user_id` stays null until an account exists. Returns the license email and `next: "set_password"` (no linked account) or `"sign_in"`. Already bound to this PC with no account → straight to password setup.
- `set_password { code, device, password }` — only for a license `active` on **this** device with no linked account. Creates the Supabase Auth user for the license email via `auth.admin.createUser({ email_confirm: true })` (Supabase Auth hashes the password; nothing is stored or logged by us), then sets `activated_user_id`. If any account already exists for that email → `ACCOUNT_EXISTS` and the buyer is sent to Sign in / Reset password — **an existing password is never overwritten**. Password policy (8–72 chars) is enforced server-side.
- Trade-off: `email_confirm: true` means possession of the code stands in for email verification for this path. The account-first path (sign up → confirm email → enter code via `activate`) still works unchanged; `activate` also links an account to a license bound code-first.
- Later launches: the Supabase session persists; if signed out, the app opens on Sign in (a local "has account" flag) and the code is not needed again. `check`/`requireLicense` are unchanged (keyed by the account email).

## Server-side enforcement

`LicenseGate.jsx` is a client-side UI gate only — by itself it cannot stop a modified Operator client, or any caller holding a stolen-but-valid Supabase JWT, from calling `/command` directly. The command layer is the actual authority:

- `requireLicense(admin, actor)` (in `authz.js`) looks up `public.licenses` by the actor's verified JWT email (never the request body) and fails closed unless the current row is `status: "active"` and not expired. Selection of the "current" row (first non-revoked, else the latest revoked one) mirrors the `license` edge function's own `check()` action.
- `requireOrganizerLicensed(admin, actor, member)` runs the existing organizer-role check first, then the license check — a non-member always gets the pre-existing `FORBIDDEN` error, never a license error.
- **Gated:** all 23 organizer/admin-only commands, `create_tournament` (the bootstrap command — a brand-new signup needs a license before creating their first tournament), and the organizer-acting branch of `transition_match` / `start_match` / `coin_toss` / `score_event` / `complete_match`.
- **Never gated:** court station devices (no email/customer identity), `station_sync`, an umpire scoring or holding their own assigned match, password reset/login, and public/spectator "live" viewing (which never reaches `/command` at all).
- Denials return `LICENSE_REQUIRED` (no code / never activated) or `LICENSE_INVALID` (revoked, or expired) as HTTP 403, with a generic message only — never the email, code, or any other row's data.
- A warm-instance-local cache remembers only *positive* results for ~60 seconds; a denial is always re-checked against the database. So a revoke takes effect on that account's next command once any cached "allowed" result for it has aged out — at most ~60 s after the revoke on a warm instance, immediately otherwise.
- Device-seat binding (one PC per license) is intentionally **not** re-checked here — the Electron device hash isn't sent on ordinary `/command` calls, and a client that's already been modified to bypass the gate can't be trusted to send it truthfully either. That enforcement correctly stays where it already lives: the `license` function's `activate` flow.
- Deploying a change here requires `npm run bundle:command` followed by redeploying the `command` edge function — this is a separate, independently-deployed function from `license`.

## PC identity

Electron: SHA-256 of the Windows `MachineGuid` (survives reinstall; the raw GUID never leaves the PC), falling back to a persisted random id in `userData`. The computer name is a display label only. Web build: a random id in `localStorage`.

## Security

- `licenses` has RLS forced and **no** client grants; only the `license` function (service role) touches it.
- Caller identity comes from the verified JWT only. Admin actions require a row in `public.license_admins`, checked on every request. Unknown or extra request fields are rejected.
- Codes are stored in plaintext so the admin can re-copy them; they are unreadable to any client. A database/service-key compromise would expose them (they still only work for the matching, confirmed email).

## Revocation in a running Operator

`useLicense` (`LicenseGate.jsx`) delegates to `createLicenseMonitor` in `apps/operator/src/license.js`. The server's answer is always authoritative; the client never treats a local flag as a license.

- **Periodic:** an open Operator re-checks every 5 minutes (`RECHECK_MS`), on reconnect (`online`), and on window focus / becoming visible (at most once a minute). An idle open app therefore sees a revoke within ~5 minutes.
- **Immediate:** when `/command` (or an offline-queue replay) is refused with `LICENSE_INVALID` / `LICENSE_REQUIRED`, the app blocks at once, drops the offline allowance, then re-checks for the reason to show.
- **Ordering:** check results are applied in order, so a slow "active" answer from before a revoke can never overwrite a newer "revoked" answer.
- **Restart:** every launch starts with a server check; a revoked license stays blocked.
- Popped-out display windows (live/bracket/match displays) are read-only and not license-gated by design (see Known limits).

## Offline

If the server is unreachable, Operator keeps working only if this account was verified active within the last 7 days. This is a convenience, not tamper-proof. The allowance is only granted by a successful "active" check and is removed by any "not active" answer or license denial from the server — so once the client has seen a revoke, going offline or restarting offline cannot restore access. A revoke made while a PC is offline is enforced when it reconnects (writes to `/command` are refused server-side regardless).

## Operating

Grant an admin (no self-service path):

```sql
insert into public.license_admins (user_id) select id from auth.users where email = 'owner@example.com';
```

Deploy the function: `npx supabase functions deploy license --project-ref <ref> --no-verify-jwt --use-api`.

Live test (creates and leaves `+lictest-` data to delete afterwards): see the header of `license.live.test.js`.

## Known limits

- This Supabase project sends auth email through Supabase's built-in sender, which has a very small project-wide hourly cap (`over_email_send_rate_limit`). Forgot-password and sign-up emails will fail when it is hit. Configure custom SMTP in the Supabase dashboard before selling.
- Umpire, court stations and Operator's popped-out display windows are not gated by design (see "Server-side enforcement" above) — this is intentional, not an oversight.
- Shipping this Operator build means every Operator account needs a license. Existing users are blocked until you issue them a code. This is unchanged by server-side enforcement — it was already true of `LicenseGate.jsx`, just not previously backed by the server.
- `apps/license-admin` has its own version number (independent of Operator/Umpire) but is built and bumped by `npm run release`:
  - **Windows:** packaged as `Tournament-License-Admin-Setup-<version>.exe` and published in the **same GitHub Release** as Operator (`jmdg850-glitch/Tournament-And-Umpire-`, tag `v<operator version>`) with its `.blockmap` and `license-admin.yml`. The desktop app auto-updates from its own electron-updater channel, `license-admin` — it reads only `license-admin.yml`, while Operator reads only `latest.yml`, so neither app can pick up the other's installer. Updates are checked ~12 s after start and every 6 h (packaged builds only), download automatically, and install when the app quits or when the seller clicks **Restart** on the header's "Update ready" notice. `scripts/publish-desktop-update.mjs` requires both apps' artifacts, so every published release carries both update channels.
  - **First updater-enabled version:** License Admin Windows 1.0.0 and 1.0.1 contain no updater, so the first updater-enabled build must be installed manually once; later versions then arrive automatically.
  - **Android:** the release APK is built and verified locally only (not uploaded anywhere) and is **unsigned** unless `apps/license-admin/android/keystore.properties` is configured.
- The `packages/api/src/handleCommand.js` server-side enforcement described above **is deployed**: the production `command` edge function (v23, verified 2026-09-24) contains `requireLicense` / `requireOrganizerLicensed`. Redeploy after changing it (`npm run bundle:command` + deploy `command`).
- Direct database **reads** (PostgREST under RLS, e.g. a signed-in account reading its own tournaments) are membership-gated, not license-gated. A revoked account's official app is blocked by the gate and its writes are refused by `/command`, but a hand-made client with that account's JWT could still read its own tournament data. Closing that requires an RLS/migration change and is not part of the current design.
