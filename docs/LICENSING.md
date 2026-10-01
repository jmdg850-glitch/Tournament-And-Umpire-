# Licensing

Model: **one customer email / account -> one access code (license) -> up to `max_devices` registered PCs.**

```
EMAIL / ACCOUNT ── LICENSE (access code, status, expires_at, max_devices)
                       ├── DEVICE 1  (registered)
                       ├── DEVICE 2  (registered)
                       ├── DEVICE 3  (released — history, holds no slot)
                       └── …
```

| Piece | Where |
|---|---|
| Tables | `public.licenses` (`0016_simple_licensing.sql`, plus `max_devices` from `0020_multi_device_licensing.sql`) and `public.license_devices` (`0020`). `0015` is superseded history. |
| Atomic registration | `public.license_register_device(...)` (`0020`) — the only way a device gets a slot |
| Server | Edge Function `supabase/functions/license/` (`license.js` = rules, `index.ts` = JWT + CORS) |
| Admin app | `apps/license-admin` (web / Windows / Android) |
| Operator | `apps/operator/src/{LicenseGate.jsx,license.js,licenseDevice.js}`, `electron/licenseDevice.cjs` |
| Server-side enforcement (everyday commands) | `packages/api/src/authz.js` (`requireLicense`, `requireOrganizerLicensed`), wired into `packages/api/src/handleCommand.js` |
| Tests | `supabase/functions/license/license.test.js` (unit), `licenseDevices.pg.test.js` (real PostgreSQL: backfill, limits, final-slot race, grants — runs when `LOCAL_PG_BIN` is set), `license.live.test.js` (live, gated); `packages/api/src/authz.test.js` (unit), `packages/api/src/live.test.js` (live, gated); `apps/operator/electron/licenseDeviceIpc.test.cjs` (real Electron IPC path) |

## Rules (all enforced by the server)

- The admin generates ONE code (`XXXX-XXXX-XXXX`) for a customer email, with **Allowed devices** (`max_devices`, a whole number 1–100, default 1). The email is stored lowercase; a second live license for the same email is refused (a revoked one does not block a new code).
- **Activation:** the customer signs in to Operator with that email (email must be confirmed by Supabase Auth) and enters the code. The code must exist **for that account's email**, and not be revoked or expired. A code alone is useless without owning the email.
- **Same-device reuse:** a PC that is already registered (relaunch, reinstall, repeated activation, renamed computer) is recognised by its device id and **never takes another slot**.
- **Device limit:** a NEW device registers only while the license's active (unreleased) devices are fewer than `max_devices`; otherwise the customer gets *"This license has reached its device limit. Ask your provider to release a device or raise the limit."* (`DEVICE_LIMIT`, 409).
- **Race safety:** `license_register_device` locks the license row (`SELECT … FOR UPDATE`), then re-checks revoked/expired, reuses an existing registration, counts active devices and inserts — in one transaction. Two PCs racing for the last slot: exactly one registers, the other gets `DEVICE_LIMIT` (proved against real PostgreSQL, and shown to fail without the lock).
- **Release device (admin):** releases ONE device of ONE license (`release_device { license_id, device_id }` — both must match). That PC stops being licensed at its next check; the license's other devices keep working; the slot is free for another PC. The row is kept (`released_at`) as history; the same PC may register again later if a slot is free.
- **Revoke (admin):** the whole license becomes invalid — every device loses access (`check` → revoked, `/command` → `LICENSE_INVALID`) and no device can register. Device rows are kept.
- **Raising the limit:** new devices may register until the new limit is reached.
- **Lowering the limit:** never releases or deletes a device. If more devices are registered than the new limit, the license is **over limit**: those devices keep working, License Admin shows *Over limit*, and no NEW device can register until the admin releases devices so usage is below the limit.
- A revoked license's limit cannot be changed.
- Password reset uses the normal Supabase Auth flow and never touches a license (licenses are keyed by email, not password).

## Existing licenses (migration 0020)

Every existing license got `max_devices = 1`. Each `active` license's bound PC (`licenses.device_id` / `device_label` / `activated_at` / `activated_user_id`) was copied into `license_devices` as its one registered device, so existing customers behave exactly as before until an admin raises their limit. Revoked licenses keep their status and history and got no device rows. `licenses.device_id` / `device_label` remain as history and are no longer written; the old single-PC check constraint was dropped. Installed Operator 1.2.x builds keep working: a new or released PC gets `check` status `not_registered` **without** a `message`, which those builds already treat as "show the Access Code form". The legacy admin action `release { id }` (License Admin ≤ 1.0.11 "Release PC") releases every device of that license.

## Code-first activation (new buyers)

Operator's default screen for an install that has never signed in is **Activate license** (`apps/operator/src/ActivationSetup.jsx`): access code → first PC registered → create your password → account ready → signed in. Two session-less actions on the `license` function implement it; the access code itself is the proof (it is issued by the admin for that email):

- `claim { code, device }` — looks the license up by code alone (revoked/expired rejected).
  - **While no account is linked** to the license, it may register the license's **first** device only (`p_first_only`): the same PC again → continue; any other PC → `ALREADY_ACTIVATED` ("… Sign in on this PC to add it to your license."). Returns `next: "set_password"`.
  - **Once an account exists**, the code alone never registers anything: it returns `next: "sign_in"` (with `bound: "already_here"` or `"not_registered"`). A new PC is added by signing in and entering the code (`activate`), which requires owning the email — so a leaked code cannot fill the license's device slots anonymously.
- `set_password { code, device, password }` — only from a device registered to the license, and only while no account is linked. Creates the Supabase Auth user for the license email via `auth.admin.createUser({ email_confirm: true })` (Supabase Auth hashes the password; nothing is stored or logged by us), then sets `activated_user_id`. If any account already exists for that email → `ACCOUNT_EXISTS` and the buyer is sent to Sign in / Reset password — **an existing password is never overwritten**. Password policy (8–72 chars) is enforced server-side.
- Trade-off: `email_confirm: true` means possession of the code stands in for email verification for this path. The account-first path (sign up → confirm email → enter code via `activate`) still works unchanged; `activate` also links an account to a license set up code-first.
- Later launches: the Supabase session persists; if signed out, the app opens on Sign in (a local "has account" flag) and the code is not needed again. `requireLicense` is keyed by the account email. `check` is keyed by the account email **and this device**, and refreshes the device's "last seen" at most once an hour.

## Server-side enforcement

`LicenseGate.jsx` is a client-side UI gate only — by itself it cannot stop a modified Operator client, or any caller holding a stolen-but-valid Supabase JWT, from calling `/command` directly. The command layer is the actual authority:

- `requireLicense(admin, actor)` (in `authz.js`) looks up `public.licenses` by the actor's verified JWT email (never the request body) and fails closed unless the current row is `status: "active"` and not expired. Selection of the "current" row (first non-revoked, else the latest revoked one) mirrors the `license` edge function's own `check()` action.
- `requireOrganizerLicensed(admin, actor, member)` runs the existing organizer-role check first, then the license check — a non-member always gets the pre-existing `FORBIDDEN` error, never a license error.
- **Gated:** all 23 organizer/admin-only commands, `create_tournament` (the bootstrap command — a brand-new signup needs a license before creating their first tournament), and the organizer-acting branch of `transition_match` / `start_match` / `coin_toss` / `score_event` / `complete_match`.
- **Never gated:** court station devices (no email/customer identity), `station_sync`, an umpire scoring or holding their own assigned match, password reset/login, and public/spectator "live" viewing (which never reaches `/command` at all).
- Denials return `LICENSE_REQUIRED` (no code / never activated) or `LICENSE_INVALID` (revoked, or expired) as HTTP 403, with a generic message only — never the email, code, or any other row's data.
- A warm-instance-local cache remembers only *positive* results for ~60 seconds; a denial is always re-checked against the database. So a revoke takes effect on that account's next command once any cached "allowed" result for it has aged out — at most ~60 s after the revoke on a warm instance, immediately otherwise.
- **Everyday actions are device-blind by design (owner decision, multi-device model).** The device limit is enforced when a device **registers** (`activate` / first code-first `claim`, through `license_register_device`), not on every `/command`. `requireLicense` checks account + valid license only — no device id, device secret or device-bound token. The device id is not a secret (a modified client could replay a registered one), so checking it here would add no real protection; a per-device secret would be a new authentication architecture and was deliberately not built. Consequence: someone holding a licensed account's password and a modified client could act from an unregistered PC; the official Operator blocks unregistered PCs through `check`, and revoke/expiry still stop every write server-side.
- Deploying a change here requires `npm run bundle:command` followed by redeploying the `command` edge function — this is a separate, independently-deployed function from `license`.

## PC identity

Electron: SHA-256 of the Windows `MachineGuid` (survives reinstall; the raw GUID never leaves the PC), falling back to a persisted random id in `userData`. The computer name is a display label only. Web build: a random id in `localStorage`. The same id is used for `claim`, `activate` and `check`, so a relaunch/reinstall never consumes a new device slot. Slot counting caveats: a re-imaged Windows install (new `MachineGuid`) counts as a new device, cloned PCs that were not sysprepped share one id and count as one device, and a web browser whose site data is cleared counts as a new device.

## Security

- `licenses` and `license_devices` have RLS forced and **no** client grants; only the `license` function (service role) touches them. `license_register_device` is executable by `service_role` only.
- Customers cannot change `max_devices`, list or release devices, or change license ownership: those are admin actions (checked against `license_admins` on every call), and there is no client path to the tables.
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

A released device is told `not_registered` at its next online check (within ~5 minutes while open), which blocks it and removes its offline allowance; a PC that is offline when released keeps its existing allowance until it reconnects (at most 7 days). Changing `max_devices` only affects new registrations.

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
  - **Windows:** packaged as **RESETIQ License Admin** (`RESETIQ-License-Admin-Setup-<version>.exe`; 1.0.12 and earlier were `Tournament-License-Admin-Setup-<version>.exe`) and published in the **same GitHub Release** as Operator (`jmdg850-glitch/Tournament-And-Umpire-`, tag `v<operator version>`) with its `.blockmap` and `license-admin.yml`. The desktop app auto-updates from its own electron-updater channel, `license-admin` — it reads only `license-admin.yml`, while Operator reads only `latest.yml`, so neither app can pick up the other's installer. Updates are checked ~12 s after start and every 6 h (packaged builds only), download automatically, and install when the app quits or when the seller clicks **Restart** on the header's "Update ready" notice. `scripts/publish-desktop-update.mjs` requires both apps' artifacts, so every published release carries both update channels.
  - **RESETIQ rebrand (display only):** `build.productName`, the shortcut name, the window title, the icon and the in-app logo changed. `appId` (`app.tournament.licenseadmin`, which determines the installer GUID and uninstall registry key), the package `name` (`@tournament/license-admin`, which determines the Electron userData folder and so the saved sign-in), the `license-admin` update channel and the GitHub repo are unchanged on purpose, so installed Tournament License Admin builds update in place. `apps/license-admin/build/installer.nsh` reuses the registered install folder on upgrade (same hook as Operator) so the new product name is not nested inside the old folder.
  - **First updater-enabled version:** License Admin Windows 1.0.0 and 1.0.1 contain no updater, so the first updater-enabled build must be installed manually once; later versions then arrive automatically.
  - **Android:** the release APK is built and verified locally only (not uploaded anywhere) and is **unsigned** unless `apps/license-admin/android/keystore.properties` is configured.
- The `packages/api/src/handleCommand.js` server-side enforcement described above **is deployed**: the production `command` edge function (v23, verified 2026-09-24) contains `requireLicense` / `requireOrganizerLicensed`. Redeploy after changing it (`npm run bundle:command` + deploy `command`).
- Direct database **reads** (PostgREST under RLS, e.g. a signed-in account reading its own tournaments) are membership-gated, not license-gated. A revoked account's official app is blocked by the gate and its writes are refused by `/command`, but a hand-made client with that account's JWT could still read its own tournament data. Closing that requires an RLS/migration change and is not part of the current design.
