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

## Server-side enforcement

`LicenseGate.jsx` is a client-side UI gate only — by itself it cannot stop a modified Operator client, or any caller holding a stolen-but-valid Supabase JWT, from calling `/command` directly. The command layer is the actual authority:

- `requireLicense(admin, actor)` (in `authz.js`) looks up `public.licenses` by the actor's verified JWT email (never the request body) and fails closed unless the current row is `status: "active"` and not expired. Selection of the "current" row (first non-revoked, else the latest revoked one) mirrors the `license` edge function's own `check()` action.
- `requireOrganizerLicensed(admin, actor, member)` runs the existing organizer-role check first, then the license check — a non-member always gets the pre-existing `FORBIDDEN` error, never a license error.
- **Gated:** all 23 organizer/admin-only commands, `create_tournament` (the bootstrap command — a brand-new signup needs a license before creating their first tournament), and the organizer-acting branch of `transition_match` / `start_match` / `coin_toss` / `score_event` / `complete_match`.
- **Never gated:** court station devices (no email/customer identity), `station_sync`, an umpire scoring or holding their own assigned match, password reset/login, and public/spectator "live" viewing (which never reaches `/command` at all).
- Denials return `LICENSE_REQUIRED` (no code / never activated) or `LICENSE_INVALID` (revoked, or expired) as HTTP 403, with a generic message only — never the email, code, or any other row's data.
- A warm-instance-local cache remembers only *positive* results for ~60 seconds; a denial is always re-checked against the database, so a revoke takes effect on that account's very next command.
- Device-seat binding (one PC per license) is intentionally **not** re-checked here — the Electron device hash isn't sent on ordinary `/command` calls, and a client that's already been modified to bypass the gate can't be trusted to send it truthfully either. That enforcement correctly stays where it already lives: the `license` function's `activate` flow.
- Deploying a change here requires `npm run bundle:command` followed by redeploying the `command` edge function — this is a separate, independently-deployed function from `license`.

## PC identity

Electron: SHA-256 of the Windows `MachineGuid` (survives reinstall; the raw GUID never leaves the PC), falling back to a persisted random id in `userData`. The computer name is a display label only. Web build: a random id in `localStorage`.

## Security

- `licenses` has RLS forced and **no** client grants; only the `license` function (service role) touches it.
- Caller identity comes from the verified JWT only. Admin actions require a row in `public.license_admins`, checked on every request. Unknown or extra request fields are rejected.
- Codes are stored in plaintext so the admin can re-copy them; they are unreadable to any client. A database/service-key compromise would expose them (they still only work for the matching, confirmed email).

## Offline

If the server is unreachable, Operator keeps working only if this account was verified active within the last 7 days. This is a convenience, not tamper-proof.

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
- `apps/license-admin` is versioned separately and is not part of `npm run release`. It is not deployed anywhere yet; only the web build exists (no Windows/Android packaging).
- The `packages/api/src/handleCommand.js` server-side enforcement described above is implemented and unit-tested but, as of this writing, **not yet bundled/deployed** to the production `command` edge function (`npm run bundle:command` + redeploy is a separate step) — until that runs, production is still relying on `LicenseGate.jsx` alone.
