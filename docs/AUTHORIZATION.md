# Authorization

Deny by default. RLS is forced on every public table.

## Client (PostgREST)

Authenticated users may **SELECT** rows for tournaments they belong to (`tournament_members`). They may **UPDATE** only `profiles.display_name` for themselves. `platform_role` is trigger-protected.

No `INSERT`/`UPDATE`/`DELETE` on tournament domain tables for `anon` or `authenticated`.

## API

1. Validate JWT (`auth.getUser`).
2. Actor = `user.id`.
3. Load `tournament_members` for the target tournament.
4. Authorize the command (organizer vs assigned umpire).
5. Validate payload.
6. Run engine.
7. Persist via `apply_official_writes`.

Users cannot set `platform_role` to admin. Users cannot add themselves as organizer of someone else's tournament. Creating a tournament is the secure workflow that grants organizer on **that** tournament only. Umpires are added by an organizer via `add_member`.

## Service role

Exists only in:

- Supabase Edge Function secrets (`SUPABASE_SERVICE_ROLE_KEY` injected by the platform)
- Server-side `packages/api` environment (never `VITE_*`)
