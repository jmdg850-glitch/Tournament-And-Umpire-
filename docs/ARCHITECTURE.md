# Architecture

Authoritative product: **Tournament** (not PickleLive).

```text
Client (operator / umpire)
   ↓  user JWT
Authenticated API  (Edge Function `command` or packages/api)
   ↓  actor = JWT sub
Domain command + role check
   ↓
Tournament Engine (packages/engine)
   ↓
public.apply_official_writes(payload)
   ↓
PostgreSQL (Supabase project Tournament App)
```

## Layers

| Layer | Path | Role |
| --- | --- | --- |
| Engine | `packages/engine` | Pure domain: lifecycle, side-out scoring, brackets, Team Elimination |
| Contracts | `packages/contracts` | Command envelope, enums |
| API | `packages/api` + `supabase/functions/command` | JWT, authorize, persist |
| Operator | `apps/operator` | Organizer desktop |
| Umpire | `apps/umpire` | Match execution, mobile |
| Database | `supabase/migrations` | Schema, RLS, official writes |

Clients never receive `service_role`. Official writes are `SECURITY DEFINER` and `EXECUTE` is granted only to `service_role`.

PickleLive SPA in root `src/` is legacy. See `legacy/README.md`.

## Lifecycles

Tournament: `draft → registration → registration_closed → ready → in_progress → completed`. Cancel is legal from every live status except completed/archived. `completed|cancelled → archived`. Archived is terminal.

Match: `scheduled → ready` (court) or `scheduled → assigned` (umpire). Then `assigned → in_progress → completed`. Also `postponed`, `cancelled`, `abandoned`, and generated `bye` (terminal).

## Scoring

Event-sourced pickleball **side-out** (not Mix & Match rally). Each event has a client-generated UUID. Duplicate event ids are idempotent. Command receipts make whole commands idempotent.
