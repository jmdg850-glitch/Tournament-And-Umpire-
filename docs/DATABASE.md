# Database

Project: **Tournament App** (`evuvgxruavnadpbiehgb`), region `ap-southeast-1`.

Not NextG. Not the previous Tournament project schema.

## Migrations

```text
supabase/migrations/
  0001_initial_schema.sql
  0002_auth_profiles.sql
  0003_official_writes.sql
  0004_rls.sql
```

Apply with Supabase MCP `apply_migration` or CLI `supabase db push` against this project only.

## Entities

`profiles` — one row per `auth.users`. `platform_role` is `user` or `admin`; clients cannot change it.

`tournaments` — owned by a profile. Status machine in the engine.

`tournament_members` — `organizer | admin | umpire | viewer`. Creating a tournament via API makes the actor organizer of **that** tournament. That is the designed organizer workflow, not a global self-promotion.

`divisions`, `persons`, `teams`, `team_members`, `participants`, `participant_members`, `courts`, `stages`

`matches` — engine match objects. Team Elimination parent rows are team matchups (`bracket_side = team_matchup`); pair matches set `parent_match_id` and `pair_slot`.

`match_participants` — slot A/B with `participant_id` and/or `team_id`.

`score_events` — id is the event UUID (primary key). Unique `(match_id, seq)`.

`match_results` — official completion snapshot.

`court_assignments`, `umpire_assignments`

`command_receipts` — idempotency by `command_id`.

`audit_logs`

## Official writes

`public.apply_official_writes(payload jsonb)` upserts/deletes whitelisted tables in one transaction.

`payload`:

```json
{
  "upserts": { "matches": [ { "id": "...", "...": "..." } ] },
  "deletes": { "table": [ "uuid" ] }
}
```

Restricted to `service_role`. Revoked from `anon` and `authenticated`.
