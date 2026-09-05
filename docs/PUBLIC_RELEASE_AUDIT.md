# Public release audit

See `docs/FINAL_PUBLIC_RELEASE_REPORT.md` for the 2026-08-29 master pass.

Architecture is not replaced. Active apps: `apps/operator`, `apps/umpire`. Live backend: Tournament App `evuvgxruavnadpbiehgb`.

Classification: **PASS** / **FAIL** / **BLOCKER** / **IMPORTANT** / **OPTIONAL**.

## Architecture

| Item | Result |
| --- | --- |
| Operator/Umpire → JWT → Edge `command` → engine → `apply_official_writes` → PostgreSQL | **PASS** |
| Client mutations via `sendCommand` only | **PASS** |
| Live `command` `verify_jwt = true`, ACTIVE | **PASS** |

## Auth (this pass)

Signup now passes `emailRedirectTo: authRedirectUrl()`. Reset already did. Recovery UI added for Operator + Umpire.

Hosted Site URL and email confirmation remain **OWNER ACTION**.

## Remaining that Cursor cannot finish

**OWNER ACTION:** Site URL; email confirmation; Android keystore; production reset-email click-through.

**DEVICE ACTION REQUIRED:** physical Android scoring.

**PLAN ACTION REQUIRED:** leaked-password (Pro+).
